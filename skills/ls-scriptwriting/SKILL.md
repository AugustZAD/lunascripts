---
name: ls-scriptwriting
description: >
  How to write correct Lunascripts (LS) for MobAI interactive visual novels.
  Use this skill whenever generating, editing, or reviewing .ls script files for
  the MobAI game engine — including Dramatizer output, Remix Executor output,
  or manual script authoring. Triggers on: LS scripts, episode scripts,
  visual novel scripts, game scripts, Dramatizer output formatting,
  Remix script generation, "@episode", "@choice", "@gate", or any mention
  of the MobAI script format.
---

# Writing Lunascriptss

You are generating scripts for a mobile interactive visual novel player. The genre is **TRPG mechanics + Galgame presentation**: players read through dialogue-driven scenes with character sprites and backgrounds (Galgame), and at key beats make choices that resolve via D20 attribute checks against a difficulty class (TRPG). Body-interaction beats (`@trick`) and optional embedded games (`@minigame`) punctuate the reading. Each `.ls` script file is one episode — a self-contained narrative unit with dialogue, visual staging, game mechanics, and routing to the next episode.

The player experiences this as: tap to read dialogue → see one character at a time on screen (MC pinned left, others pinned right by the engine) → occasionally complete a forced body action (tap / hold / swipe / shake / swing / tilt) → occasionally skip-or-play a downstream-generated mini-game → at key beats make a choice that may roll dice → episode ends and routes to the next one.

Your scripts will be parsed by a Go interpreter that outputs JSON for the frontend. The interpreter is strict — syntax errors break the build. This guide teaches you to write scripts the interpreter accepts and the player renders well.

## File Basics

- Extension: `.ls`
- Encoding: UTF-8
- Comments: `//` at line start
- Strings: double quotes `"..."`
- Blocks: `{ }` for nesting, indent for readability
- Every file has exactly one `@episode` root block

## Episode Structure

Every script follows this skeleton:

```
@episode <branch_key> "<title>" {

  // Narrative content (scenes, dialogue, choices, mini-games)
  // ...

  // Terminal — MUST be last. Exactly one @gate block.

  @gate {
    @if (<condition>): @next <target>
    @else @if (<condition>): @end <type>
    @else: @next <fallback>
  }
}
```

**Every episode ends with exactly one `@gate { ... }` block.** No `@gate` = `MISSING_TERMINAL` validator error.

`@gate` leaves are either `@next <branch_key>` (route to another episode) or `@end <type>` (terminate the story). A single gate may mix both — see "Routing (Gate)" below for the full pattern. The minimal forms are:

```
@gate { @next main:02 }            // pure unconditional route
@gate { @end bad_ending }          // pure terminal episode
```

The `branch_key` follows a strict addressing format. Read `references/addressing.md` for the full scheme.

## The Three Syntaxes in One File

LS has three syntaxes that alternate freely:

**1. Directive lines** start with `@` — these control visuals, audio, game mechanics, and flow. Each `@` starts a new sequential step:
```
@bg set school_hallway fade
@mauricio neutral_smirk
@music tense_strings
```

**2. Concurrent directives** start with `&` — these execute simultaneously with the preceding `@` directive. Use `&` to group actions that should happen at the same time (e.g. scene setup):
```
@bg set school_hallway fade          // @ starts a new step group
&music tense_strings                 // & concurrent with bg
&mauricio neutral_smirk              // & concurrent with bg
```

**3. Dialogue lines** start with a CHARACTER NAME in caps followed by colon — these are what the player reads:
```
MAURICIO: Hey, Butterfly.
NARRATOR: Senior year. Day one.
YOU: He hasn't called me that in eight years.
```

