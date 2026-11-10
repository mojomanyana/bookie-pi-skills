import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { answerChoice, ChoiceRefused, readChoice } from "./choice-answer.js";
import type { ChoiceAccess } from "./dashboard-open-choices.js";
import { safeChoiceLine } from "./open-choice.js";

interface Selection {
  sessionId: string;
  cwd: string;
  sourceGeneration: string;
  access(): Promise<ChoiceAccess | undefined>;
  refresh(): Promise<unknown>;
}
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A separate host-only control, installed for one managed memory publisher. Ordinary tools never reach it. */
export function registerDashboardChoiceControls(
  pi: ExtensionAPI,
  selected: Selection,
): () => void {
  let live = false,
    disposed = false;
  let release: (() => void) | undefined;
  const access = async (assertDashboard: () => void) => {
    if (!live) return;
    assertDashboard();
    const original = await selected.access();
    if (!original || !live) return;
    const fence = () => {
      if (!live) throw Error("Choice owner changed");
      assertDashboard();
    };
    const scoped = {
      ...original,
      async assertCurrent() {
        fence();
        await original.assertCurrent();
        fence();
      },
    };
    await scoped.assertCurrent();
    return scoped;
  };
  try {
    pi.events?.emit?.("pi-daddy:bookie-choice-controls:v1", {
      version: 1,
      sessionId: selected.sessionId,
      cwd: selected.cwd,
      sourceGeneration: selected.sourceGeneration,
      async renew() {
        if (live) await selected.refresh();
      },
      async inspect(id: string, assertCurrent: () => void) {
        try {
          const scoped = await access(assertCurrent);
          if (!scoped) return;
          const detail = await readChoice(scoped, id);
          await scoped.assertCurrent();
          return detail;
        } catch {
          return undefined;
        }
      },
      async answer(
        id: string,
        revision: string,
        answer: unknown,
        assertCurrent: () => void,
      ) {
        if (!object(answer) || Object.keys(answer).length !== 1)
          return "refused";
        const selectedOption = Object.hasOwn(answer, "option");
        const text = selectedOption ? answer.option : answer.custom;
        if (!safeChoiceLine(text)) return "refused";
        let saving = false;
        try {
          const scoped = await access(assertCurrent);
          if (!scoped) return "refused";
          const detail = await readChoice(scoped, id);
          if (
            !detail ||
            detail.revision !== revision ||
            (selectedOption && !detail.options.includes(text))
          )
            return "refused";
          await scoped.assertCurrent();
          saving = true;
          await answerChoice(
            scoped,
            { id, revision, answer: text },
            selected.sessionId,
          );
        } catch (error) {
          return saving && !(error instanceof ChoiceRefused)
            ? "unconfirmed"
            : "refused";
        }
        // Publication is already durable. A failed optional redraw cannot undo the answer.
        try {
          await selected.refresh();
        } catch {
          /* optional display */
        }
        return "saved";
      },
      reply(value: unknown) {
        if (
          !object(value) ||
          value.version !== 1 ||
          value.ok !== true ||
          typeof value.close !== "function"
        )
          return;
        if (disposed || live) {
          value.close();
          return;
        }
        release = value.close as () => void;
        live = true;
      },
    });
  } catch {
    /* a host with display-only support continues to work */
  }
  return () => {
    if (disposed) return;
    disposed = true;
    live = false;
    try {
      release?.();
    } catch {
      /* optional host */
    }
  };
}
