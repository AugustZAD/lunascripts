// Feature Parade STRESS — 高强度逻辑压测
// 覆盖: 3 层 @if 嵌套、复合条件括号、5 种 condition 混链、空块边界、作用域交错、brave 省略 else、@trick 全 6 类型、MAX/MIN 聚合、operand-vs-operand 比较

@episode main/stress:01 "Stress Test" {

  @bg set classroom
  &music tense

  NARRATOR: [T50] Stress suite starts — each sub-test announces itself.
  @sfx huh
  NARRATOR: [T50a] @sfx huh — the "huh?" sound effect plays once.

  // ================================================================
  // [T51] 3 层 @if 嵌套
  // ================================================================
  NARRATOR: [T51] Three-level nested @if.
  @if (EP01_FACED_EASTON) {
    NARRATOR: [T51-L1] outer flag true.
    @if (affection.easton >= 3) {
      NARRATOR: [T51-L2] mid comparison true.
      @if (san >= 50) {
        NARRATOR: [T51-L3a] innermost value comparison true — 3 levels deep.
      } @else {
        NARRATOR: [T51-L3b] innermost @else (san < 50).
      }
    } @else @if (affection.easton >= 1) {
      NARRATOR: [T51-M] mid else-if (1 <= affection < 3).
    } @else {
      NARRATOR: [T51-N] mid fallback.
    }
  } @else {
    NARRATOR: [T51-O] outer @else (flag false).
  }

  // ================================================================
  // [T52] 复合条件括号优先级
  // ================================================================
  NARRATOR: [T52] Compound with parenthesized precedence: ((x||y) && (z||w)).
  @if ((A.success || B.any) && (affection.easton >= 2 || EP01_COMPLETE)) {
    NARRATOR: [T52a] outer-AND of two OR groups true.
  }

  NARRATOR: [T53] Union of two AND groups: (a && b) || (c && d).
  @if ((EP01_FACED_EASTON && san > 30) || (EP01_DEFLECTED && affection.easton < 0)) {
    NARRATOR: [T53a] either branch true.
  }

  // ================================================================
  // [T54] 同一 if 链混合全部 5 种 gate-合法 condition（check 在 brave 体内验证）
  // ================================================================
  NARRATOR: [T54] One @if chain mixing choice / flag / comparison-affection / comparison-value / compound — 5 kinds.
  @if (A.fail) {
    NARRATOR: [T54a] choice condition branch.
  } @else @if (EP01_COMPLETE) {
    NARRATOR: [T54b] flag condition branch.
  } @else @if (STRESS_COUNT >= 1) {
    NARRATOR: [T54c] signal-int comparison branch (replaces removed influence-kind).
  } @else @if (affection.easton >= 1) {
    NARRATOR: [T54d] comparison on affection.
  } @else @if (san <= 50) {
    NARRATOR: [T54e] comparison on engine value.
  } @else @if (A.any && san > 0) {
    NARRATOR: [T54f] compound of choice && comparison.
  } @else {
    NARRATOR: [T54g] fall-through @else.
  }

  // ================================================================
  // [T54x] MAX/MIN 聚合 + operand-vs-operand 比较
  // ================================================================
  NARRATOR: [T54x] MAX/MIN aggregate operand — 2-arg, 3-arg, 4-arg, mixed-kind, recursive nesting.

  @if (MAX(affection.easton, affection.mauricio) >= 3) {
    NARRATOR: [T54x-a] 2-arg MAX over two affections.
  }

  @if (MIN(affection.easton, affection.mauricio, affection.elias) >= 1) {
    NARRATOR: [T54x-b] 3-arg MIN over three affections.
  }

  @if (MAX(affection.easton, affection.mauricio, affection.elias, affection.josie) >= 5) {
    NARRATOR: [T54x-c] 4-arg MAX over four affections.
  }

  @if (MAX(affection.easton, san, 3) >= 4) {
    NARRATOR: [T54x-d] mixed-kind MAX (affection + value + literal).
  }

  @if (MAX(affection.easton, MIN(affection.mauricio, affection.elias)) >= 2) {
    NARRATOR: [T54x-e] recursive nesting — MAX of (affection, MIN(...)).
  }

  // operand-vs-operand: 两侧都是变量
  @if (affection.easton > affection.mauricio) {
    NARRATOR: [T54x-f] affection vs affection comparison.
  }

  // operand-vs-operand: 聚合 vs 聚合
  @if (MAX(affection.easton, affection.mauricio) > MIN(affection.elias, affection.josie)) {
    NARRATOR: [T54x-g] MAX vs MIN comparison — both sides aggregate.
  }

  // 字面量在左、变量在右
  @if (5 < affection.easton) {
    NARRATOR: [T54x-h] literal-left comparison.
  }

  // ================================================================
  // [T55] minigame 单条 leaf — 验证 @minigame 为 leaf 指令（无 body、无 rating）
  // ================================================================
  NARRATOR: [T55] @minigame power_swing — leaf shape. Prose seeds the vibe-coding agent; engine owns rewards; per-rating narrative removed.
  @minigame power_swing "Mauricio drags Malia to the baseball cage at lunch. She has to hit three pitches off the machine while he calls the count. The player taps Swing at the exact moment the pitch crosses the strike zone; mistime and the ball clips foul. Three pitches, two hits to clear."

  NARRATOR: [T59] Minigame roundup — three more leaf minigames covering different scenes. Scene + simple gameplay all in the prose; vibe-coding agent generates each.
  @minigame slot_machine "Mark drags everyone to the boardwalk arcade. Malia pulls the lever on a vintage slot machine — taps Hold on each reel to lock symbols, taps Spin to roll the rest, chasing matching trios."
  @minigame stardew_fishing "Friday afternoon at the lake with Elias. The player drags the catch icon into a moving zone to keep it inside the bar; let it slip and the line snaps. Catch one fish, the conversation actually starts."
  @minigame survive_30_seconds "Late-night dodgeball in the gym — lights flicker, balls fly. Player swipes left/right to dodge hazards for thirty seconds. Take three hits and Malia's out."

  // ================================================================
  // [T55t] @trick 全 6 类型 — 触摸 3 / 运动 3
  // ================================================================
  NARRATOR: [T55t] @trick suite — every locked type appears once; each is a mandatory body-interaction beat.
  @trick tap "Tap the screen to keep your hand from shaking."
  @trick hold "Hold your breath — count to five."
  @trick swipe "Wipe the steam off the mirror."
  @trick shake "Shake the bottle hard."
  @trick swing "Swing the bat through the strike zone."
  @trick tilt "Peek around the corner — is he still there?"

  // ================================================================
  // [T56] brave option 省略 @else（validator 宽松）+ safe option 嵌套 @if
  // ================================================================
  @bg set hallway fade
  &music upbeat
  &sfx bell
  &malia flat

  NARRATOR: [T56] Choice stress: brave omits @else; safe nests an @if.
  @choice {
    @option A brave "[T56-brave] Take the risk — no @else branch." {
      check {
        attr: WIL
        dc: 18
      }
      @if (check.success) {
        NARRATOR: [T56a] brave check.success — no paired @else (allowed).
        @affection easton +1
      }
    }
    @option B safe "[T56-safe] Walk away — contains nested @if." {
      @if (affection.easton >= 2) {
        YOU: [T56b] safe body nested @if true.
        @butterfly "Walked away but hesitated"
      } @else {
        YOU: [T56c] safe body nested @else.
      }
    }
  }

  // ================================================================
  // [T57] 单消息手机块（最小非空边界）
  // ================================================================
  NARRATOR: [T57] @phone block with a single message — minimum non-empty edge case.
  @phone {
    @text from EASTON: Are you there?
  }

  // ================================================================
  // [T58] 并发组边界: 连续 @ / & / 对话交替
  // ================================================================
  @bg set gym cut
  &josie excited

  NARRATOR: [T58] Concurrent-group boundary test: dialogue breaks the group above; new @ below starts a fresh group.

  @pause
  NARRATOR: [T58a] @pause — single click to advance.

  @signal mark STRESS_DONE

  // ================================================================
  // [T58b] @signal int — persistent integer counter (assign / +/ -)
  // ================================================================
  NARRATOR: [T58b] @signal int — three write forms plus a comparison read.
  @signal int STRESS_COUNT = 0
  @signal int STRESS_COUNT +2
  @signal int STRESS_COUNT -1
  @if (STRESS_COUNT >= 2) {
    NARRATOR: [T58b-hi] STRESS_COUNT crossed the 2 threshold.
  } @else {
    NARRATOR: [T58b-lo] STRESS_COUNT below threshold.
  }

  NARRATOR: [T60 → main:02] Stress gate has a single unconditional leaf — jumps to ep02 unconditionally.
  @gate {
    @next main:02
  }
}
