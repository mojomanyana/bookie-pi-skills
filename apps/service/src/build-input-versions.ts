import type { ProjectionVersions } from "./projection.js";

/** These labels describe this implementation; the measured artifact binds actual bytes. */
export const PROJECTION_VERSIONS: ProjectionVersions = Object.freeze({
  projectionSchemaVersion: "1",
  parserVersion: "bookie-1_yaml-2.9.0_mdast-2.0.3",
  chunkerVersion: "heading-utf8-1",
  preprocessingVersion: "markdown-trim-1",
});
export const CANONICAL_EXPORT_VERSION = "1.0";
export const SECRET_DETECTION_VERSION = "bookie-secret-1";
