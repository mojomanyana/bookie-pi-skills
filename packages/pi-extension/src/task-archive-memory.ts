import {
  archiveMemoryPath,
  containsDetectedSecret,
  inspectConcept,
  loadConcept,
  recallVault,
  type ArchiveMemory,
  type ArchiveMemoryRecord,
  type ArchiveNoteLink,
  type ArchiveScope,
} from "pi-bookie-core";
import { historyChoice, projectChoiceMetadata } from "./choice-answer.js";
import type { ChoiceAccess } from "./dashboard-open-choices.js";

type Source = { path: string; sourceHash: string };
type Visible = { ref: Source; tasks: Set<string> };

export function archivedNoteAllowed(
  access: ChoiceAccess,
  note: ArchiveMemoryRecord,
) {
  const loaded = loadConcept(Buffer.from(note.sourceText), {
    file: note.path,
    maxBytes: 32768,
  });
  const meta = loaded.ok ? loaded.concept.frontmatter.bookie : undefined;
  if (
    !meta ||
    typeof meta !== "object" ||
    Array.isArray(meta) ||
    !("uid" in meta) ||
    !("sensitivity" in meta)
  )
    return false;
  return access.allows({
    uid: meta.uid,
    project: "project" in meta ? meta.project : null,
    source: { path: note.path },
    sensitivity: { classification: "declared", value: meta.sensitivity },
  });
}

/** An operator has requested a local archive. The disclosure ticket and every
 * source revision are checked again before the caller can publish the file. */
export async function readArchiveMemory(
  access: ChoiceAccess,
  scope: ArchiveScope,
  links: ArchiveNoteLink[],
) {
  await access.assertCurrent();
  const requests = new Map<string, Visible>(),
    captured = new Map<string, ArchiveMemoryRecord>();
  let limited = false,
    size = 0;
  function request(ref: Source, members: Iterable<string>) {
    if (
      !archiveMemoryPath(ref.path) ||
      !/^sha256:[a-f0-9]{64}$/u.test(ref.sourceHash)
    ) {
      limited = true;
      return;
    }
    const key = ref.path + "#" + ref.sourceHash;
    const existing = requests.get(key);
    if (existing) {
      for (const member of members) existing.tasks.add(member);
      return;
    }
    if (requests.size >= 1024)
      throw Error("Memory archive exceeds its record limit.");
    requests.set(key, { ref, tasks: new Set(members) });
  }
  for (const link of links) request(link, [link.taskId]);
  if (scope === "project") {
    const scan = await recallVault(
      access.root,
      { mode: "recent" },
      {
        maxResults: 1,
        maxExcerptBytes: 32,
        maxTotalTextBytes: 256,
        maxTotalConceptBytes: 16 * 1024 * 1024,
        include(record) {
          if (!access.allows(record)) return false;
          request(record.source, []);
          return true;
        },
      },
    );
    // include receives every matching source before the bounded display result.
    if (!scan.complete) limited = true;
  }
  async function capture(source: Visible, credit: Iterable<string>) {
    const current = captured.get(source.ref.path);
    if (current && current.sourceHash === source.ref.sourceHash) {
      current.tasks = [...new Set([...current.tasks, ...credit])].sort();
      return;
    }
    await access.assertCurrent();
    const note = await inspectConcept(
      access.root,
      { path: source.ref.path },
      { maxContentBytes: 32768, maxTotalConceptBytes: 16 * 1024 * 1024 },
    );
    if (
      !note.ok ||
      note.handling !== "ordinary" ||
      note.sourceTruncated ||
      note.source.sourceHash !== source.ref.sourceHash ||
      !access.allows(note) ||
      containsDetectedSecret(note.sourceText)
    ) {
      limited = true;
      return;
    }
    const choice = historyChoice(access, { ...note });
    if (choice) {
      // An answer or a classification belongs to this task only through its
      // exact authorized question revision. Closed choices keep both records.
      try {
        const meta = await projectChoiceMetadata(access, choice);
        if (choice.kind === "note") {
          if (meta.choiceResolution)
            request(meta.choiceResolution.source, credit);
          if (meta.choiceDisposition)
            request(meta.choiceDisposition.source, credit);
        }
      } catch {
        if (choice.kind !== "note") {
          limited = true;
          return;
        }
        limited = true;
      }
    }
    size += Buffer.byteLength(note.sourceText);
    if (size > 8 * 1024 * 1024)
      throw Error("Memory archive exceeds its byte limit.");
    captured.set(source.ref.path, {
      path: source.ref.path,
      sourceHash: source.ref.sourceHash,
      sourceText: note.sourceText,
      tasks: [...credit].sort(),
    });
  }
  for (const source of requests.values()) await capture(source, source.tasks);
  // A project scan can enumerate a receipt before its question. Copy any task
  // association subsequently established by validating the question revision.
  for (const source of requests.values()) {
    const item = captured.get(source.ref.path);
    if (item?.sourceHash === source.ref.sourceHash)
      item.tasks = [...new Set([...item.tasks, ...source.tasks])].sort();
  }
  const records = [...captured.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const assertCurrent = async () => {
    await access.assertCurrent();
    if (!records.length) return;
    const remaining = new Map(records.map((r) => [r.path, r.sourceHash]));
    const scan = await recallVault(
      access.root,
      { mode: "recent" },
      {
        maxResults: 1,
        maxExcerptBytes: 32,
        maxTotalTextBytes: 256,
        maxTotalConceptBytes: 16 * 1024 * 1024,
        include(record) {
          if (
            access.allows(record) &&
            remaining.get(record.source.path) === record.source.sourceHash
          )
            remaining.delete(record.source.path);
          return false;
        },
      },
    );
    if (!scan.complete || remaining.size)
      throw Error("Memory access or source revisions changed during export.");
    await access.assertCurrent();
  };
  await assertCurrent();
  return {
    memory: { records, limited } satisfies ArchiveMemory,
    assertCurrent,
  };
}
