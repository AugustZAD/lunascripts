# LS Directive Quick Reference

> Authoritative spec: `LS-SPEC.md`. JSON shape: `docs/JSON-OUTPUT.md`. Engine contract: `docs/ENGINE-INTEGRATION.md`. This page is a cheat sheet, not a substitute.

## Structure Control

| Directive | Example |
|-----------|---------|
| `@episode <branch_key>:<seq> "<title>" { }` | `@episode main:01 "Butterfly" { }` — root block; branch_key must match the path-derived value |
| `@gate { }` | Terminal block — **every episode has exactly one**. Leaves are `@next` and/or `@end` (see Gate Leaves below) |
| `@if (<cond>) { } [@else if/@else]` | Conditional branching — `@if (affection.easton >= 5) { ... } @else if (FLAG) { ... } @else { ... }`. Parens required around `<cond>`. Inside a gate, the body is a single leaf (`@next` / `@end`); in body scope, blocks may hold any steps. |
| `@choice { @option ... }` | Player choice menu; body holds 2+ `@option` blocks |
| `@option <ID> <safe\|brave> "<text>" { }` | Single option. `ID` is `A` / `B` / `C`…; mode `safe` runs body straight, `brave` body must contain a `check` block and use `@if (check.success) { } @else { }` for outcome branching |
| `@pause` | Click-wait. **No arguments** — for longer beats, write multiple `@pause` lines in sequence |

**Removed in this revision:** `@ending` (top-level), `@label`, `@goto`, `@pause for N`. Replacement: terminal state moves into `@gate { @end <type> }`; flow control uses `@if`/`@else` only (no jump-by-label).

## Visual

| Directive | Example |
|-----------|---------|
| `@bg set <name> [transition]` | `@bg set school_hallway fade` — set background |
| `@<char> <pose> [transition]` | `@mauricio neutral_smirk` / `@malia worried dissolve` — show character or change pose. **Implicitly hides the previously displayed character** (one-on-screen rule) |
| `@<char> bubble <type>` | `@josie bubble heart` — emotion bubble over the current speaker |
| `@cg <name> "<content>"` | `@cg window_stare "The camera opens on Malia's silhouette…"` — **leaf** directive, no `{ }` body. `<content>` is a continuous English prose paragraph consumed by the video-generation pipeline |

**Positions:** none. The engine derives placement from `gamestate.MC`: the MC is rendered left, every other character right. At most one character is on screen at a time — switching speakers replaces the previous portrait. `NARRATOR` and `YOU` lines clear the stage.

**Transitions:** (none) = dissolve · `fade` · `cut` · `slow`. Applies to `@bg set` and the optional slot on `@<char> <pose>`.

**Bubble types (9, fixed list):** `anger` · `sweat` · `heart` · `question` · `exclaim` · `idea` · `music` · `doom` · `ellipsis`. `bubble` is a reserved word — no pose may be named `bubble`.

**Removed in this revision:** `@<char> show <look> at <pos>`, `@<char> hide`, `@<char> look <look>`, `@<char> move to <pos>`. There is no `position` parameter anywhere; the position list (`left` / `right` / `center`) is gone. CG `{ duration / content / body }` blocks are also removed — CG is now a single-line leaf.

## Dialogue

| Format | Example |
|--------|---------|
| `CHARACTER: text` | `MAURICIO: Hey, Butterfly.` |
| `NARRATOR: text` | `NARRATOR: Senior year. Day one.` — clears stage |
| `YOU: text` | `YOU: He hasn't called me that in eight years.` — MC inner monologue; clears stage |
| `CHARACTER [pose]: text` | `MAURICIO [arms_crossed_angry]: Your call, Butterfly.` — sugar for `@mauricio arms_crossed_angry` + dialogue |

JSON normalizes `character` to lowercase (`MAURICIO:` → `"mauricio"`).

## Audio

| Directive | Example |
|-----------|---------|
| `@music <name>` | `@music calm_morning` — set BGM. Engine picks from-silence vs crossfade automatically based on current state |
| `@music stop` | Stop BGM (engine applies fadeout) |
| `@sfx <name>` | `@sfx door_slam` — one-shot sound effect |

**Removed in this revision:** `@music play`, `@music crossfade`, `@music fadeout`, `@sfx play`. The four-form audio surface collapses to the three above — engine owns the silence/crossfade decision.

## Phone

