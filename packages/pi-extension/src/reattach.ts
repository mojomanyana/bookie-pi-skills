import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  inspectConcept,
  inspectRecallScope,
  readRecallState,
  recallVault,
} from "pi-bookie-core";
import { allowsCanonical } from "./disclosure-authority.js";
import { dashboardOpenChoices } from "./dashboard-open-choices.js";
import {
  reattachMovedProject,
  surveyMovedProjects,
  type ExcludedProject,
  type MovedProject,
} from "./managed-vault.js";

const TERMINAL_ONLY =
  "Bookie re-attach needs the interactive Pi terminal so you can confirm it. It is unavailable in print, JSON and RPC modes. Nothing was changed.";
const UNTRUSTED =
  "Bookie re-attach needs a folder Pi trusts in this session. Nothing was changed.";
const HAS_MEMORY =
  "This folder already has Bookie project memory with saved content. Re-attaching would merge or replace it, so nothing was changed.";
const UNVERIFIABLE =
  "Bookie could not verify this folder's current private memory, so nothing was changed. Existing notes may still be present.";
const CANCELLED = "Bookie re-attach cancelled. Nothing was changed.";

// Folder names are untrusted text in a terminal dialog: quote them and make
// control and formatting characters visible.
const shown = (path: string) =>
  '"' +
  path.replace(/[\p{Cc}\p{Cf}"\\]/gu, (c) =>
    c === '"' || c === "\\"
      ? "\\" + c
      : "\\u{" + c.codePointAt(0)!.toString(16) + "}",
  ) +
  '"';
const why: Record<ExcludedProject["reason"], string> = {
  "still-exists": "still exists, so this folder is a copy or fork, not a move",
  "unknown-location": "could not be confirmed as gone",
  "git-mismatch":
    "recorded a Git commit that is not in this folder's current history",
};

// Terminal-only counts for the human; nothing here reaches the model.
async function contents(candidate: MovedProject) {
  try {
    const root = candidate.root;
    const project = await inspectConcept(
      root,
      { path: "/projects/workspace/project.md" },
      { maxContentBytes: 1 },
    );
    if (
      !project.ok ||
      project.type !== "Project" ||
      project.handling === "excluded"
    )
      return;
    const scoped = await inspectRecallScope(root, project.source);
    const controls = await readRecallState(root);
    if (!scoped.ok || !controls.ok) return;
    const scope = scoped.scope;
    const classes = ["internal", "public"].filter(
      (x) =>
        scope.sensitivityClasses.includes(x) &&
        !scope.excludedClasses.includes(x),
    );
    const allows = (value: unknown) =>
      allowsCanonical(scope, classes, controls, value);
    const notes = await recallVault(
      root,
      {
        mode: "recent",
        filters: {
          project: scope.project.path,
          type: "Activity",
          status: "stable",
        },
      },
      {
        maxResults: 1,
        maxTotalConceptBytes: 16 * 1024 * 1024,
        include: allows,
      },
    );
    const choices = await dashboardOpenChoices({
      root,
      scope,
      allows,
      assertCurrent: candidate.assertCurrent,
    });
    await candidate.assertCurrent();
    return {
      notes: notes.complete ? String(notes.matchedCount) : "unknown",
      latest: notes.results[0]?.recordedAt ?? "none",
      choices: (choices.limited ? "at least " : "") + choices.rows.length,
    };
  } catch {
    return;
  }
}

function evidence(candidate: MovedProject) {
  const lines = [];
  if (candidate.evidence.git)
    lines.push(
      "Git: the commit Bookie recorded there (" +
        candidate.recordedGit!.head.slice(0, 12) +
        ") is in this folder's current history.",
    );
  if (candidate.evidence.folder)
    lines.push(
      "Same folder: its device, inode and creation time match this folder.",
    );
  if (!lines.length)
    lines.push(
      "UNVERIFIED: Bookie recorded no Git commit for the earlier folder and this is a different folder. Continue only if you know it is the same project.",
    );
  return lines;
}

export function registerReattachCommand(
  pi: ExtensionAPI,
  managed: {
    forget(): void;
    refreshDashboard(ctx: ExtensionContext): Promise<boolean>;
  },
) {
  // Human-only: a command, never a tool, and never mentioned to the model.
  pi.registerCommand("bookie-reattach", {
    description:
      "Re-attach Bookie memory from a moved or renamed folder to this folder after you confirm it in the terminal.",
    async handler(args, ctx) {
      if (ctx.mode !== "tui" || !ctx.hasUI) throw Error(TERMINAL_ONLY);
      if (args.trim() !== "")
        throw Error("Use /bookie-reattach without arguments.");
      if (ctx.isProjectTrusted?.() !== true) throw Error(UNTRUSTED);
      const agent = getAgentDir();
      const survey = await surveyMovedProjects(ctx.cwd, agent);
      if (survey.current.state === "memory") throw Error(HAS_MEMORY);
      if (survey.current.state === "unverified") throw Error(UNVERIFIABLE);
      const notes = survey.excluded.map(
        (item) =>
          "Not offered: " + shown(item.previous) + " " + why[item.reason] + ".",
      );
      if (survey.unrecorded)
        notes.push(
          survey.unrecorded +
            " other project " +
            (survey.unrecorded === 1 ? "memory has" : "memories have") +
            " no recorded folder location (saved before Bookie recorded one) and cannot be matched. Their notes remain on disk.",
        );
      if (survey.limited)
        notes.push("Only the first 1000 stored project memories were checked.");
      if (!survey.candidates.length) {
        ctx.ui.notify(
          ["No moved Bookie project matches this folder.", ...notes].join("\n"),
          "info",
        );
        return;
      }
      if (notes.length) ctx.ui.notify(notes.join("\n"), "info");
      const described: Awaited<ReturnType<typeof contents>>[] = [];
      for (const candidate of survey.candidates)
        described.push(await contents(candidate));
      const options = survey.candidates.map((candidate, i) => {
        const counts = described[i];
        return (
          i +
          1 +
          ". " +
          shown(candidate.previous) +
          " -> " +
          shown(survey.workspace) +
          " | " +
          (candidate.evidence.git
            ? "Git history matches"
            : candidate.evidence.folder
              ? "same folder"
              : "UNVERIFIED") +
          " | " +
          (counts
            ? counts.notes + " notes, " + counts.choices + " open choices"
            : "contents unknown") +
          " | last opened " +
          candidate.lastOpened
        );
      });
      const choice = await ctx.ui.select(
        "Re-attach Bookie memory from a moved folder",
        options,
      );
      const index = choice === undefined ? -1 : options.indexOf(choice);
      if (index < 0) {
        ctx.ui.notify(CANCELLED, "info");
        return;
      }
      const chosen = survey.candidates[index]!,
        counts = described[index];
      const unverified = !chosen.evidence.git && !chosen.evidence.folder;
      const approved = await ctx.ui.confirm(
        unverified
          ? "Re-attach UNVERIFIED Bookie project memory?"
          : "Re-attach Bookie project memory?",
        [
          "Earlier folder (no longer exists): " + shown(chosen.previous),
          "This folder: " + shown(survey.workspace),
          ...evidence(chosen),
          counts
            ? "Saved notes: " +
              counts.notes +
              ". Open choices: " +
              counts.choices +
              ". Latest note: " +
              counts.latest +
              "."
            : "Saved notes and open choices could not be counted.",
          "Last opened there: " + chosen.lastOpened + ".",
          ...(survey.current.state === "empty"
            ? [
                "The empty memory Bookie created for this folder has no saved notes. It is set aside, not deleted.",
              ]
            : []),
          ...(survey.current.state === "interrupted"
            ? [
                "An earlier re-attach into this folder did not finish. It is rolled back first.",
              ]
            : []),
          "Afterwards the earlier folder no longer finds this memory. Re-attaching grants no model or save permission; Bookie's normal checks apply.",
        ].join("\n"),
      );
      if (approved !== true) {
        ctx.ui.notify(CANCELLED, "info");
        return;
      }
      const outcome = await reattachMovedProject(
        survey,
        chosen,
        async () => {
          if (ctx.isProjectTrusted?.() !== true) throw Error(UNTRUSTED);
        },
        agent,
      );
      managed.forget();
      ctx.ui.notify(
        [
          outcome.found
            ? "Bookie memory from " +
              shown(chosen.previous) +
              " is now attached to this folder."
            : "Bookie moved the memory binding but could not verify the result; run /bookie-reattach again to inspect.",
          ...(outcome.cleaned
            ? []
            : [
                "The earlier folder's old link could not be removed; it no longer resolves.",
              ]),
          ...(outcome.recorded
            ? []
            : ["The move could not be added to the location history."]),
          ...(outcome.setAsideChanged
            ? [
                "A note was saved to the set-aside empty memory during re-attach; it remains in " +
                  shown(outcome.setAside!) +
                  ".",
              ]
            : []),
        ].join("\n"),
        "info",
      );
      // Ordinary readiness: the Auto owner, trust and model destination checks run again.
      await managed.refreshDashboard(ctx).catch(() => false);
    },
  });
}