Three special names: `NARRATOR` (third-person scene narration), `YOU` (MC's inner monologue), and any other name (character dialogue). Character names in dialogue are case-insensitive with their `@` directive counterparts — `MAURICIO:` in dialogue = `@mauricio` in directives.

**Syntax sugar — pose change + dialogue in one line:**
```
CHARACTER [pose]: text
```
This is shorthand for `@character pose` followed by `CHARACTER: text`. Use it to keep the script tight when a character's pose changes right before they speak:
```
MAURICIO [arms_crossed_angry]: Your call, Butterfly.
```

## Authoring Discipline — LLM Anti-Patterns

Read this before writing. LLMs reliably fall into specific traps that pass the parser but bloat the episode or break narrative flow. Self-correct against these as you write — the validator can't catch most of them.

1. **Don't mint a sprite library.** Aim for **~3–6 distinct poses per character per episode**, and **reuse aggressively**. Every new pose name has an upstream cost (semantic name → mapping JSON → OSS asset). If two beats both want "happy", reuse `gentle_smile` instead of minting `gentle_smile_morning_light_v2`. The character does not need fifty micro-expressions.
2. **Don't carpet-bomb music and SFX.** One BGM at scene start, with later `@music <new_name>` lines on major mood shifts, is usually enough — typically **≤3 distinct music tracks per episode**. Don't restart a track if the current one still fits. SFX should punctuate beats (a slap, a phone notification), **not** narrate ambient sound the player can imagine.
3. **Do change backgrounds when the location does.** The opposite failure: LLMs sometimes run two scenes off the same backdrop. If you wrote a scene-cut in your head (cafeteria → rooftop), that's two `@bg set ...` calls — backgrounds anchor the player's spatial sense.
4. **`@butterfly` feeds downstream content generators, not gate routing.** Butterfly's *only* consumers are downstream content-generation agents — **Remix Executor** (regenerating remix branches consistent with the player's pattern) and **Dream** (generating dream-sequence inserts). Gate evaluation does **not** read butterfly accumulation; all routing relies on deterministic state (`@signal mark`, `@signal int`, `@affection`, choice history). When you *do* want a beat to count toward future remix / dream generation, butterfly is the tool — write a specific description of what *this* player did that another player wouldn't have. Bad: "Made a choice." Good: "Showed vulnerability by accepting help from a former rival." For intra-episode story-flag branching use `@signal mark`; for repeat-event counters use `@signal int COUNTER +1`.
5. **Don't write essay-length option text.** Choice option text is the player's UI button label — keep it under **~12 words**. Long narrative belongs *inside* the option block, not in the option text. Bad: `@option A brave "Stand your ground and tell him exactly how you feel about everything that happened last summer when he lied" { ... }`. Good: `@option A brave "Stand your ground." { ... }`.
6. **Don't compress when you should breathe.** LLMs default to terse summarization; Galgame pacing is the opposite. Let scenes land — an `@pause` after scene setup, an internal `YOU:` line between two pieces of dialogue, an extra silent beat after a confession. Token pressure pushes you toward "compress"; resist it. Players paid to live the moments, not skim a plot summary.
7. **Don't write side branches with no entry, or gate routes with no destination.** Every side episode (`main/route/...`, `main/bad/...`) you imagine needs a `@gate` somewhere upstream that routes into it via `@next`. Conversely, every `@next <branch_key>` in a `@gate` must point at an episode file you actually wrote. A beautiful unreachable bad-end is dead content; a `@next main/route/001:01` with no file is a broken link.
8. **Respect the concurrency rules.** `&` follows `@` and runs *together* with the previous step — it's for scene-setup bundles (bg + music + character entrance). `&` cannot lead a sequence, cannot be used on block structures (`choice`, `phone`, `if`, `gate`), and cannot be used on dialogue (`CHARACTER:` lines are always their own sequential step). `@trick`, `@minigame`, and `@cg` are leaf directives, so `&` is technically permitted on them, but you almost never want one of those bundled into a scene-setup group — keep them on `@` for narrative clarity. When in doubt, use `@`.
9. **Run the fixer before compiling.** The interpreter ships `lsc fix <file>` that auto-repairs common LLM mistakes (missing `@if` parens, `&` on blocks, character-name casing in `@affection`, BOM/CRLF, unclosed blocks). **If the script was LLM-generated, run `lsc fix` first, then `lsc validate`, then `lsc compile`.** This is the single highest-ROI habit when iterating with LLMs.

The directive table (`references/directive-table.md`) is the authoritative quick reference — when unsure of syntax, check it instead of inventing.

## Visual Directives

All visual directives use **object-action** order: `@<object> <action> [params]`.

**Scene setup** — use `&` to group the background, music, and character entrance that happen together at the start of a scene:

```
@bg set school_front fade
&music upbeat_school
&malia neutral_flat
```

### Characters

```
@mauricio neutral_smirk              // Enter / switch to pose (instant)
@mauricio arms_crossed_angry dissolve // Switch pose (crossfade)
@mauricio neutral_smirk fade         // Switch pose (fade in)
@mauricio bubble heart               // Emotion bubble (one-shot, auto-disappears)
```

Just two forms:

- **`@<char> <pose> [transition]`** — first appearance enters the character; subsequent uses switch their pose. Position is fixed by the engine (MC pinned left, others pinned right) — the script never specifies left/right/center. **Only one character is on screen at a time.** Whichever character speaks or is directed last replaces the previous one; `NARRATOR:` / `YOU:` clear the stage.
- **`@<char> bubble <type>`** — a one-shot bubble animation over the current character. Auto-disappears.

**`bubble` is a reserved word** — it cannot be a pose name. `@malia bubble` always parses as "play a bubble", never as "switch to a pose called bubble".

**Pose names** are semantic — they map to asset files via the interpreter. Use `snake_case`: `neutral_smirk`, `arms_crossed_angry`, `vulnerable_hopeful`. You can use any descriptive snake_case name, but **reuse aggressively** — target ~3–6 distinct poses per character per episode and reuse them across beats. Every new pose name carries a mapping-JSON + OSS asset cost.

**Bubble types (9, locked):** `anger` `sweat` `heart` `question` `exclaim` `idea` `music` `doom` `ellipsis`. The `<type>` argument is **required**.

**Transitions:** unset = instant; `dissolve` = 0.3s crossfade; `fade` = fade in. (Bg has its own transition set — see below.)

### Backgrounds

```
@bg set malias_bedroom_morning            // Default dissolve (0.5s)
@bg set school_front fade                 // Black screen transition (1s)
@bg set school_hallway cut                // Instant cut
@bg set dream_sequence slow               // Slow fade (2s, for mood)
```

### CG (Full-screen illustrations)

CG replaces the entire screen and is rendered by downstream agent-forge as a short video. **`@cg <name> "<content>"` is a leaf directive** — one line, no `{ }` body, no duration, no transition. The interpreter passes `<content>` to the video pipeline; agent-forge decides timing and camera based on the prose.

```
@cg window_stare "The camera opens on Malia's silhouette against the rain-streaked window. Slow push-in on her eyes — one tear tracks down, catching the cold blue of the skyline. Her reflection doubles her, ghost-like, in the glass."
```

- `<name>` is the asset handle. After agent-forge finishes generating, the URL is filled into `assets.cg.<name>`.
- `<content>` is a single English paragraph: concrete description of camera + story beat. No purple prose — what happens, what the camera does, what the frame emphasises.

CG carries **no embedded dialogue**. If a beat needs voiceover or inner monologue around the CG, write the dialogue lines **before** the `@cg` directive (the lead-up) and **after** it (the aftermath). The engine restores the previous background and any character afterwards automatically.