| Directive | Example |
|-----------|---------|
| `@phone {`<br>`  @text from/to <CHAR>: <text>`<br>`}` | Multiline phone block. Phone messages are silent UI text and never request voice audio. **No `@phone show` / `@phone hide`** — the block delimits the entire overlay lifetime |
| `@text from <CHAR>: text` | `@text from EASTON: I miss you.` — incoming (grey, left) |
| `@text to <CHAR>: text` | `@text to MAURICIO: Leave me alone.` — outgoing (blue, right) |

Whitelist: **only `@text from/to` is allowed inside a multiline `@phone { }` block.** The opening brace, messages, and closing brace cannot share one line. Phone messages are silent UI text. No dialogue, no `@sfx`, no `@affection`, no `@signal`, nothing else. Push state changes or audio outside the block.

## Interaction

| Directive | Example |
|-----------|---------|
| `@trick <type> "<prompt>"` | `@trick hold "Hold your breath until he walks past."` — mandatory body-interaction beat; **leaf**. `<type>` ∈ `tap` / `hold` / `swipe` / `shake` / `swing` / `tilt` (touch + motion only, hard-locked). Thresholds live in the engine — scripts do not tune them |
| `@minigame <name> "<description>"` | `@minigame casino_showdown "Mauricio drags Malia into a backroom blackjack game…"` — optional embedded H5; **leaf**. `<description>` is one prose paragraph that both scenes the moment AND defines simple gameplay. Skippable = whole step is a no-op. Rewards live in the engine (anti-cheat); no rating branches |
| `check <attr> <DC>` | `check { attr: CHA  dc: 12 }` — required inside a `brave` option body. Engine runs `D20 + <attr> modifier >= dc → success` and exposes the result via `check.success` / `check.fail` inside that option only |

Brave-option outcome branching: `@if (check.success) { } @else { }`. The `@else` branch is optional — omitting it means "nothing happens on fail" (valid by design). `@trick` and `@minigame` are not D20-bound and do not produce branch state — if you need a story split off an action, use `@choice`.

## State

| Directive | Example |
|-----------|---------|
| `@affection <char> <±N>` | `@affection easton +2` / `@affection mauricio -1` — adjust per-character affection (persistent across episodes) |
| `@signal mark <NAME>` | `@signal mark HIGH_HEEL_EP05` — persistent boolean flag. Use sparingly; every mark must have a later reader (an `@if` branch or an achievement guard) |
| `@signal int <NAME> <=\|+\|-> <N>` | `@signal int REJECTIONS +1` / `@signal int REJECTIONS -2` / `@signal int REJECTIONS = 0` — persistent integer counter. Every author signal name matches `^[A-Z][A-Z0-9_]*$`; `+N` / `-N` require N >= 0; `= N` may be negative. First read defaults to 0 |
| `@butterfly "<description>"` | `@butterfly "Accepted Easton's approach openly"` — content-generator hint. **Does NOT participate in gate routing** — only feeds Remix Executor / Dream so generators understand the player's personality |
| `@achievement <id> { name / rarity / description }` | Inline achievement. The block carries metadata; reaching the node fires the unlock. Wrap in `@if (...)` for conditional triggers. `rarity` ∈ `uncommon` / `rare` / `epic` / `legendary` (no `common`); all three fields are required; bare `@achievement <id>` without a block is a parse error |

Engine-managed numerics (e.g. `san`, `cha`, `hp`, `xp`) are read-only to scripts — you may reference them inside `@if`, but cannot mutate them. Author-defined integers share the bare-name read namespace but use `SCREAMING_SNAKE_CASE`, while runtime-declared engine names retain their own casing.

## Conditions (5 kinds)

All conditions parse into structured AST — there are no raw expression strings in the JSON. Operators: `==` `!=` `>` `<` `>=` `<=`. Logic: `&&` (binds tighter) and `||`. Parens for grouping.

| Kind | Source syntax | Scope |
|------|--------------|-------|
| choice | `<ID>.<success\|fail\|any>` — e.g. `A.fail`, `B.success`, `C.any` | Anywhere (historical lookup of past option outcomes) |
| flag | `<MARK_NAME>` — bare identifier matching a `@signal mark` name | Anywhere |
| comparison | `<operand> <op> <operand>` — both sides are operands, so variable-vs-variable is legal | Anywhere |
| compound | `<cond> && <cond>` / `<cond> \|\| <cond>` — nests recursively, parens for grouping | Anywhere |
| check | `check.success` / `check.fail` | **Brave option body only** — refers to the just-rolled D20 result for that option |

**Removed in this revision:** the `influence` condition kind. There is no `"description"` literal or `influence "description"` form anymore — narrative coloring is captured via `@butterfly` (for content generators) and concrete state via `@signal mark` / `@signal int`.

## Operands (5 kinds, comparison only)

