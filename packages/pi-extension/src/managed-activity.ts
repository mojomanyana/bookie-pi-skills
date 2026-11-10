import {
  CHECKPOINT_SECTIONS,
  prepareCheckpoint,
  type CheckpointSection,
  type ReadonlyYamlMapping,
} from "pi-bookie-core";
import { createCheckpointMetadata } from "./checkpoint-metadata.js";

export function prepareManagedActivity(
  root: string,
  input: {
    path: string;
    uid: string;
    project: string;
    title: string;
    tags?: string[];
    fields?: ReadonlyYamlMapping;
    sections: Partial<Record<CheckpointSection, string>>;
  },
  sessionId: string,
  signal?: AbortSignal,
) {
  const metadata = createCheckpointMetadata({ sessionId });
  return prepareCheckpoint(
    root,
    {
      path: input.path.slice(1),
      frontmatter: {
        type: "Activity",
        title: input.title,
        status: "stable",
        ...(input.tags ? { tags: input.tags } : {}),
        generated: metadata.generated,
        bookie: {
          ...input.fields,
          profile: "1.0",
          uid: input.uid,
          project: input.project,
          occurred_at: metadata.occurred_at,
          sensitivity: "internal",
        },
      },
      fragments: CHECKPOINT_SECTIONS.filter(
        (section) => section !== "source-session",
      ).map((section) => ({
        section,
        sensitivity: "internal",
        text: input.sections[section] ?? "No additional information recorded.",
      })),
    },
    signal ? { signal } : {},
  );
}
