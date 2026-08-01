# Lunaverse Script contract changelog

Every contract release declares `change_class` in `contract/contract.json`:

- `patch` changes no accepted source, emitted JSON, or runtime meaning;
- `minor` adds optional behavior that older consumers can safely ignore;
- `major` removes, renames, tightens, or changes existing behavior.

The rollout automation calculates a conservative lower bound from Schema and
behavior fixtures. A release whose declaration understates that bound is
rejected. Stored production content is always audited read-only; migration is
an explicit human repair workflow.

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

Migration: rename every stored author signal write and every matching condition
reader to the same uppercase name before activating content under contract v2.