Both sides of a comparison are operands. Operands are integer-typed; the validator rejects mixed types.

| Kind | Source syntax | AST |
|------|--------------|-----|
| literal | `5` / `-3` | `{kind:"literal", value:N}` |
| affection | `affection.<char>` | `{kind:"affection", char:"easton"}` |
| value | `<bare_name>` | `{kind:"value", name:"san"}` — engine numeric (`san`, `cha`, `hp`, `xp`, …) **or** an author `@signal int` variable; both share the same bare-name lookup namespace |
| max | `MAX(<op>, <op>, ...)` | `{kind:"max", args:[...]}` — **args >= 2** (1-arg MAX is a parse error). Args may be any operand kind, including nested `MAX` / `MIN` |
| min | `MIN(<op>, <op>, ...)` | `{kind:"min", args:[...]}` — same rules as MAX |

`MAX` and `MIN` are **reserved words** — they are not valid signal names. Lowercase `max` / `min` may only be runtime-declared engine value names; they do not satisfy the author-signal contract.

Examples:
- `@if (affection.easton > affection.diego): @next main/route/easton:01` — variable-vs-variable
- `@if (MAX(affection.easton, affection.diego, affection.elias) >= 5) { ... }` — N-way aggregate
- `@if (affection.easton > MAX(affection.diego, affection.mauricio)) { ... }` — operand vs aggregate
- `@if (5 < affection.easton) { ... }` — literal-first form is fine

## Gate Leaves

`@gate { }` contents are `@if` / `@else if` / `@else` chains whose innermost bodies are **leaves**. `@next` and `@end` leaves can mix freely within the same gate.

| Leaf | Example |
|------|---------|
| `@next <branch_key>:<seq>` | `@next main:02` / `@next main/bad/001:01` — route to the addressed episode |
| `@end <type>` | `@end complete` — terminal. `<type>` ∈ `complete` (full run finished) / `to_be_continued` (chapter end, sequel pending) / `bad_ending` (bad route terminus) |

Minimal forms (no conditionals):
```
@gate { @next main:02 }
@gate { @end bad_ending }
```

Mixed conditional form (next / end side-by-side):
```
@gate {
  @if (REJECTIONS >= 3) { @end bad_ending }
  @else if (HEROIC_END) { @end complete }
  @else { @next main:02 }
}
```

Coverage rule: a gate is valid only when every execution path produces exactly one leaf — i.e. either a single unconditional `@next`/`@end`, or an `@if`/`@else if`/`@else` chain whose final clause is `@else`. Missing fallback → `MISSING_TERMINAL`.

## Step ID Tags

Each compiled step gets an `id` of the form `<seq>_<tag>` (frozen contract, see JSON-OUTPUT.md §4.0). The tags directives compile to:

| Directive | Step type(s) | Tag |
|-----------|--------------|-----|
| `@<char> <pose>` | `char_show` | `char` |
| `@<char> bubble <type>` | `bubble` | `char` (shared with char_show) |
| `@music <name>` | `music` | `mus` |
| `@music stop` | `music_stop` | `mus` (shared) |

Other step types have their own tags — these two collisions are the load-bearing ones to remember when reading IDs.

## Concurrency

| Prefix | Meaning | Notes |
|--------|---------|-------|
| `@` | Sequential — opens a new step group | Leader |
| `&` | Concurrent — joins the previous `@` group | Follower; first line of a group cannot be `&` |
| (none) | Dialogue line | Always independent — waits for player click |

`&` is **not** allowed on block-structure directives: `@choice`, `@phone`, `@if`, `@gate`, `@episode`. Leaves (`@trick`, `@minigame`, `@cg`) technically permit `&`, but bundling them with scene setup hides the beat — keep them on `@`.

Typical concurrent group:
```
@bg set school_hallway fade
&music tense_strings
&mauricio neutral_smirk
```
Three side effects (background swap + music swap + character entry) play together; the next dialogue line then runs in isolation.

## Reserved Words

These identifiers are unavailable as signal mark names, signal int names, or pose names:

- Directive verbs: `set`, `bubble`, `from`, `to`, `stop`
- Flow keywords: `if`, `else`, `next`, `end`, `gate`, `episode`, `choice`, `option`, `check`, `pause`
- Option modes: `brave`, `safe`
- Ending types: `complete`, `to_be_continued`, `bad_ending`
- Aggregate functions: `MAX`, `MIN` (uppercase only; lowercase variants are not valid author signal names)
- Check namespace: `check`
- D20 result tokens: `success`, `fail`, `any`

The validator owns the canonical list — defer to it on edge cases.
