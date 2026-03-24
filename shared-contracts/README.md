# Shared Contracts

This directory is the source of truth for API/service contracts.

## Files
- `openapi.yaml` : public API contract for external clients.
- `internal-contracts.md` : internal Node <-> Go service contract definitions.
- `CONTRACT_VERSIONING.md` : contract versioning and compatibility policy.

## Development Rules
- Contract changes must be committed with corresponding implementation changes.
- Public breaking changes require major API version strategy.
- Internal breaking changes require phased compatibility rollout.
