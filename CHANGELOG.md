# Lunaverse Script contract changelog

Every contract release declares `change_class` in `contract/contract.json`:

- `patch` changes no accepted source, emitted JSON, or runtime meaning;
- `minor` adds optional behavior that older consumers can safely ignore;
- `major` removes, renames, tightens, or changes existing behavior.

Consumer preparation calculates a conservative lower bound from Schema and
behavior fixtures. A release whose declaration understates that bound is
rejected. Stored production content is always audited read-only; repairs and
all integration or production actions remain explicit human workflows.

## 2.1.0

Backward-compatible authoring contract:

- Canonical three-field character look IDs now validate that their leading
  owner equals the staged character, case-insensitively.
- Legacy opaque look IDs and existing four-field stateful look IDs remain
  accepted and are emitted unchanged.
- Standalone unary `!` remains illegal in every condition position; no unary
  AST form is introduced.
- The comparison operator `!=` remains legal and continues to emit as `!=`.
- Compiled Episode JSON now includes `ls_contract_version: "2.1.0"`.

Migration: none. Existing content remains valid; producer tooling may adopt the
canonical look form for new content independently.

## 2.0.0

Breaking authoring contract:

- Every author-defined `@signal mark` event and `@signal int` name now uses
  `SCREAMING_SNAKE_CASE` and matches `^[A-Z][A-Z0-9_]*$`.
- Lowercase names remain reserved for runtime-declared, read-only engine values
  such as `san`; the compiler does not rewrite identifiers implicitly.
- Compiled Episode JSON includes `ls_contract_version: "2.0.0"`.
- `contract/episode.schema.json` and `contract/fixtures/` are the machine-readable
  consumer contract. IDE and Backend must pin an exact upstream commit and may
  not add LS-language restrictions locally.
- Preparation automation creates or updates only Backend/IDE pull requests,
  verifies their full diff and CI, and reports sanitized read-only audit findings.
  After this PR is merged, the same consumer PRs are synchronized to its exact
  canonical merge SHA. Every later integration and production step is manual.

Migration: rename every stored author signal write and every matching condition
reader to the same uppercase name before activating content under contract v2.
