# Contract Versioning Policy

## Scope
- Public API contract: `shared-contracts/openapi.yaml`
- Internal service contracts: `shared-contracts/internal-contracts.md`

## Public API Versioning

- Version field uses SemVer in OpenAPI `info.version` (example: `0.1.0`).
- URL major version is `/api/v1`.
- Change policy:
  - Patch (`x.y.z`): docs-only clarifications, no behavior change.
  - Minor (`x.Y.z`): backward-compatible additions (new endpoints/optional fields).
  - Major (`X.y.z`): breaking changes (required fields, removed fields/endpoints, behavior changes).

## Internal Contract Versioning

- Internal contracts are versioned by document change history + deployment tags.
- Breaking internal changes require:
  - Updated `internal-contracts.md`
  - Dual-read/dual-write or phased rollout strategy
  - Consumer compatibility window during deployment

## Release and Compatibility Process

1. Update contract files in the same PR as implementation.
2. Mark breaking vs non-breaking in PR description.
3. For breaking public changes:
   - Introduce new version path (for example `/api/v2`) before deprecating old.
4. Keep at least one previously stable public major version available during migration.

## Deprecation Policy

- Deprecations must be documented in release notes.
- Deprecated endpoints/fields should remain for at least one release cycle before removal.