```
YOU: The city lights blurred through my tears.
@cg window_stare "The camera opens on Malia's silhouette against the rain-streaked window. Slow push-in on her eyes — one tear tracks down, catching the cold blue of the skyline."
NARRATOR: She stood there for what felt like hours.
```

`@cg` is symmetric with `@minigame`: both are leaf directives of the form `@<primitive> <name> "<prose>"` whose content prose is consumed by a downstream generation agent.

## Concurrency (@ vs &)

**`@`** = sequential. Each `@` directive starts a new step that executes after the previous one completes.

**`&`** = concurrent. A `&` directive joins the previous `@` directive's step group — they execute simultaneously.

**Dialogue** = always standalone. Each dialogue line is its own step that waits for the player to tap.

### Rules

- `&` CANNOT be used on block structures: `choice`, `phone`, `if`, `gate`, `episode`. These always use `@`.
- `&` is technically permitted on `@trick`, `@minigame`, and `@cg` (they are leaf directives), but bundling them into a scene-setup group is almost never what you want — keep them on `@` so the player notices the beat.
- A `&` line must follow an `@` line or another `&` line — it cannot appear at the start of a sequence with no preceding `@`.

### When to use `&`

- **Scene setup**: bg + music + the entering character should fire together:
  ```
  @bg set school_cafeteria fade
  &music casual_lunch
  &mark grin_confident
  ```
- **State changes that happen together**: multiple stat changes after a single event.

### When to use `@`

- **Standalone actions**: anything that needs to visually complete before the next step.
- **Anything that needs to complete before the next step**: a background change that sets the mood before the character appears.

### `@pause`

Wait for one player click before advancing to the next step. Use this to give the player a moment to absorb a new scene before dialogue starts. `@pause` takes **no arguments** — for longer beats, write multiple `@pause` lines in a row.

```
@bg set malias_bedroom_morning
&music calm_morning
&malia neutral_phone
@pause
NARRATOR: Senior year. Day one.
```

The player sees the scene load (background, music, and character all at once), then must tap once before the narrator line appears. This creates a natural beat — the player takes in the visuals before reading.

## Audio

```
@music calm_morning               // Start / switch BGM (engine decides from-silence vs crossfade)
@music stop                       // Stop BGM (fade out)
@sfx door_slam                    // One-shot sound effect
```

`@music <name>` is unified — the engine inspects the current playback state and either fades in from silence or crossfades from the current track. The script doesn't distinguish "play" vs "crossfade".

**Restraint matters.** A typical episode uses **≤3 distinct music tracks** (one per major mood block) and SFX only on punctuating beats. Don't restart a track if the previous one still fits, and don't underline narrated ambient sound the player can imagine.

## Phone / Messages

The phone overlay sits on top of everything. Keep messages short — they render in chat bubbles.

```
@phone {
  @text from EASTON: Can we talk? I miss you.
  @text from EASTON: I know I messed up.
  @text to MAURICIO: How do you know where I live?
}
```

- `@phone { ... }` pops the phone overlay; it must be written as a multiline block, and the block end automatically dismisses it. There is no `@phone hide`.
- Every `@text from/to` inside `@phone` is silent UI text. It never requests or requires character voice audio.
- `@text from <CHAR>: content` — incoming message (gray bubble, left).
- `@text to <CHAR>: content` — outgoing message (blue bubble, right).

**Whitelist: only `@text from/to` lines are allowed inside a `@phone` block.** No narration, no SFX, no state changes, no `@if` — those all live outside the phone block. Anything else inside `@phone` is a parse error.

## Game Mechanics

### Tricks (forced body-interaction beats)

`@trick <type> "<prompt>"` is a one-liner that forces the player to complete a small body action before the story advances. It's the embodied upgrade of `@pause`: the player must tap / hold / swipe / shake / swing / tilt the device, with a one-line on-screen prompt you author. There is no rating, no reward, no branching — the value is *presence*, not winning.

```
@trick hold "Hold your breath until he walks past."
@trick tap  "Tap fast to catch your breath before the next class."
@trick swipe "Wipe the steam off the mirror."
```

**The locked 6 trick types.** Pick one — the language does not allow inventing new types.

| `<type>` | Modality | What it can dramatise |
|---|---|---|
| `tap` | touch | running, struggling, knocking, applauding, heartbeat |
| `hold` | touch | holding breath, staying still, pressing on a wound |
| `swipe` | touch | wiping fog, brushing tears, pushing away — direction only |
| `shake` | motion | shaking awake, shaking a bottle, trembling, an earthquake |
| `swing` | motion | swinging a bat, casting a line, throwing a punch, knocking |
| `tilt` | motion | peeking around a corner, listening at a door, cocking your head to observe |

All six types use touch or device-motion sensors only — no camera, no microphone, no runtime permission prompt.

**Authoring rules:**

- `@trick` is a leaf — no `{ }` body. Adding one is a parse error.
- Pick a type that fits the *embodied verb* of the moment. "Holding your breath" is `hold`; "peek around the corner" or "listen at the door" is `tilt`. `swipe` is direction-only, not path-tracing.
- The prompt is the player-facing imperative. Keep it under one short sentence; write it in second person ("Hold your breath...", "Tap fast..."). It doubles as narrative glue.
- Use sparingly — typically 1–3 per episode at moments that *feel* embodied. Every trick is a forced gate; if the player can't perform the action they can't continue. Don't gate on a trick at a beat the player must reach.

### Mini-games (optional, downstream-generated)

`@minigame <name> "<description>"` is a one-liner that embeds an optional mini-game. The player can play or skip; the engine scales the reward by the H5 result if they play. The game itself is **generated by a downstream vibe-coding agent** from your `description`.

