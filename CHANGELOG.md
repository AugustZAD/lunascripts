# Lunaverse Script contract changelog

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
