import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
// Legacy behavior tests establish real human-command consent in their fixture, never private closure state.
export function modelContext(ctx) {
  return {
    ...ctx,
    model: ctx.model ?? {
      provider: "fixture",
      id: "subject",
      api: "fixture-api",
      baseUrl: "https://fixture.invalid/v1",
    },
    modelRegistry: ctx.modelRegistry ?? {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }),
    },
  };
}
export async function authorizeDisclosure(commands, vault, ctx) {
  const inputs = [vault, "/projects/fixture/project.md"];
  await commands.get("bookie-context").handler("", {
    ...modelContext(ctx),
    hasUI: true,
    isProjectTrusted: () => true,
    ui: {
      notify() {},
      confirm: async () => true,
      input: async () => inputs.shift(),
      select: async (_, choices) =>
        choices.includes("Done") ? "Done" : choices[0],
    },
  });
}

export async function labelFixture(vault) {
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name.endsWith(".md")) {
        const text = await readFile(path, "utf8");
        const m = /^---\n([^\n]+)\n---\n([\s\S]*)$/u.exec(text);
        if (!m) continue;
        let fm;
        try {
          fm = JSON.parse(m[1]);
        } catch {
          continue;
        }
        if (fm.bookie && !fm.bookie.sensitivity) {
          fm.bookie.sensitivity = "public";
          await writeFile(path, `---\n${JSON.stringify(fm)}\n---\n${m[2]}`);
        }
      }
    }
  }
  await visit(join(vault, "projects"));
}