```
@minigame casino_showdown "Mauricio drags Malia into a backroom blackjack game — green felt, a low brass lamp, cigarette smoke, his friends watching — betting on who covers tonight's tab. The player taps to draw cards and taps Stand to hold, beating the dealer's hand without going over 21; three quick rounds. Win and Malia keeps her dignity; lose and she owes him a favor."
```

**Authoring rules:**

- `@minigame` is a leaf — no body, no attribute positional, no rating branching.
- The description is a single connected prose paragraph that does two jobs at once:
  1. **Set the scene.** Why is this game happening, what's at stake, who's there, what's the vibe?
  2. **Define the simple gameplay.** What does the player tap / drag / time, what's the core mechanic, what counts as winning? "Simple" is the key — give the agent direction, not a design doc.
- **Do not declare rewards or stakes in numbers.** Rewards are entirely engine-side (anti-cheat); the script never names coins, XP, SAN, etc. for the minigame.
- If you need a story branch off the minigame outcome (won / lost), promote it to a `@choice` — minigames don't drive narrative routing on their own.
- **Complexity ceiling for the vibe-coding agent**: think one-touch / one-drag mechanics, 30–90 seconds of play, a clear win condition you can describe in one sentence. Multi-screen puzzles, persistent inventory, networked play — all out of scope; rewrite as a `@choice` or a `@trick`.

### Choices (D20 Checks)

Every episode has one choice point. Each option has an ID (A, B, C...) and a mode (`brave` = triggers D20 check, `safe` = no check).

**Option text is the player's UI button label — keep it under ~12 words.** Long narrative belongs *inside* the option block as body nodes, not in the option text string.

```
@choice {
  @option A brave "Stand your ground." {
    check {
      attr: CHA
      dc: 12
    }
    @if (check.success) {
      @easton relieved
      EASTON: Can I sit?
      MALIA: You have two minutes.
      @affection easton +2
      @butterfly "Accepted Easton's approach at the cafeteria"
    } @else {
      @easton hurt
      MALIA: I... I can't do this.
      @butterfly "Tried to face Easton but lost courage"
    }
  }
  @option B safe "Have Mark make a scene." {
    @mark grin_mischief
    MARK: HEY EASTON! You want some of my mystery casserole?
    YOU: Thank god for Mark.
    @butterfly "Had Mark create a diversion to avoid Easton"
  }
}
```

**Rules for `brave` options:**
- Must contain a `check { attr: ... dc: ... }` block.
- Outcome branching uses a standard `@if (check.success) { } @else { }` tree. `check.success` / `check.fail` are context-local pseudo-identifiers valid only inside a brave option body.
- A missing `@else` is a narrative choice, not a syntax error — the validator does not require both branches to be populated. If you leave fail implicit, make sure the story still reads.
- Attribute names are freeform strings (the engine knows how to interpret them).

**Rules for `safe` options:**
- No check block, no outcome branching — safe options bypass the D20 entirely.
- Content goes directly inside the option block as plain body nodes.

**Every outcome path should include:**
- `@butterfly` description (what happened as a result of this choice — these records feed downstream content generators: Remix Executor and Dream)
- Optionally: `@affection` if the choice changes a relationship
- Optionally: `@signal mark` or `@signal int` if a *later* `@if` will branch on this beat

**Do NOT drop a `@signal mark` on every choice outcome.** Marks are only for key story points that a later `@if` branch or an `@achievement` unlock will actually query. See "State Changes" below.

## State Changes

These are declarations — the game engine handles the actual math.

```
@affection easton +2                                   // Character relationship
@butterfly "Accepted Easton's approach"                // Flavor memory for downstream content generators
@signal mark HIGH_HEEL_EP05                            // Key story point — queried later
@signal int REJECTIONS +1                              // Persistent integer counter — free to mutate
@signal int REJECTIONS = 0                             // Explicit reset / initialization
@achievement HIGH_HEEL_WARRIOR {                       // Achievement unlock
  name: "Heel as Weapon"
  rarity: rare
  description: "You turned an accessory into a warning."
}
```

> **Engine-managed values** (XP, SAN/HP, etc.) are set by the game engine, not scripts. You can reference them in `@if` conditions (e.g., `@if (san <= 20) { }`) but cannot modify them from scripts. The value names (san, xp, hp, etc.) are defined by the engine, not the script.

**`@signal <kind> <...>` — kind is mandatory.** Two kinds are implemented:

- `@signal mark <event>` — persistent boolean flag. Use sparingly; every mark must have a reader (see below).
- `@signal int <name> <op> <value>` — persistent integer counter. Free to mutate (`= N`, `+N`, `-N`). Read via `@if (NAME >= N)` comparison.

Achievements are **not** a signal kind — use `@achievement <id> { ... }` for those.

| kind | Role | Checkable in `@if`? |
|------|------|---------------------|
| `mark` | Persistent boolean flag. Engine stores it forever. `@if (NAME)` queries this store. **Use only for key story points** — hidden-route triggers and achievement-unlock guards. | **Yes** — becomes a `flag` condition |
| `int` | Persistent integer variable. Engine stores across episodes. `@if (NAME <cmp> N)` queries the value via comparison. Free to mutate as often as needed — counters are the whole point. | **Yes** — becomes a `comparison` condition with `left.kind="value"` |

For both kinds, the author-defined name uses English `SCREAMING_SNAKE_CASE` and must match `^[A-Z][A-Z0-9_]*$`. Lowercase names are reserved for runtime-declared, read-only engine values such as `san`.

### Mark discipline — marks are NOT wayposts

