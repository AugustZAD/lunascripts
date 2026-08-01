// Feature Parade EP01 — 主测试剧本
// 每段对白直接用 [T##] 标注所测功能，测试者播放时对照清单勾选。
// Gate 路由全部指向已存在的 ep 文件，condition 覆盖 5/6（check 仍是 context-local，
// 在 T19 验证；rating 自 2026-05-19 trick/minigame 重构后已删除）。

@episode main:01 "Feature Parade" {

  // ================================================================
  // SCENE 1 — Concurrent group + dialogue kinds + phone messages
  // ================================================================

  @bg set bedroom
  &music calm
  &malia phone

  NARRATOR: [T1] Concurrent group fired: bg + music + char_show (one & group).
  YOU: [T2] YOU internal monologue renders here.
  NARRATOR: [T3] NARRATOR line (separate from dialogue).
  MALIA: [T4] CHARACTER dialogue line from MALIA.

  @phone {
    @text from EASTON: [T5] @phone block → @text from (incoming, left bubble)
    @text to EASTON: [T6] @phone block → @text to (outgoing, right bubble)
    @text from EASTON: [T7] multiple messages inside one @phone block
  }

  MALIA [worried]: [T8] CHARACTER [pose]: syntax sugar — changes pose AND speaks in one line.

  // ================================================================
  // SCENE 2 — bg transition=fade + bubble types ×9 + pause
  // ================================================================

  @bg set school fade
  &music upbeat
  &josie excited

  NARRATOR: [T9] bg transition=fade + music (auto-crossfade) + char_show (concurrent).

  NARRATOR: [T10] Watch 9 bubbles fire in order below (heart/anger/sweat/question/exclaim/idea/music/doom/ellipsis).
  @josie bubble heart
  @josie bubble anger
  @josie bubble sweat
  @josie bubble question
  @josie bubble exclaim
  @josie bubble idea
  @josie bubble music
  @josie bubble doom
  @josie bubble ellipsis

  NARRATOR: [T11] Two consecutive @pause directives — expect TWO clicks to advance past this line.
  @pause
  @pause

  // ================================================================
  // SCENE 3 — bg transition=cut + same-screen char swap + sfx
  // ================================================================

  @bg set hallway cut
  &mauricio smirk
  &sfx bell

  NARRATOR: [T12] bg transition=cut + char_show (implicit overwrite of previous char) + sfx (concurrent).
  MAURICIO: [T13] Dialogue from current speaker (Mauricio replaces Josie under same-screen-one-char rule).
  NARRATOR: [T14] NARRATOR clears the stage — no explicit hide needed under new spec.

  // ================================================================
  // SCENE 4 — bg transition=slow + minigame (leaf) + trick (engine-native)
  // ================================================================

  @bg set classroom slow
  &music tense
  &malia flat

  NARRATOR: [T15] bg transition=slow + music + char_show (concurrent).
  @mauricio angry
  NARRATOR: [T15b] Second char_show — Mauricio replaces Malia (one-on-screen rule).

  NARRATOR: [T16] @minigame parking_rush — one-liner, no body. Vibe-coding agent generates the H5 from this prose; player may play or skip.
  @minigame parking_rush "Mr. Chen sends the class on a fire-drill rehearsal. Malia has to cross the cramped parking lot before the bell rings — the player taps direction prompts to weave between three rows of parked cars, ducking the wing mirrors. Three short waves; the last one is the longest. Win and she beats Mauricio to the gate; lose and he's already there, holding the door open with that eyebrow."

  NARRATOR: [T16t] @trick tap — engine-native body-interaction beat. Player MUST complete it to advance (no skip).
  @trick tap "Tap fast to catch your breath before the next class."

  // ================================================================
  // SCENE 5 — @choice (brave + check, safe) + all state directives
  // ================================================================

  @bg set cafeteria fade
  &music lunch
  &mark grin

  MARK: [T17] Set up: a @choice block follows with a brave + a safe option.
  @sfx crowd
  @easton hopeful

  NARRATOR: [T18] Option A uses check(CHA, dc=12). Option B is safe (no check).

  @choice {
    @option A brave "[T19-brave] Face Easton (tests brave option + check block)." {
      check {
        attr: CHA
        dc: 12
      }
      @if (check.success) {
        NARRATOR: [T19a] check.success branch hit (context-local condition).
        @easton relieved
        EASTON: Can I sit?
        MALIA: Two minutes.
        @affection easton +2
        NARRATOR: [T20a] @affection +2 applied.
        @butterfly "Accepted Easton openly at lunch"
        NARRATOR: [T20b] @butterfly recorded (content-gen only, not gate routing).
        @signal mark EP01_FACED_EASTON
        NARRATOR: [T20c] @signal mark EP01_FACED_EASTON written to flag store.
        @signal int EASTON_APPROACHES_ACCEPTED +1
        NARRATOR: [T20c2] @signal int EASTON_APPROACHES_ACCEPTED +1 applied.
        @achievement EYE_CONTACT {
          name: "Eye Contact"
          rarity: uncommon
          description: "Didn't look away."
        }
        NARRATOR: [T21a] @achievement rarity=uncommon unlocked.
      } @else {
        NARRATOR: [T19b] check.fail branch hit.
        @easton hurt
        MALIA: Not today.
        @affection easton -1
        NARRATOR: [T20d] @affection -1 (negative delta) applied.
        @butterfly "Lost nerve facing Easton"
        @signal int REJECTIONS +1
        NARRATOR: [T20d2] @signal int REJECTIONS +1 — counts failed approaches.
      }
    }
    @option B safe "[T22-safe] Have Mark intervene (tests safe option, no check)." {
      @mark grin
      MARK: MOVE ALONG, lover boy!
      @mark bubble music
      @butterfly "Had Mark deflect Easton"
      @signal mark EP01_DEFLECTED
      NARRATOR: [T22a] Safe path executed — EP01_DEFLECTED flag set.
    }
  }

  // ================================================================
  // SCENE 6 — top-level @if with compound / comparison / flag + CG
  // ================================================================

  @bg set gym fade
  &music ambient
  &malia flat

  NARRATOR: [T23] Top-level @if chain with compound(comparison && flag) / compound(comparison || flag) / @else.
  @if (affection.easton >= 2 && EP01_FACED_EASTON) {
    YOU: [T23a] compound (comparison && flag) true.
    @malia bubble heart
  } @else @if (affection.easton < 0 || EP01_DEFLECTED) {
    YOU: [T23b] compound (comparison || flag) true.
    @malia bubble doom
  } @else {
    YOU: [T23c] fallback @else.
    @malia bubble ellipsis
  }

  NARRATOR: [T24] @cg window_stare — leaf indirect (no body); CG describes itself in prose.
  NARRATOR: [T24a] NARRATOR line BEFORE the CG leaf (formerly nested inside body).
  YOU: [T24b] YOU line BEFORE the CG leaf (formerly nested inside body).
  @cg window_stare "Wide shot pushes in as Malia stands at the gym window, late sunlight cutting through dust. The camera holds long enough to catch the slow tilt of her head, then dissolves to the silhouette of the empty court behind her."

  // ================================================================
  // SCENE 7 — affection vs affection, MAX/MIN operand, engine value comparison, @music stop
  // ================================================================

  @bg set bedroom fade
  &music night
  &malia phone

  NARRATOR: [T25] @if with operand-vs-operand comparison (affection.easton > affection.mauricio).
  @if (affection.easton > affection.mauricio) {
    @phone {
      @text from EASTON: [T25a] easton-leading branch reached (variable-vs-variable comparison).
    }
    @affection easton +1
  } @else {
    YOU: [T25b] mauricio-leading or tied branch — no phone message.
  }

  NARRATOR: [T25m] @if with MAX(...) aggregate operand — triggers a butterfly if any LI's affection has reached 5.
  @if (MAX(affection.easton, affection.mauricio, affection.elias) >= 5) {
    @butterfly "Reached affection threshold 5 with at least one LI"
    @achievement FIRST_BOND {
      name: "First Bond"
      rarity: rare
      description: "One of them crossed the line first."
    }
    NARRATOR: [T25m1] MAX(...) >= 5 branch — achievement rare unlocked.
  } @else {
    YOU: [T25m2] no LI has crossed affection 5 yet.
  }

  NARRATOR: [T25n] @if with MIN(...) aggregate — guards against any negative affection.
  @if (MIN(affection.easton, affection.mauricio, affection.elias) >= 0) {
    YOU: [T25n1] MIN(...) >= 0 — all LIs non-negative.
  } @else {
    YOU: [T25n2] at least one LI has gone negative.
  }

  NARRATOR: [T26] @if chain with comparison on ENGINE VALUE (san), not affection.
  @if (san <= 20) {
    YOU: [T26a] san <= 20 branch.
  } @else @if (san >= 80) {
    YOU: [T26b] san >= 80 branch.
  } @else {
    YOU: [T26c] san middle branch.
  }

  NARRATOR: [T27] @music stop — music should fade to silence.
  @music stop
  @malia shocked

  MAURICIO [eyebrow_raise]: [T28] CHARACTER [pose]: syntax sugar, second instance (Mauricio changes pose + speaks).
  @butterfly "Accepted Mauricio calling her Butterfly again"
  @signal mark EP01_COMPLETE
  NARRATOR: [T28a] EP01_COMPLETE flag set — read by ep02's gate.

  // ================================================================
  // GATE ROUTING PREVIEW — 在真正 @gate 之前，用镜像 @if 链把即将跳转的目的地"叫出来"，方便测试者人眼对照
  // ================================================================
  NARRATOR: [T29] Gate routing preview — conditions evaluated top-to-bottom; the FIRST match decides @next / @end target.

  @if (REJECTIONS >= 3) {
    NARRATOR: [T29a → @end bad_ending] @signal int COUNTER REJECTIONS >= 3 matched → will TERMINATE the story with bad_ending (gate @end leaf, not @next).
  } @else @if (A.fail) {
    NARRATOR: [T29b → main/bad/001:01] choice condition A.fail matched → will jump to bad01.md
  } @else @if (EP01_DEFLECTED) {
    NARRATOR: [T29c → main/bad/001:01] flag condition EP01_DEFLECTED matched → will jump to bad01.md
  } @else @if (affection.easton < 0) {
    NARRATOR: [T29d → main/bad/001:01] comparison affection.easton < 0 matched → will jump to bad01.md
  } @else @if (EP01_COMPLETE && affection.easton >= 3) {
    NARRATOR: [T29e → main/route/easton:01] compound (flag && comparison) matched → will jump to cont01.md
  } @else @if (affection.easton > affection.mauricio) {
    NARRATOR: [T29f → main/route/easton:01] operand-vs-operand (easton > mauricio) matched → will jump to cont01.md
  } @else {
    NARRATOR: [T29g → main/stress:01] no condition matched, fallback @else → will jump to stress.md (then stress's own gate will fall through to ep02.md)
  }

  // 真正的 gate（与上方预告逻辑完全一致，条件顺序 1:1 对应）
  // 演示 @end 与 @next 在同一 gate 内混合
  @gate {
    @if (REJECTIONS >= 3):
      @end bad_ending
    @else @if (A.fail):
      @next main/bad/001:01
    @else @if (EP01_DEFLECTED):
      @next main/bad/001:01
    @else @if (affection.easton < 0):
      @next main/bad/001:01
    @else @if (EP01_COMPLETE && affection.easton >= 3):
      @next main/route/easton:01
    @else @if (affection.easton > affection.mauricio):
      @next main/route/easton:01
    @else:
      @next main/stress:01
  }
}
