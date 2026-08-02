# Lunaverse Scripts authority and consumer preparation

- This repository is the only authority for LS syntax, compiler semantics, Episode JSON schemas, fixtures, contract versions, and compatibility notes. Consumer repositories must not invent or override language rules.
- A contract-impacting pull request must update the semantic contract version and changelog, then run `node scripts/contractctl.mjs rollout consumers prepare <upstream-pr-url>`. Existing Backend/IDE PRs may be adopted with `--backend-pr` and `--ide-pr`; duplicate consumer PRs are forbidden.
- Preparation pins the exact upstream candidate SHA, runs consumer tests and CI, verifies the complete local and paginated GitHub diff, and publishes the same preparation report on all three PRs.
- After a human merges the upstream PR into `main`, `rollout consumers sync` updates those same open consumer PRs to the exact canonical merge SHA. It must never create replacements during sync.
- Stored production content is strictly read-only. Audit findings and manual repair suggestions are displayed in full after sanitization and bound to all three exact PR heads. No repair is applied automatically.
- `contractctl` has no capability to merge a PR, release production, run production verification, recover a release, or sequence downstream integration. Those steps are human-operated outside this automation.
- The human sequence is: merge upstream; review the synchronized Backend PR; merge Backend; manually release and verify Backend; then merge IDE. Preparing or synchronizing PRs grants none of those permissions.
- Only normal fast-forward pushes to explicit `contract-rollout/` consumer branches are allowed. Force pushes, `main` pushes, tag pushes, unknown paths, deletes, renames, symlinks, submodules, divergent histories, incomplete pagination, and head races fail closed before remote metadata writes.
- See [`docs/contract-consumer-preparation.md`](docs/contract-consumer-preparation.md) for the design, evidence format, and operator commands.