**Every `@signal mark X` must have a reader.** Either some later `@if (X)` branch depends on it, or some `@if (X && ...) { @achievement ID { ... } }` unlock guard references it. If nothing reads it, delete it. Cluttering the flag store dilutes the signal (pun intended) and confuses downstream tooling.

**`@signal int` is not mark.** Counters are expected to be written often — `REJECTIONS +1` every time the player rejects Easton is exactly the point. The "marks are precious" discipline does NOT apply. Use `@signal int` whenever you need "if player did X at least N times" or "N-of-M threshold" branching. Prefer `@signal int COUNTER +1` + `@if (COUNTER >= N)` over stacking multiple boolean marks.

Guidelines for ints:
- Name in `SCREAMING_SNAKE_CASE` (e.g. `REJECTIONS`, `BRAVE_COUNT`, `TIMES_MET_EASTON`).
- Avoid names that look like engine values (`san`, `cha`, `hp`, `xp`) — the validator will reject these.
- `@signal int LOVE_POINTS = 0` is an unconditional assignment — if placed somewhere the player can revisit, it will reset the counter. That is the author's responsibility; the engine does not protect.
- For first-time reads, the engine treats undeclared variables as 0, so `@signal int LOVE_POINTS +1` and `@if (LOVE_POINTS >= 1)` work without any prior `= 0`.

**Write the mark second.** Start from the reader:

1. Identify the payoff — a hidden line of dialogue, a secret scene, an arc achievement
2. Write the `@if` guard that would unlock it
3. *Then* trace back to where the mark should be emitted

**Do NOT emit marks for things the engine already tracks:**

- ❌ `@signal mark EP01_COMPLETE` at the end of every episode — the engine knows which episodes the player cleared from episode_id itself
- ❌ `@signal mark CHOSE_OPTION_A` after a choice — the choice history is in the engine's choice log; gate `@if (A.success)` queries it directly
- ❌ `@signal mark AFFECTION_RAISED` — `@affection` already updated the number; `@if (affection.easton >= 5)` queries the value directly
- ❌ `@signal mark EASTON_ACKNOWLEDGED` as a character-moment marker with no follow-up — that's what `@butterfly` is for (feeds Remix / Dream, not boolean-queried)
- ❌ Don't use `@signal mark COUNTER_HIT_3` to track thresholds — that's what `@signal int` is for. Use `@signal int COUNTER +1` then `@if (COUNTER >= 3)`.

**DO emit marks for these cases:**

- ✅ **Hidden-route trigger**: A key moment in EP05 that a later episode's dialogue references:
  ```
  // EP05
  MALIA: One quick step. My heel went straight through his shoe.
  @signal mark HIGH_HEEL_EP05

  // EP10 — only players who did EP05 see this line
  @if (HIGH_HEEL_EP05) {
    NARRATOR: She glanced down at her shoes. She remembered.
  }
  ```
- ✅ **Arc achievement trigger**: Two or more marks feed into an achievement unlock guard:
  ```
  // EP05
  MALIA: One quick step. My heel went straight through his shoe.
  @signal mark HIGH_HEEL_EP05

  // EP24 — the second beat, and the place where the achievement fires
  MALIA: And again. Same shoe, same precision.
  @signal mark HIGH_HEEL_EP24
  @if (HIGH_HEEL_EP05 && HIGH_HEEL_EP24) {
    @achievement HIGH_HEEL_DOUBLE_KILL {
      name: "Heel Twice Over"
      rarity: epic
      description: "Once is improvisation. Twice is a signature move."
    }
  }
  ```
- ✅ **Single-beat achievement**: A singular narrative moment unlocks an achievement directly:
  ```
  YOU: I leaned in. He didn't pull back.
  @achievement FIRST_KISS {
    name: "First Kiss"
    rarity: uncommon
    description: "You stopped calculating and let it happen."
  }
  ```

**Name every author signal (`mark` and `int`) and every achievement id in `SCREAMING_SNAKE_CASE` English.** The compiler enforces the signal rule; lowercase bare names remain available to engine-managed values.

