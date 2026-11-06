# ADR-0014: License Bookie project code under MIT

## Status

Accepted by the repository owner on 2026-11-05. Resolves OQ-001.

## Context

Bookie has developed privately without selecting a project license. Preparing a
public core and Pi extension package requires an explicit owner decision and a
license notice in each distributed package. The owner selected MIT.

## Decision

License Bookie-authored code and accompanying documentation under MIT, using the
root LICENSE notice and identical notices in the core and Pi extension package
roots. Declare MIT in the workspace package metadata. Retain third-party licenses
and notices; this decision does not relicense Redis, Pi or other dependencies.

The first public-package preparation is limited to the canonical core and Pi
extension. The monorepo root, CLI and service remain private. Package names,
versions, namespace access, CI and exact archive qualification must be established
before publishing. This license decision does not authorize publication or mark
locally verified backlog work delivered.

## Consequences

- Consumers receive the MIT permission and warranty terms with the Bookie code.
- Redis, HTTP, provider and Pi runtime dependencies remain outside the core.
- The service's incomplete delivery and production gates remain unchanged.
- Upstream dependencies retain their own license and notice obligations.

## Alternatives considered

Apache-2.0, AGPL-3.0 and continued private-only distribution were considered in
OQ-001. The owner selected MIT for Bookie's project code.

## Revisit triggers

Review distribution requirements when adding bundled third-party code or changing
the packages included in a public release. Preserve existing third-party notices.