**Where to put the `@if ... { @achievement ID }` guard** for arc achievements: put it after the *last* mark in the chain is emitted — the guard only fires if every required mark is already set. Putting it at the start of an episode works too but is redundant (you'd re-check every time). One clean guard beats multiple scattered checks.

### `@butterfly` — feeds downstream generators, NOT routing

**Butterfly is content-generation memory, not a routing signal.** The engine accumulates butterfly records across the playthrough and hands them to two downstream LLM-powered agents:

- **Remix Executor** — when the player remixes a scene, butterflies inform the regenerated content so it stays consistent with the player's pattern.
- **Dream** — when a dream-sequence insert is generated, butterflies shape what the dream surfaces.

**Butterflies do NOT participate in gate routing.** `@gate` blocks evaluate only the deterministic state types — `@signal mark`, `@signal int`, `@affection`, choice history, and engine values. There is no `influence` condition. If no downstream agent will read this butterfly, don't emit it — it goes nowhere.

When you do want a beat to inform downstream content, write a clear, specific description of what *this* player did that another player wouldn't have. Bad: "Made a choice." Good: "Showed vulnerability by accepting help from a former rival."

For intra-episode story-flag branching use `@signal mark`; for repeat-event counting use `@signal int COUNTER +1` then `@if (COUNTER >= N)`.

### Achievements — `@achievement`

One directive, one form: `@achievement <id> { name / rarity / description }`. The block carries the full metadata and reaching this node in execution fires the achievement. Conditional triggering is just standard `@if` wrapping — there is no separate declaration step.

```
@if (HIGH_HEEL_EP05 && HIGH_HEEL_EP24) {
  @achievement HIGH_HEEL_DOUBLE_KILL {
    name: "Heel Twice Over"
    rarity: epic
    description: "Once is improvisation. Twice is a signature move."
  }
}
```

**Required fields (all three). Use English for all user-facing text:**

| Field | Type | Rule |
|-------|------|------|
| `name` | quoted string | English display name. Short, concrete, evocative (≤30 chars recommended) |
| `rarity` | identifier | One of: `uncommon` / `rare` / `epic` / `legendary`. **`common` is banned** — if every player gets it, it's not an achievement |
| `description` | quoted string | English DM-voice flavor text (1-2 sentences) |

**Trigger placement patterns:**

1. **Single-beat achievement** — fire inline at the moment the achievement makes narrative sense:
   ```
   YOU: I leaned in. He didn't pull back.
   @achievement FIRST_KISS {
     name: "First Kiss"
     rarity: uncommon
     description: "You stopped calculating and let it happen."
   }
   ```
2. **Arc achievement** — wrap in an `@if` that checks every required mark, placed right after the last mark in the chain is emitted:
   ```
   // Episode 24
   @signal mark HIGH_HEEL_EP24
   @if (HIGH_HEEL_EP05 && HIGH_HEEL_EP24) {
     @achievement HIGH_HEEL_DOUBLE_KILL {
       name: "Heel Twice Over"
       rarity: epic
       description: "Once is improvisation. Twice is a signature move."
     }
   }
   ```

**Same id in multiple places is fine** — the engine dedupes by id at unlock time. If you deliberately echo the same achievement from several narrative branches, write it out each time.

## Flow Control

### Conditional content

Use `@if` to show different content based on game state. **Parentheses `()` are mandatory** around the condition. The engine evaluates conditions at runtime. Use `@else @if` to chain multiple conditions.

```
@if (affection.easton >= 5 && CHA >= 14) {
  EASTON: You remembered.
} @else @if (affection.easton >= 3) {
  EASTON: ...I wasn't sure you'd come.
} @else {
  EASTON: ...Hey.
}

@if (san <= 20 || FAILED_TWICE) {
  YOU: I can barely keep it together.
}
```

**Condition types (5 kinds, all compiled to structured AST — the backend receives typed condition objects, not expression strings):**

| Type | Syntax | Example |
|------|--------|---------|
| choice | `OPTION.result` | `@if (A.fail) { }` — result: `success` / `fail` / `any`. Use from outside the option |
| flag | `SIGNAL_NAME` | `@if (EP01_COMPLETE) { }` |
| comparison | `<operand> <op> <operand>` | `@if (affection.easton >= 5) { }`, `@if (REJECTIONS >= 3) { }`, `@if (affection.easton > affection.diego) { }` |
| compound | `<expr> && <expr>` / `<expr> \|\| <expr>` | `@if (san <= 20 \|\| FAILED_TWICE) { }` |
| check | `check.success` / `check.fail` | `@if (check.success) { }` — context-local, only valid inside a brave option body |

**`check` vs `choice`** — both touch D20 outcomes but answer different questions. `check.success` inside a brave option body asks "did *this* option's roll just succeed?" It's the idiom for writing `@if (check.success) { } @else { }` immediately after `check { }`. `A.success` from anywhere asks "at some earlier point, did the player pick option A and pass its check?" — retrospective, not context-local. Use `check.*` inside the option body it describes; use `A.*` / `B.*` everywhere else.

**Operators:** `>=` `<=` `>` `<` `==` `!=`
**Logic:** `&&` (and, binds tighter), `||` (or, binds looser). Use `( )` for explicit grouping.

### Comparison operands (5 kinds)

Both sides of a comparison are *operands*. The validator enforces that both sides have the same integer type, but **either side can be any operand kind** — variable-to-variable comparisons are fully supported, as are aggregate-to-literal, literal-to-aggregate, etc.

| Operand form | AST `kind` | Notes |
|--------------|-----------|-------|
| `5` / `-2` | `literal` | Integer literal |
| `affection.<char>` | `affection` | Character affection score |
| `<name>` | `value` | Bare identifier — resolves either to an engine value (`san`, `cha`, `hp`, `xp`...) or to your `@signal int` variable. Same namespace |
| `MAX(<op>, <op>, ...)` | `max` | Aggregate of args. `args >= 2`, no upper bound. args may be any operand kind, including nested `MAX`/`MIN` |
| `MIN(<op>, <op>, ...)` | `min` | Same shape as `MAX`, returns the minimum |

`MAX` / `MIN` are **reserved words** and **must be uppercase**. Lowercase `max` / `min` are still legal as ordinary value names (no collision).

**Examples:**

```
@if (affection.easton >= 5)                                        // value-to-literal
@if (REJECTIONS >= 3)                                              // signal int read
@if (affection.easton > affection.diego)                           // value-to-value
@if (5 < affection.easton)                                         // literal-to-value (mirror form)
@if (MAX(affection.easton, affection.diego) >= 5)                  // 2-arg aggregate
@if (MIN(affection.easton, affection.diego, affection.mauricio) >= 3)   // 3-arg aggregate
@if (MAX(affection.easton, affection.diego, affection.mauricio, affection.elias) >= 8)
@if (affection.easton > MAX(affection.diego, affection.mauricio))  // aggregate-to-value
@if (MAX(affection.easton, MIN(affection.diego, affection.mauricio)) >= 4)   // nested
```

**Constraint:** `MAX` and `MIN` require at least 2 args. A single-arg aggregate is a parse error (it would degenerate to the arg itself — write the arg directly).

## Routing (Gate)

The `@gate` block at the end of every episode declares where the player goes next. Use `@if` → `@else @if` → `@else` chains. First match wins. `@else` is the fallback.

**Gate leaves come in two flavours, and a single gate may mix them freely:**

- **`@next <branch_key>`** — route to another episode
- **`@end <type>`** — terminate the story, `type ∈ complete | to_be_continued | bad_ending`

```
@gate {
  // Choice-based route to a bad ending
  @if (A.fail): @end bad_ending

  // Counter-based terminal
  @else @if (REJECTIONS >= 3): @end bad_ending

  // Mark-based hidden route
  @else @if (HEROIC_END_REACHED): @end complete

  // Affection-based good route
  @else @if (affection.easton >= 5): @next main/route/001:01

  // Fallback to main line
  @else: @next main:02
}
```

**Choice condition format:** `<option_id>.<result>` (dot notation, no space)
- option_id: A, B, C... (matches the option's ID)
- result: `success` | `fail` | `any` (`any` = regardless of check outcome)
- Example: `A.fail`, `B.success`, `C.any`

**4 condition kinds work inside gate** — `choice`, `flag`, `comparison`, `compound`. The fifth kind, `check`, is context-local to a brave option body and is **never** legal inside `@gate`. Routing relies entirely on deterministic state — there is no `influence` condition; butterfly accumulation feeds downstream content generators, not gate evaluation.

**Coverage:** every gate must be exhaustive. Either a single unconditional leaf (`@gate { @next main:02 }` or `@gate { @end bad_ending }`), or an `@if/@else @if/.../@else` chain with a mandatory `@else` fallback.

### Terminal Episodes

To terminate the story rather than route onward, write a gate whose leaves include `@end <type>`. The cleanest single-leaf form:

```
@episode main:15 "The End" {
  NARRATOR: The sun rose over a changed city.

  @gate { @end complete }
}
```

Three end types:

| Type | Meaning | Typical placement |
|------|---------|-------------------|
| `complete` | Story fully ends — credits roll | Main ending episodes; true-end / happy-end |
| `to_be_continued` | Cliffhanger — next chapter not written yet | Last episode of the current release |
| `bad_ending` | Bad path terminus — player failed / died / broke the relationship | Episodes under `main/bad/...` |

You can also mix `@next` and `@end` leaves in one gate, e.g. a chapter finale that routes most paths into the next chapter but ends on `bad_ending` for the worst route:

```
@gate {
  @if (REJECTIONS >= 3): @end bad_ending
  @else @if (HEROIC_END_REACHED): @end complete
  @else: @next main:02
}
```

Only the three end types listed above are accepted; anything else is a parse error.

## Common Mistakes

1. **Missing `@gate`** — Every episode must end with exactly one `@gate { ... }` block. No gate = `MISSING_TERMINAL` validator error.
2. **Multiple `@gate` blocks** — Exactly one per episode, at the end.
3. **Missing `@else`** — Gate `@if/@else @if` chain without a fallback `@else` = interpreter error. Single unconditional `@gate { @next ... }` or `@gate { @end ... }` is fine (no chain, no fallback needed).
4. **Brave option without `check { }`** — Brave means D20 check. No check block = error.
5. **Brave option outcome branching with anything other than `@if (check.success) { } @else { }`** — that is the idiom. A missing `@else` is allowed (validator does not force both branches), but is usually still what you want.
6. **Putting `@gate` anywhere except the end** — Gate must be the last thing in `@episode`.
7. **Using character names inconsistently** — `@mauricio neutral_smirk` and `MAURICIO:` must use the same name (case-insensitive).
8. **Writing asset paths instead of semantic names** — Scripts use names like `classroom_morning`, not URLs or file paths. The interpreter handles mapping.
9. **Nested `@choice` blocks** — Only one `@choice` per episode. Multiple choices in one episode is not supported.
10. **Using `&` on block structures** — `&choice`, `&phone`, `&if`, `&gate` are all errors. Block structures always use `@`. (`@trick` / `@minigame` / `@cg` are leaves and technically permit `&`, but bundling them into a scene-setup group obscures the beat — keep on `@`.)
11. **Forgetting to use `&` for scene setup** — When a scene starts with bg + music + character entrance, the first directive uses `@` and the rest should use `&` so they execute together. Writing all of them with `@` makes them sequential, which looks choppy.
12. **Trying to set engine values from scripts** — `@xp`, `@san` are not valid directives. The engine manages these values internally. Scripts can only check them in `@if` conditions (e.g., `@if (san <= 20) { }`), not modify them.
13. **`@if` without parentheses** — `@if condition { }` is a syntax error. Must be `@if (condition) { }`. Parentheses are mandatory for both body `@if` and gate `@if`.
14. **Using `choice.A.fail` in gate conditions** — The `choice.` prefix is dropped. Use `A.fail`, not `choice.A.fail`. Dot notation: `A.fail`, not `A fail`.
15. **Invalid `@end` type** — Only `complete`, `to_be_continued`, `bad_ending` are accepted. Any other identifier is a parse error.
16. **`@signal` without a kind** — `@signal <kind> <event>` requires a kind token. Currently `mark` and `int` are implemented. `@signal achievement ...` is not valid — use `@achievement <id>` instead.
17. **`@minigame` with extra positional / body** — the form is `@minigame <name> "<description>"`, one line. No ATTR positional, no `{ }` body, no rating branches. Rewards are engine-owned. If you want a story branch off the minigame, promote it to a `@choice`.
18. **`@cg` with a `{ }` body, duration, or transition** — `@cg <name> "<content>"` is a leaf, one line, prose only. The pipeline decides duration and camera from the prose. If you need dialogue around the CG, write it on the lines before and after the `@cg` directive — not inside it.
19. **Orphan marks** — `@signal mark X` with no reader. If no `@if (X)` and no `@if (X && ...) { @achievement ... }` references `X`, delete the mark. Marks that no one reads are noise: they dilute the flag store and mislead downstream tools. Never emit marks for "episode completed", "chose option A", "affection raised", or anything else the engine already tracks.
20. **Using non-English names** — All `event` identifiers, `@achievement` ids, achievement `name`, and `description` strings must be English. Mixed-language ids cause grep/search failures and ambiguous meaning across the pipeline.
21. **Using `common` rarity on `@achievement`** — banned. Rarity must be one of `uncommon` / `rare` / `epic` / `legendary`. If every player gets it, it's not an achievement.
22. **Writing a `when:` field on `@achievement`** — `when` is not part of the grammar. Achievements carry only `name` / `rarity` / `description`; trigger logic lives in the outer `@if (...)` that wraps the `@achievement` directive.
23. **Duplicate `@achievement` ids in one episode** — validator error. If the same achievement spans multiple episodes, declare it once in whichever one most naturally owns it.
24. **Triggering an achievement that was never declared** — `@achievement <id>` inline without a matching `@achievement <id> { ... }` declaration is a runtime dead letter. The runtime registry must have seen the declaration first. (Cross-episode is fine; the engine loads all declarations.)
25. **Using `check.success` outside a brave option body** — a context-local pseudo-identifier. Outside its scope the runtime always returns false — that's a narrative bug, not a syntax error.
26. **Routing on butterfly / "influence"** — there is no `influence` condition. Butterflies feed Remix Executor and Dream, not gate routing. Routing uses `choice`, `flag`, `comparison`, and `compound` conditions.
27. **Single-arg `MAX(x)` or `MIN(x)`** — aggregate operators require `args >= 2`. A 1-arg aggregate is a parse error; write the arg directly instead.
28. **Lowercase `max(...)` / `min(...)` used as the aggregate operator** — `MAX` and `MIN` are reserved words and must be UPPERCASE. Lowercase `max` / `min` are legal as ordinary `@signal int` variable names; they will not parse as the aggregate.
29. **Bundle of `@phone` block with non-`@text` content** — only `@text from/to` lines may appear inside `@phone { ... }`. No narration, no SFX, no `@if`, no state changes. Move those outside the phone block.
30. **Inventing character positions** — there is no syntax for `at left` / `at right` / `at center`. The engine positions characters from `gamestate.MC` (MC pinned left, others pinned right). Anything you'd want to convey about staging — pose, bubble, transition — uses pose names and transitions, not position keywords.
31. **Orphan branches and dead `@next` targets** — every `@next <branch_key>` in a `@gate` must point at an episode file that exists in the repo, and every side episode (`main/route/...`, `main/bad/...`) you write needs an upstream `@gate` that routes into it. In single-file `lsc compile` cross-file references aren't checked; in batch `lsc compile <dir>` the validator does verify branch_key resolution.
32. **Essay-length option text** — `@option <ID> <mode> "<text>"` text is the player's UI button label. Keep under ~12 words. Long narrative goes inside the option block as body nodes.

**Auto-repair:** The interpreter includes a fixer (`lsc fix <file>`) that auto-repairs many of these mistakes: missing `@if` parentheses, `&` on block structures, `@check` → `check`, uppercase character names in `@affection`, trailing whitespace, unclosed blocks, and BOM/CRLF encoding issues. Always run the fixer before compiling if the script was generated by an LLM.

## Remix Scripts

Remix scripts use the exact same format. The only differences:

- **Branch key** uses `remix/<session_id>:01` addressing
- **Content starts after the choice point** — the user's input replaced the original `@choice`
- **May or may not return to main line** — `@else: @next main:02` to rejoin, or `@else: @next remix/<session_id>:02` to continue the remix branch

```
@episode remix/abc123:01 "Mark's Casserole Incident" {
  @mark grin_mischief
  MARK: FOOD FIGHT!
  @sfx crowd_noise
  NARRATOR: The cafeteria descended into chaos.
  @butterfly "Mark started a food fight in the cafeteria"

  @gate {
    @next main:02
  }
}
```

## Pacing Guidelines

These aren't enforced by the interpreter, but they make for a good player experience:

- **Expand, don't compress.** LLMs default to terse summarization; resist that. A scene with one dialogue exchange is too thin — the player needs the inner monologue, the silent beat, the second look at the photograph. Token pressure pushes you toward compression; the player paid for the moments, not the plot summary.
- **Scene changes**: Use `@bg set ... fade` between locations. Don't change backgrounds mid-dialogue without a beat.
- **Character entrances**: Show one character at a time (the engine enforces this anyway). Let the player tap once after a `@<char> <pose>` directive before the character speaks.
- **Inner monologue**: Use `YOU:` liberally — it keeps the player in the protagonist's head and builds emotional investment.
- **Phone messages**: Keep them short (under 20 words per message). They're in chat bubbles.
- **Bubbles**: Use sparingly for emotional punctuation, not on every line.
- **Music transitions**: A new `@music <name>` between scenes feels like a fresh chapter; `@music stop` before silence or big moments lets the room breathe.
- **One choice per episode**: This is a design constraint. The whole episode builds toward one decision point.
- **Use `@pause` after scene setup** to let the player absorb the new scene before dialogue starts. A scene that jumps straight from setup to narration feels rushed.

## References

- `references/directive-table.md` — directive cheat sheet, quick lookup when writing scripts
- `references/addressing.md` — episode ID addressing rules for branch_key and file naming
- `references/LS-SPEC.md` — **complete format specification** with JSON output structure, asset mapping schema, interpreter behavior, and Remix compatibility details. Read this when you need to understand how the interpreter processes scripts, what JSON the frontend receives, or how the asset mapping JSON works.
