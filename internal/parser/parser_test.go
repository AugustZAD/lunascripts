package parser

import (
	"strings"
	"testing"

	"github.com/cdotlock/lunascripts/internal/ast"
	"github.com/cdotlock/lunascripts/internal/lexer"
)

// helper parses src and returns the Episode or fails the test.
func parseOrFail(t *testing.T, src string) *ast.Episode {
	t.Helper()
	l := lexer.New(src)
	p := New(l)
	ep, err := p.Parse()
	if err != nil {
		t.Fatalf("Parse error: %v", err)
	}
	return ep
}

// parseSource parses src and returns (episode, err) without failing the
// test. Used by negative tests that assert a specific parse-error hint.
func parseSource(src string) (*ast.Episode, error) {
	l := lexer.New(src)
	p := New(l)
	return p.Parse()
}

// =============================================================================
// Episode-level basics
// =============================================================================

// TestParseMinimal verifies a minimal episode with bg, narrator, you, and a
// terminal gate.
func TestParseMinimal(t *testing.T) {
	src := `@episode main:01 "Test" {
	@bg set classroom fade
	NARRATOR: Hello.
	YOU: Thinking.
	@gate {
		@next main:02
	}
}`
	ep := parseOrFail(t, src)

	if ep.BranchKey != "main:01" {
		t.Errorf("BranchKey: got %q, want %q", ep.BranchKey, "main:01")
	}
	if ep.Title != "Test" {
		t.Errorf("Title: got %q, want %q", ep.Title, "Test")
	}
	if len(ep.Body) != 3 {
		t.Fatalf("Body length: got %d, want 3", len(ep.Body))
	}

	// Node 0: BgSetNode
	bg, ok := ep.Body[0].(*ast.BgSetNode)
	if !ok {
		t.Fatalf("Body[0]: expected *BgSetNode, got %T", ep.Body[0])
	}
	if bg.Name != "classroom" {
		t.Errorf("BgSetNode.Name: got %q, want %q", bg.Name, "classroom")
	}
	if bg.Transition != "fade" {
		t.Errorf("BgSetNode.Transition: got %q, want %q", bg.Transition, "fade")
	}

	// Node 1: NarratorNode
	narr, ok := ep.Body[1].(*ast.NarratorNode)
	if !ok {
		t.Fatalf("Body[1]: expected *NarratorNode, got %T", ep.Body[1])
	}
	if narr.Text != "Hello." {
		t.Errorf("NarratorNode.Text: got %q, want %q", narr.Text, "Hello.")
	}

	// Node 2: YouNode
	you, ok := ep.Body[2].(*ast.YouNode)
	if !ok {
		t.Fatalf("Body[2]: expected *YouNode, got %T", ep.Body[2])
	}
	if you.Text != "Thinking." {
		t.Errorf("YouNode.Text: got %q, want %q", you.Text, "Thinking.")
	}

	// Gate
	if ep.Gate == nil {
		t.Fatal("Gate: expected non-nil")
	}
	if len(ep.Gate.Routes) != 1 {
		t.Fatalf("Gate.Routes count: got %d, want 1", len(ep.Gate.Routes))
	}
	def := ep.Gate.Routes[0]
	if def.Condition != nil {
		t.Errorf("GateRoute.Condition: got %v, want nil", def.Condition)
	}
	next, ok := def.Leaf.(*ast.NextLeaf)
	if !ok {
		t.Fatalf("GateRoute.Leaf: expected *NextLeaf, got %T", def.Leaf)
	}
	if next.Target != "main:02" {
		t.Errorf("NextLeaf.Target: got %q, want %q", next.Target, "main:02")
	}

	// Standalone @ending is no longer a source-level construct; the parser
	// never sets Episode.Ending.
	if ep.Ending != nil {
		t.Errorf("Ending: got %+v, want nil (parser never sets Ending)", ep.Ending)
	}
}

// =============================================================================
// Character directives — show / bubble + dialogue sugar
// =============================================================================

// TestParseCharShowAndBubble covers `@<char> <pose>` (no position, with and
// without trailing transition) plus `@<char> bubble <type>`.
func TestParseCharShowAndBubble(t *testing.T) {
	src := `@episode main:01 "Chars" {
	@mauricio neutral_smirk
	@mauricio angry fade
	@mauricio bubble heart
	MAURICIO: Hey there.
	@gate { @next main:02 }
}`
	ep := parseOrFail(t, src)

	if len(ep.Body) != 4 {
		t.Fatalf("Body length: got %d, want 4", len(ep.Body))
	}

	// show without transition
	show0, ok := ep.Body[0].(*ast.CharShowNode)
	if !ok {
		t.Fatalf("Body[0]: expected *CharShowNode, got %T", ep.Body[0])
	}
	if show0.Char != "mauricio" || show0.Look != "neutral_smirk" {
		t.Errorf("CharShowNode[0]: got char=%q look=%q, want mauricio/neutral_smirk", show0.Char, show0.Look)
	}
	if show0.Transition != "" {
		t.Errorf("CharShowNode[0].Transition: got %q, want empty", show0.Transition)
	}

	// show with trailing transition
	show1, ok := ep.Body[1].(*ast.CharShowNode)
	if !ok {
		t.Fatalf("Body[1]: expected *CharShowNode, got %T", ep.Body[1])
	}
	if show1.Char != "mauricio" || show1.Look != "angry" || show1.Transition != "fade" {
		t.Errorf("CharShowNode[1]: got char=%q look=%q transition=%q",
			show1.Char, show1.Look, show1.Transition)
	}

	// bubble
	bubble, ok := ep.Body[2].(*ast.CharBubbleNode)
	if !ok {
		t.Fatalf("Body[2]: expected *CharBubbleNode, got %T", ep.Body[2])
	}
	if bubble.Char != "mauricio" || bubble.BubbleType != "heart" {
		t.Errorf("CharBubbleNode: got char=%q type=%q, want mauricio/heart", bubble.Char, bubble.BubbleType)
	}

	// dialogue
	dlg, ok := ep.Body[3].(*ast.DialogueNode)
	if !ok {
		t.Fatalf("Body[3]: expected *DialogueNode, got %T", ep.Body[3])
	}
	if dlg.Character != "MAURICIO" || dlg.Text != "Hey there." {
		t.Errorf("DialogueNode: got char=%q text=%q", dlg.Character, dlg.Text)
	}
}

// TestParseCharBubbleAllTypes verifies all 9 locked bubble types parse.
func TestParseCharBubbleAllTypes(t *testing.T) {
	for _, bt := range []string{"anger", "sweat", "heart", "question", "exclaim", "idea", "music", "doom", "ellipsis"} {
		t.Run(bt, func(t *testing.T) {
			src := "@episode main:01 \"T\" { @mauricio bubble " + bt + "\n@gate { @next main:02 } }"
			ep := parseOrFail(t, src)
			bub, ok := ep.Body[0].(*ast.CharBubbleNode)
			if !ok {
				t.Fatalf("Body[0]: expected *CharBubbleNode, got %T", ep.Body[0])
			}
			if bub.BubbleType != bt {
				t.Errorf("BubbleType: got %q, want %q", bub.BubbleType, bt)
			}
		})
	}
}

// TestParseCharBubbleRejectsInvalidType ensures bubble validates the 9-way
// whitelist.
func TestParseCharBubbleRejectsInvalidType(t *testing.T) {
	src := `@episode main:01 "T" {
	@mauricio bubble laughing
	@gate { @next main:02 }
}`
	_, err := parseSource(src)
	if err == nil {
		t.Fatal("expected parse error for invalid bubble type, got nil")
	}
	if !strings.Contains(err.Error(), "invalid bubble type") {
		t.Errorf("error should mention invalid bubble type, got: %v", err)
	}
}

// TestParseCharBubbleRequiresType ensures `@<char> bubble` without a type
// argument fails.
func TestParseCharBubbleRequiresType(t *testing.T) {
	// Bubble keyword at end-of-line before next directive: the parser sees
	// `@gate` instead of an IDENT type — that's an error.
	src := `@episode main:01 "T" {
	@mauricio bubble
	@gate { @next main:02 }
}`
	_, err := parseSource(src)
	if err == nil {
		t.Fatal("expected parse error for bubble without type, got nil")
	}
}

// =============================================================================
// Dialogue sugar — CHARACTER [pose]: text
// =============================================================================

// TestParseDialogueWithExpr verifies the syntax sugar
// `CHARACTER [pose_expr]: text` expands to CharShowNode + DialogueNode.
func TestParseDialogueWithExpr(t *testing.T) {
	src := `@episode main:01 "Test" {
  MAURICIO [arms_crossed_angry]: Your call, Butterfly.
  @gate { @next main:02 }
}`
	ep := parseOrFail(t, src)

	if len(ep.Body) != 2 {
		t.Fatalf("Body length: got %d, want 2 (CharShowNode + DialogueNode)", len(ep.Body))
	}

	show, ok := ep.Body[0].(*ast.CharShowNode)
	if !ok {
		t.Fatalf("Body[0]: expected *CharShowNode, got %T", ep.Body[0])
	}
	if show.Char != "mauricio" {
		t.Errorf("CharShowNode.Char: got %q, want %q", show.Char, "mauricio")
	}
	if show.Look != "arms_crossed_angry" {
		t.Errorf("CharShowNode.Look: got %q, want %q", show.Look, "arms_crossed_angry")
	}

	dlg, ok := ep.Body[1].(*ast.DialogueNode)
	if !ok {
		t.Fatalf("Body[1]: expected *DialogueNode, got %T", ep.Body[1])
	}
	if dlg.Character != "MAURICIO" || dlg.Text != "Your call, Butterfly." {
		t.Errorf("DialogueNode: got char=%q text=%q", dlg.Character, dlg.Text)
	}
}

// TestParseYouWithExpr verifies YOU [pose]: text expands to CharShowNode +
// YouNode.
func TestParseYouWithExpr(t *testing.T) {
	src := `@episode main:01 "Test" {
  YOU [thinking]: Why is he looking at me like that?
  @gate { @next main:02 }
}`
	ep := parseOrFail(t, src)

	if len(ep.Body) != 2 {
		t.Fatalf("Body length: got %d, want 2", len(ep.Body))
	}
	show, ok := ep.Body[0].(*ast.CharShowNode)
	if !ok {
		t.Fatalf("Body[0]: expected *CharShowNode, got %T", ep.Body[0])
	}
	if show.Char != "you" || show.Look != "thinking" {
		t.Errorf("CharShowNode: char=%q look=%q, want you/thinking", show.Char, show.Look)
	}
	you, ok := ep.Body[1].(*ast.YouNode)
	if !ok {
		t.Fatalf("Body[1]: expected *YouNode, got %T", ep.Body[1])
	}
	if you.Text != "Why is he looking at me like that?" {
		t.Errorf("YouNode.Text: got %q", you.Text)
	}
}

// TestParseNarratorWithExpr verifies NARRATOR [pose]: text expands to
// CharShowNode + NarratorNode.
func TestParseNarratorWithExpr(t *testing.T) {
	src := `@episode main:01 "Test" {
  NARRATOR [somber]: Three days passed without a word.
  @gate { @next main:02 }
}`
	ep := parseOrFail(t, src)
	if len(ep.Body) != 2 {
		t.Fatalf("Body length: got %d, want 2", len(ep.Body))
	}
	show, ok := ep.Body[0].(*ast.CharShowNode)
	if !ok {
		t.Fatalf("Body[0]: expected *CharShowNode, got %T", ep.Body[0])
	}
	if show.Char != "narrator" || show.Look != "somber" {
		t.Errorf("CharShowNode: char=%q look=%q, want narrator/somber", show.Char, show.Look)
	}
	narr, ok := ep.Body[1].(*ast.NarratorNode)
	if !ok {
		t.Fatalf("Body[1]: expected *NarratorNode, got %T", ep.Body[1])
	}
	if narr.Text != "Three days passed without a word." {
		t.Errorf("NarratorNode.Text: got %q", narr.Text)
	}
}

// TestParseDialogueWithExprFollowedByMore verifies nodes after the syntax
// sugar are parsed correctly (pending is drained, then parsing continues).
func TestParseDialogueWithExprFollowedByMore(t *testing.T) {
	src := `@episode main:01 "Test" {
  MAURICIO [arms_crossed_angry]: Your call, Butterfly.
  NARRATOR: She turned away.
  @gate { @next main:02 }
}`
	ep := parseOrFail(t, src)

	if len(ep.Body) != 3 {
		t.Fatalf("Body length: got %d, want 3", len(ep.Body))
	}
	if _, ok := ep.Body[0].(*ast.CharShowNode); !ok {
		t.Fatalf("Body[0]: expected *CharShowNode, got %T", ep.Body[0])
	}
	if _, ok := ep.Body[1].(*ast.DialogueNode); !ok {
		t.Fatalf("Body[1]: expected *DialogueNode, got %T", ep.Body[1])
	}
	narr, ok := ep.Body[2].(*ast.NarratorNode)
	if !ok {
		t.Fatalf("Body[2]: expected *NarratorNode, got %T", ep.Body[2])
	}
	if narr.Text != "She turned away." {
		t.Errorf("NarratorNode.Text: got %q", narr.Text)
	}
}

// =============================================================================
// Audio directives
// =============================================================================

// TestParseAudio covers the new audio surface: @music <name>, @music stop,
// and @sfx <name>.
func TestParseAudio(t *testing.T) {
	src := `@episode main:01 "Audio" {
	@music theme_main
	@sfx door_open
	@music stop
	@gate { @next main:02 }
}`
	ep := parseOrFail(t, src)

	if len(ep.Body) != 3 {
		t.Fatalf("Body length: got %d, want 3", len(ep.Body))
	}

	// @music <name> → MusicSetNode
	mp, ok := ep.Body[0].(*ast.MusicSetNode)
	if !ok {
		t.Fatalf("Body[0]: expected *MusicSetNode, got %T", ep.Body[0])
	}
	if mp.Name != "theme_main" {
		t.Errorf("MusicSetNode.Name: got %q, want %q", mp.Name, "theme_main")
	}

	// @sfx <name> → SfxNode
	sfx, ok := ep.Body[1].(*ast.SfxNode)
	if !ok {
		t.Fatalf("Body[1]: expected *SfxNode, got %T", ep.Body[1])
	}
	if sfx.Name != "door_open" {
		t.Errorf("SfxNode.Name: got %q, want %q", sfx.Name, "door_open")
	}

	// @music stop → MusicStopNode
	if _, ok := ep.Body[2].(*ast.MusicStopNode); !ok {
		t.Fatalf("Body[2]: expected *MusicStopNode, got %T", ep.Body[2])
	}
}

// =============================================================================
// State-change directives
// =============================================================================

// TestParseStateChanges covers @affection, @signal mark, and @butterfly.
func TestParseStateChanges(t *testing.T) {
	src := `@episode main:01 "State" {
	@affection mauricio +2
	@signal mark EP01_COMPLETE
	@butterfly "Player chose kindness"
	@gate { @next main:02 }
}`
	ep := parseOrFail(t, src)

	if len(ep.Body) != 3 {
		t.Fatalf("Body length: got %d, want 3", len(ep.Body))
	}

	aff, ok := ep.Body[0].(*ast.AffectionNode)
	if !ok {
		t.Fatalf("Body[0]: expected *AffectionNode, got %T", ep.Body[0])
	}
	if aff.Char != "mauricio" || aff.Delta != "+2" {
		t.Errorf("AffectionNode: got char=%q delta=%q", aff.Char, aff.Delta)
	}

	sig, ok := ep.Body[1].(*ast.SignalNode)
	if !ok {
		t.Fatalf("Body[1]: expected *SignalNode, got %T", ep.Body[1])
	}
	if sig.Kind != ast.SignalKindMark {
		t.Errorf("SignalNode.Kind: got %q, want %q", sig.Kind, ast.SignalKindMark)
	}
	if sig.Event != "EP01_COMPLETE" {
		t.Errorf("SignalNode.Event: got %q, want %q", sig.Event, "EP01_COMPLETE")
	}

	btf, ok := ep.Body[2].(*ast.ButterflyNode)
	if !ok {
		t.Fatalf("Body[2]: expected *ButterflyNode, got %T", ep.Body[2])
	}
	if btf.Description != "Player chose kindness" {
		t.Errorf("ButterflyNode.Description: got %q", btf.Description)
	}
}

// TestParseAffectionNegative covers a negative affection delta.
func TestParseAffectionNegative(t *testing.T) {
	src := `@episode main:01 "T" {
		@affection mauricio -5
		@gate { @next main:02 }
	}`
	ep := parseOrFail(t, src)
	aff := ep.Body[0].(*ast.AffectionNode)
	if aff.Delta != "-5" {
		t.Errorf("Delta: got %q, want -5", aff.Delta)
	}
}

// TestParseSignalString covers @signal mark with a quoted event name.
func TestParseSignalString(t *testing.T) {
	src := `@episode main:01 "T" {
		@signal mark "EP01_COMPLETE"
		@gate { @next main:02 }
	}`
	ep := parseOrFail(t, src)
	sig := ep.Body[0].(*ast.SignalNode)
	if sig.Kind != ast.SignalKindMark || sig.Event != "EP01_COMPLETE" {
		t.Errorf("Signal: kind=%q event=%q", sig.Kind, sig.Event)
	}
}

// TestParseSignalMissingKind verifies @signal without a kind fails.
func TestParseSignalMissingKind(t *testing.T) {
	src := `@episode main:01 "T" {
		@signal EP01_COMPLETE
		@gate { @next main:02 }
	}`
	_, err := parseSource(src)
	if err == nil {
		t.Fatal("expected parse error for @signal without kind")
	}
}

// TestParseSignalInvalidKind verifies @signal with an unknown kind token fails.
func TestParseSignalInvalidKind(t *testing.T) {
	src := `@episode main:01 "T" {
		@signal foo EP01_COMPLETE
		@gate { @next main:02 }
	}`
	_, err := parseSource(src)
	if err == nil {
		t.Fatal("expected parse error for invalid signal kind")
	}
	if !strings.Contains(err.Error(), "invalid signal kind") {
		t.Errorf("error should mention invalid kind, got: %v", err)
	}
}

// TestParseSignalIntAssign covers `@signal int <name> = N` (including 0 and
// negative values).
func TestParseSignalIntAssign(t *testing.T) {
	cases := []struct {
		name   string
		src    string
		expect int
	}{
		{"zero", `@signal int REJECTIONS = 0`, 0},
		{"positive", `@signal int REJECTIONS = 5`, 5},
		{"negative", `@signal int x = -3`, -3},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			src := "@episode main:01 \"t\" {\n" + c.src + "\n@gate { @next main:02 } }"
			ep := parseOrFail(t, src)
			sig := ep.Body[0].(*ast.SignalNode)
			if sig.Kind != ast.SignalKindInt || sig.Op != ast.SignalOpAssign || sig.Value != c.expect {
				t.Errorf("Signal: kind=%q op=%q value=%d, want int/=/%d", sig.Kind, sig.Op, sig.Value, c.expect)
			}
		})
	}
}

// TestParseSignalIntAdd covers `@signal int <name> +N`.
func TestParseSignalIntAdd(t *testing.T) {
	src := `@episode main:01 "t" {
@signal int REJECTIONS +1
@gate { @next main:02 }
}`
	ep := parseOrFail(t, src)
	sig := ep.Body[0].(*ast.SignalNode)
	if sig.Op != ast.SignalOpAdd || sig.Value != 1 || sig.Name != "REJECTIONS" {
		t.Errorf("got name=%q op=%q value=%d", sig.Name, sig.Op, sig.Value)
	}
}

// TestParseSignalIntSub covers `@signal int <name> -N`.
func TestParseSignalIntSub(t *testing.T) {
	src := `@episode main:01 "t" {
@signal int REJECTIONS -2
@gate { @next main:02 }
}`
	ep := parseOrFail(t, src)
	sig := ep.Body[0].(*ast.SignalNode)
	if sig.Op != ast.SignalOpSub || sig.Value != 2 {
		t.Errorf("got op=%q value=%d", sig.Op, sig.Value)
	}
}

// TestParseSignalIntErrors aggregates the error-path tests for @signal int.
func TestParseSignalIntErrors(t *testing.T) {
	cases := []struct {
		name   string
		src    string
		substr string
	}{
		{"missing name", `@episode main:01 "t" { @signal int @gate { @next main:02 } }`, "expected variable name"},
		{"missing op", "@episode main:01 \"t\" { @signal int REJECTIONS\n@gate { @next main:02 } }", "expected '=', '+N', or '-N'"},
		{"missing value after =", `@episode main:01 "t" { @signal int x = @gate { @next main:02 } }`, "expected integer literal"},
		{"non-integer after =", "@episode main:01 \"t\" { @signal int x = abc\n@gate { @next main:02 } }", "expected integer literal"},
		{"plus-zero rejected", "@episode main:01 \"t\" { @signal int x +0\n@gate { @next main:02 } }", "meaningless"},
		{"float value", "@episode main:01 \"t\" { @signal int x = 3.5\n@gate { @next main:02 } }", "integer literal"},
		{"spaced plus sign", "@episode main:01 \"t\" { @signal int x + 3\n@gate { @next main:02 } }", "no whitespace allowed"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := parseSource(c.src)
			if err == nil {
				t.Fatalf("expected error, got nil")
			}
			if !strings.Contains(err.Error(), c.substr) {
				t.Fatalf("expected error containing %q, got: %v", c.substr, err)
			}
		})
	}
}

// =============================================================================
// Choice / option / brave
// =============================================================================

// TestParseChoice tests a choice with brave (check + @if check.success) and
// safe options.
func TestParseChoice(t *testing.T) {
	src := `@episode main:01 "Choice" {
	@choice {
		@option A brave "Fight the guard" {
			check {
				attr: STR
				dc: 14
			}
			@if (check.success) {
				NARRATOR: You overpower the guard.
			} @else {
				NARRATOR: The guard throws you back.
			}
		}
		@option B safe "Talk it out" {
			NARRATOR: You reason with the guard.
			@affection guard +1
		}
	}
	@gate { @next main:02 }
}`
	ep := parseOrFail(t, src)

	choice, ok := ep.Body[0].(*ast.ChoiceNode)
	if !ok {
		t.Fatalf("Body[0]: expected *ChoiceNode, got %T", ep.Body[0])
	}
	if len(choice.Options) != 2 {
		t.Fatalf("Options count: got %d, want 2", len(choice.Options))
	}

	// Brave option
	optA := choice.Options[0]
	if optA.ID != "A" || optA.Mode != "brave" || optA.Text != "Fight the guard" {
		t.Errorf("Option A: id=%q mode=%q text=%q", optA.ID, optA.Mode, optA.Text)
	}
	if optA.Check == nil {
		t.Fatal("Option A: expected Check non-nil")
	}
	if optA.Check.Attr != "STR" || optA.Check.DC != 14 {
		t.Errorf("Check: attr=%q dc=%d", optA.Check.Attr, optA.Check.DC)
	}
	if len(optA.Body) != 1 {
		t.Fatalf("Body length: got %d, want 1 (single @if)", len(optA.Body))
	}
	ifNode, ok := optA.Body[0].(*ast.IfNode)
	if !ok {
		t.Fatalf("optA.Body[0]: expected *IfNode, got %T", optA.Body[0])
	}
	cc, ok := ifNode.Condition.(*ast.CheckCondition)
	if !ok {
		t.Fatalf("IfNode.Condition: expected *CheckCondition, got %T", ifNode.Condition)
	}
	if cc.Result != "success" {
		t.Errorf("CheckCondition.Result: got %q", cc.Result)
	}
	if len(ifNode.Else) != 1 {
		t.Fatalf("Else length: got %d", len(ifNode.Else))
	}

	// Safe option
	optB := choice.Options[1]
	if optB.ID != "B" || optB.Mode != "safe" {
		t.Errorf("Option B: id=%q mode=%q", optB.ID, optB.Mode)
	}
	if optB.Check != nil {
		t.Error("Option B: expected Check nil for safe")
	}
	if len(optB.Body) != 2 {
		t.Fatalf("Option B body length: got %d, want 2", len(optB.Body))
	}
}

// TestParseBraveOptionWithTrailingBody verifies that a brave option can have
// nodes after the @if/@else tree.
func TestParseBraveOptionWithTrailingBody(t *testing.T) {
	src := `@episode main:01 "T" {
		@choice {
			@option A brave "Fight" {
				check {
					attr: STR
					dc: 14
				}
				@if (check.success) {
					NARRATOR: You win.
				} @else {
					NARRATOR: You lose.
				}
				NARRATOR: The dust settles.
			}
		}
		@gate { @next main:02 }
	}`
	ep := parseOrFail(t, src)
	choice := ep.Body[0].(*ast.ChoiceNode)
	optA := choice.Options[0]
	if len(optA.Body) != 2 {
		t.Fatalf("Body length: got %d, want 2", len(optA.Body))
	}
	if _, ok := optA.Body[0].(*ast.IfNode); !ok {
		t.Fatalf("Body[0]: expected *IfNode, got %T", optA.Body[0])
	}
	narr, ok := optA.Body[1].(*ast.NarratorNode)
	if !ok {
		t.Fatalf("Body[1]: expected *NarratorNode, got %T", optA.Body[1])
	}
	if narr.Text != "The dust settles." {
		t.Errorf("narr text: got %q", narr.Text)
	}
}

// =============================================================================
// Minigame / trick
// =============================================================================

// TestParseMinigame covers the one-liner @minigame <name> "<description>".
func TestParseMinigame(t *testing.T) {
	src := `@episode main:01 "Mini" {
	@minigame casino_showdown "Mauricio drags Malia into a backroom blackjack game. The player taps to draw cards and taps Stand to hold."
	@gate { @next main:02 }
}`
	ep := parseOrFail(t, src)
	mg, ok := ep.Body[0].(*ast.MinigameNode)
	if !ok {
		t.Fatalf("Body[0]: expected *MinigameNode, got %T", ep.Body[0])
	}
	if mg.Name != "casino_showdown" {
		t.Errorf("Name: got %q", mg.Name)
	}
	if !strings.Contains(mg.Description, "blackjack") {
		t.Errorf("Description: missing prose, got %q", mg.Description)
	}
}

// TestParseTrick covers the @trick <type> "<prompt>" one-liner.
func TestParseTrick(t *testing.T) {
	tests := []struct {
		name       string
		src        string
		wantType   string
		wantPrompt string
	}{
		{"tap", `@trick tap "Tap to keep up with his pace."`, "tap", "Tap to keep up with his pace."},
		{"hold", `@trick hold "Hold your breath."`, "hold", "Hold your breath."},
		{"swipe", `@trick swipe "Wipe the fog off the mirror."`, "swipe", "Wipe the fog off the mirror."},
		{"shake", `@trick shake "Shake him awake."`, "shake", "Shake him awake."},
		{"swing", `@trick swing "Cast the line."`, "swing", "Cast the line."},
		{"tilt", `@trick tilt "Peek around the corner."`, "tilt", "Peek around the corner."},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			src := "@episode main:01 \"T\" {\n  " + tt.src + "\n  @gate { @next main:02 }\n}"
			ep := parseOrFail(t, src)
			trick, ok := ep.Body[0].(*ast.TrickNode)
			if !ok {
				t.Fatalf("Body[0]: expected *TrickNode, got %T", ep.Body[0])
			}
			if trick.Type != tt.wantType || trick.Prompt != tt.wantPrompt {
				t.Errorf("got type=%q prompt=%q", trick.Type, trick.Prompt)
			}
		})
	}
}

// TestParseTrickRejectsUnknownType verifies the parser rejects any trick type
// outside the 6-type whitelist.
func TestParseTrickRejectsUnknownType(t *testing.T) {
	for _, ty := range []string{"blink", "nod", "turn-away", "close-eyes", "hold-still"} {
		t.Run(ty, func(t *testing.T) {
			src := "@episode main:01 \"T\" {\n  @trick " + ty + " \"go.\"\n  @gate { @next main:02 }\n}"
			_, err := parseSource(src)
			if err == nil {
				t.Fatal("expected parse error, got nil")
			}
			if !strings.Contains(err.Error(), "invalid @trick type") {
				t.Errorf("error should mention invalid trick type, got: %v", err)
			}
		})
	}
}

// =============================================================================
// Phone / text-message
// =============================================================================

// TestParsePhone tests @phone { @text ... } with only @text children allowed.
func TestParsePhone(t *testing.T) {
	src := `@episode main:01 "Phone" {
	@phone {
		@text from easton: Hey are you free?
		@text to easton: Yeah what's up?
		@text from easton: Meet me at the park.
	}
	@gate { @next main:02 }
}`
	ep := parseOrFail(t, src)

	if len(ep.Body) != 1 {
		t.Fatalf("Body length: got %d, want 1", len(ep.Body))
	}
	phone, ok := ep.Body[0].(*ast.PhoneShowNode)
	if !ok {
		t.Fatalf("Body[0]: expected *PhoneShowNode, got %T", ep.Body[0])
	}
	if len(phone.Body) != 3 {
		t.Fatalf("PhoneShowNode.Body length: got %d, want 3", len(phone.Body))
	}

	msg0 := phone.Body[0].(*ast.TextMessageNode)
	if msg0.Direction != "from" || msg0.Char != "easton" || msg0.Content != "Hey are you free?" {
		t.Errorf("msg0: dir=%q char=%q content=%q", msg0.Direction, msg0.Char, msg0.Content)
	}
	msg1 := phone.Body[1].(*ast.TextMessageNode)
	if msg1.Direction != "to" || msg1.Content != "Yeah what's up?" {
		t.Errorf("msg1: dir=%q content=%q", msg1.Direction, msg1.Content)
	}
	msg2 := phone.Body[2].(*ast.TextMessageNode)
	if msg2.Direction != "from" || msg2.Content != "Meet me at the park." {
		t.Errorf("msg2: dir=%q content=%q", msg2.Direction, msg2.Content)
	}
}

// TestParsePhoneRejectsNonTextChild verifies the @phone whitelist rejects any
// child directive other than @text.
func TestParsePhoneRejectsNonTextChild(t *testing.T) {
	cases := []struct {
		name string
		src  string
	}{
		{"narrator", `@phone {
			NARRATOR: Forbidden.
		}`},
		{"music", `@phone {
			@music theme
		}`},
		{"signal", `@phone {
			@signal mark MARK1
		}`},
		{"if", `@phone {
			@if (flag) {
				@text from easton: Hi.
			}
		}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			src := "@episode main:01 \"T\" {\n" + c.src + "\n@gate { @next main:02 } }"
			_, err := parseSource(src)
			if err == nil {
				t.Fatal("expected parse error for non-@text child in @phone")
			}
			if !strings.Contains(err.Error(), "only @text from/to is allowed") {
				t.Errorf("error should mention text-only whitelist, got: %v", err)
			}
		})
	}
}

// =============================================================================
// Conditions — operands, comparisons, compound, choice, flag, check
// =============================================================================

// TestParseConditionFlag covers @if (BARE_IDENT) → FlagCondition.
func TestParseConditionFlag(t *testing.T) {
	src := `@episode main:01 "T" {
		@if (EP01_COMPLETE) {
			NARRATOR: Done.
		}
		@gate { @next main:02 }
	}`
	ep := parseOrFail(t, src)
	ifNode := ep.Body[0].(*ast.IfNode)
	fc, ok := ifNode.Condition.(*ast.FlagCondition)
	if !ok {
		t.Fatalf("want *FlagCondition, got %T", ifNode.Condition)
	}
	if fc.Name != "EP01_COMPLETE" {
		t.Errorf("Name: got %q", fc.Name)
	}
}

// TestParseConditionChoiceAny tests @if (A.any) — wildcard choice match.
func TestParseConditionChoiceAny(t *testing.T) {
	src := `@episode main:01 "T" {
		@if (A.any) {
			NARRATOR: Done.
		}
		@gate { @next main:02 }
	}`
	ep := parseOrFail(t, src)
	ifNode := ep.Body[0].(*ast.IfNode)
	ch, ok := ifNode.Condition.(*ast.ChoiceCondition)
	if !ok {
		t.Fatalf("want *ChoiceCondition, got %T", ifNode.Condition)
	}
	if ch.Option != "A" || ch.Result != "any" {
		t.Errorf("got Option=%q Result=%q", ch.Option, ch.Result)
	}
}

// TestParseConditionStringRejected verifies that quoted-string conditions are
// rejected — InfluenceCondition was removed.
func TestParseConditionStringRejected(t *testing.T) {
	src := `@episode main:01 "T" {
		@if ("some description") {
			NARRATOR: Hi.
		}
		@gate { @next main:02 }
	}`
	_, err := parseSource(src)
	if err == nil {
		t.Fatal("expected parse error for string-literal condition")
	}
	if !strings.Contains(err.Error(), "string literal not allowed") {
		t.Errorf("error should mention string literal not allowed, got: %v", err)
	}
}

// TestParseConditionCompoundAnd covers @if (a && b).
func TestParseConditionCompoundAnd(t *testing.T) {
	src := `@episode main:01 "T" {
		@if (affection.easton >= 5 && CHA >= 14) {
			NARRATOR: Done.
		}
		@gate { @next main:02 }
	}`
	ep := parseOrFail(t, src)
	ifNode := ep.Body[0].(*ast.IfNode)
	cc, ok := ifNode.Condition.(*ast.CompoundCondition)
	if !ok {
		t.Fatalf("want *CompoundCondition, got %T", ifNode.Condition)
	}
	if cc.Op != "&&" {
		t.Errorf("Op: got %q, want &&", cc.Op)
	}
}

// TestParseConditionCompoundOr covers @if (a || b).
func TestParseConditionCompoundOr(t *testing.T) {
	src := `@episode main:01 "T" {
		@if (flag1 || flag2) {
			NARRATOR: One or the other.
		}
		@gate { @next main:02 }
	}`
	ep := parseOrFail(t, src)
	ifNode := ep.Body[0].(*ast.IfNode)
	cc, ok := ifNode.Condition.(*ast.CompoundCondition)
	if !ok {
		t.Fatalf("want *CompoundCondition, got %T", ifNode.Condition)
	}
	if cc.Op != "||" {
		t.Errorf("Op: got %q, want ||", cc.Op)
	}
}

// TestParseConditionPrecedence verifies && binds tighter than ||.
// `a || b && c` parses as `a || (b && c)`.
func TestParseConditionPrecedence(t *testing.T) {
	src := `@episode main:01 "T" {
		@if (A_FLAG || B_FLAG && C_FLAG) {
			NARRATOR: ok.
		}
		@gate { @next main:02 }
	}`
	ep := parseOrFail(t, src)
	ifNode := ep.Body[0].(*ast.IfNode)
	top, ok := ifNode.Condition.(*ast.CompoundCondition)
	if !ok || top.Op != "||" {
		t.Fatalf("top: got %T op=%s, want *CompoundCondition op=||", ifNode.Condition, conditionOp(ifNode.Condition))
	}
	if _, ok := top.Left.(*ast.FlagCondition); !ok {
		t.Errorf("Left: got %T, want *FlagCondition", top.Left)
	}
	right, ok := top.Right.(*ast.CompoundCondition)
	if !ok || right.Op != "&&" {
		t.Fatalf("Right: got %T op=%s, want *CompoundCondition op=&&", top.Right, conditionOp(top.Right))
	}
}

func conditionOp(c ast.Condition) string {
	if cc, ok := c.(*ast.CompoundCondition); ok {
		return cc.Op
	}
	return ""
}

// TestParseConditionAffectionComparison covers
// `@if (affection.<char> OP literal)`.
func TestParseConditionAffectionComparison(t *testing.T) {
	src := `@episode main:01 "T" {
		@if (affection.easton >= 5) {
			NARRATOR: yes.
		}
		@gate { @next main:02 }
	}`
	ep := parseOrFail(t, src)
	ifNode := ep.Body[0].(*ast.IfNode)
	cmp, ok := ifNode.Condition.(*ast.ComparisonCondition)
	if !ok {
		t.Fatalf("want *ComparisonCondition, got %T", ifNode.Condition)
	}
	if cmp.Left.Kind != ast.OperandAffection || cmp.Left.Char != "easton" {
		t.Errorf("Left: got %+v", cmp.Left)
	}
	if cmp.Op != ">=" {
		t.Errorf("Op: got %q", cmp.Op)
	}
	if cmp.Right.Kind != ast.OperandLiteral || cmp.Right.Value != 5 {
		t.Errorf("Right: got %+v, want literal/5", cmp.Right)
	}
}

// TestParseConditionValueComparison covers `@if (san <= 20)` — bare IDENT left,
// literal right.
func TestParseConditionValueComparison(t *testing.T) {
	src := `@episode main:01 "T" {
		@if (san <= 20) {
			NARRATOR: ouch.
		}
		@gate { @next main:02 }
	}`
	ep := parseOrFail(t, src)
	ifNode := ep.Body[0].(*ast.IfNode)
	cmp, ok := ifNode.Condition.(*ast.ComparisonCondition)
	if !ok {
		t.Fatalf("want *ComparisonCondition, got %T", ifNode.Condition)
	}
	if cmp.Left.Kind != ast.OperandValue || cmp.Left.Name != "san" {
		t.Errorf("Left: got %+v", cmp.Left)
	}
	if cmp.Op != "<=" {
		t.Errorf("Op: got %q", cmp.Op)
	}
	if cmp.Right.Kind != ast.OperandLiteral || cmp.Right.Value != 20 {
		t.Errorf("Right: got %+v, want literal/20", cmp.Right)
	}
}

// TestParseConditionLiteralLeftComparison covers `5 < affection.easton` —
// literal-on-left, operand-on-right.
func TestParseConditionLiteralLeftComparison(t *testing.T) {
	src := `@episode main:01 "T" {
		@if (5 < affection.easton) {
			NARRATOR: high.
		}
		@gate { @next main:02 }
	}`
	ep := parseOrFail(t, src)
	ifNode := ep.Body[0].(*ast.IfNode)
	cmp, ok := ifNode.Condition.(*ast.ComparisonCondition)
	if !ok {
		t.Fatalf("want *ComparisonCondition, got %T", ifNode.Condition)
	}
	if cmp.Left.Kind != ast.OperandLiteral || cmp.Left.Value != 5 {
		t.Errorf("Left: got %+v, want literal/5", cmp.Left)
	}
	if cmp.Op != "<" {
		t.Errorf("Op: got %q", cmp.Op)
	}
	if cmp.Right.Kind != ast.OperandAffection || cmp.Right.Char != "easton" {
		t.Errorf("Right: got %+v, want affection/easton", cmp.Right)
	}
}

// TestParseConditionValueToValueComparison covers `<value> OP <value>` —
// both sides are bare-name operands.
func TestParseConditionValueToValueComparison(t *testing.T) {
	src := `@episode main:01 "T" {
		@if (san >= REJECTIONS) {
			NARRATOR: ok.
		}
		@gate { @next main:02 }
	}`
	ep := parseOrFail(t, src)
	ifNode := ep.Body[0].(*ast.IfNode)
	cmp, ok := ifNode.Condition.(*ast.ComparisonCondition)
	if !ok {
		t.Fatalf("want *ComparisonCondition, got %T", ifNode.Condition)
	}
	if cmp.Left.Kind != ast.OperandValue || cmp.Left.Name != "san" {
		t.Errorf("Left: got %+v", cmp.Left)
	}
	if cmp.Right.Kind != ast.OperandValue || cmp.Right.Name != "REJECTIONS" {
		t.Errorf("Right: got %+v", cmp.Right)
	}
}

// TestParseConditionWithEqualsAndNotEquals covers == and !=.
func TestParseConditionWithEqualsAndNotEquals(t *testing.T) {
	for _, op := range []string{"==", "!="} {
		t.Run(op, func(t *testing.T) {
			src := "@episode main:01 \"T\" {\n@if (a " + op + " 1) {\nNARRATOR: ok.\n}\n@gate { @next main:02 }\n}"
			ep := parseOrFail(t, src)
			cmp := ep.Body[0].(*ast.IfNode).Condition.(*ast.ComparisonCondition)
			if cmp.Op != op {
				t.Errorf("Op: got %q, want %q", cmp.Op, op)
			}
			if cmp.Right.Kind != ast.OperandLiteral || cmp.Right.Value != 1 {
				t.Errorf("Right: got %+v, want literal/1", cmp.Right)
			}
		})
	}
}

// =============================================================================
// parseOperand — all 5 kinds, plus aggregates
// =============================================================================

// TestParseOperandKindLiteral verifies integer literals (positive, negative).
func TestParseOperandKindLiteral(t *testing.T) {
	cases := []struct {
		name   string
		op     string
		val    string
		expect int
	}{
		{"positive", ">=", "5", 5},
		{"negative", ">=", "-3", -3},
		{"zero", "==", "0", 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			src := "@episode main:01 \"T\" {\n@if (x " + c.op + " " + c.val + ") {\nNARRATOR: hi.\n}\n@gate { @next main:02 }\n}"
			ep := parseOrFail(t, src)
			cmp := ep.Body[0].(*ast.IfNode).Condition.(*ast.ComparisonCondition)
			if cmp.Right.Kind != ast.OperandLiteral || cmp.Right.Value != c.expect {
				t.Errorf("Right: got %+v, want literal/%d", cmp.Right, c.expect)
			}
		})
	}
}

// TestParseOperandKindAffection verifies affection.<char> operand.
func TestParseOperandKindAffection(t *testing.T) {
	src := `@episode main:01 "T" {
		@if (affection.diego > 0) {
			NARRATOR: hi.
		}
		@gate { @next main:02 }
	}`
	ep := parseOrFail(t, src)
	cmp := ep.Body[0].(*ast.IfNode).Condition.(*ast.ComparisonCondition)
	if cmp.Left.Kind != ast.OperandAffection {
		t.Fatalf("Left.Kind: got %q, want affection", cmp.Left.Kind)
	}
	if cmp.Left.Char != "diego" {
		t.Errorf("Left.Char: got %q, want diego", cmp.Left.Char)
	}
}

// TestParseOperandKindValue verifies bare-IDENT value operand.
func TestParseOperandKindValue(t *testing.T) {
	src := `@episode main:01 "T" {
		@if (REJECTIONS > 3) {
			NARRATOR: hi.
		}
		@gate { @next main:02 }
	}`
	ep := parseOrFail(t, src)
	cmp := ep.Body[0].(*ast.IfNode).Condition.(*ast.ComparisonCondition)
	if cmp.Left.Kind != ast.OperandValue {
		t.Fatalf("Left.Kind: got %q, want value", cmp.Left.Kind)
	}
	if cmp.Left.Name != "REJECTIONS" {
		t.Errorf("Left.Name: got %q", cmp.Left.Name)
	}
}

// TestParseOperandKindMaxBasic verifies MAX(...) with 2 args.
func TestParseOperandKindMaxBasic(t *testing.T) {
	src := `@episode main:01 "T" {
		@if (MAX(affection.easton, affection.diego) >= 5) {
			NARRATOR: hi.
		}
		@gate { @next main:02 }
	}`
	ep := parseOrFail(t, src)
	cmp := ep.Body[0].(*ast.IfNode).Condition.(*ast.ComparisonCondition)
	if cmp.Left.Kind != ast.OperandMax {
		t.Fatalf("Left.Kind: got %q, want max", cmp.Left.Kind)
	}
	if len(cmp.Left.Args) != 2 {
		t.Fatalf("Args len: got %d, want 2", len(cmp.Left.Args))
	}
	if cmp.Left.Args[0].Kind != ast.OperandAffection || cmp.Left.Args[0].Char != "easton" {
		t.Errorf("Args[0]: got %+v", cmp.Left.Args[0])
	}
	if cmp.Left.Args[1].Kind != ast.OperandAffection || cmp.Left.Args[1].Char != "diego" {
		t.Errorf("Args[1]: got %+v", cmp.Left.Args[1])
	}
}

// TestParseOperandKindMinBasic verifies MIN(...) with 2 args.
func TestParseOperandKindMinBasic(t *testing.T) {
	src := `@episode main:01 "T" {
		@if (MIN(affection.easton, affection.diego) <= 0) {
			NARRATOR: hi.
		}
		@gate { @next main:02 }
	}`
	ep := parseOrFail(t, src)
	cmp := ep.Body[0].(*ast.IfNode).Condition.(*ast.ComparisonCondition)
	if cmp.Left.Kind != ast.OperandMin {
		t.Fatalf("Left.Kind: got %q, want min", cmp.Left.Kind)
	}
	if len(cmp.Left.Args) != 2 {
		t.Fatalf("Args len: got %d, want 2", len(cmp.Left.Args))
	}
}

// TestParseAggregateOperandThreeArgs verifies MAX(...) with 3 args.
func TestParseAggregateOperandThreeArgs(t *testing.T) {
	src := `@episode main:01 "T" {
		@if (MAX(affection.easton, affection.diego, affection.mauricio) >= 3) {
			NARRATOR: hi.
		}
		@gate { @next main:02 }
	}`
	ep := parseOrFail(t, src)
	cmp := ep.Body[0].(*ast.IfNode).Condition.(*ast.ComparisonCondition)
	if cmp.Left.Kind != ast.OperandMax {
		t.Fatalf("Kind: got %q, want max", cmp.Left.Kind)
	}
	if len(cmp.Left.Args) != 3 {
		t.Fatalf("Args len: got %d, want 3", len(cmp.Left.Args))
	}
}

// TestParseAggregateOperandFourArgs verifies MAX(...) with 4 args.
func TestParseAggregateOperandFourArgs(t *testing.T) {
	src := `@episode main:01 "T" {
		@if (MAX(affection.easton, affection.diego, affection.mauricio, affection.elias) >= 8) {
			NARRATOR: hi.
		}
		@gate { @next main:02 }
	}`
	ep := parseOrFail(t, src)
	cmp := ep.Body[0].(*ast.IfNode).Condition.(*ast.ComparisonCondition)
	if len(cmp.Left.Args) != 4 {
		t.Fatalf("Args len: got %d, want 4", len(cmp.Left.Args))
	}
}

// TestParseAggregateOperandMixedKinds covers MAX(literal, value, affection.<char>) —
// args can be any operand kind.
func TestParseAggregateOperandMixedKinds(t *testing.T) {
	src := `@episode main:01 "T" {
		@if (MAX(5, san, affection.easton) >= 10) {
			NARRATOR: hi.
		}
		@gate { @next main:02 }
	}`
	ep := parseOrFail(t, src)
	cmp := ep.Body[0].(*ast.IfNode).Condition.(*ast.ComparisonCondition)
	if len(cmp.Left.Args) != 3 {
		t.Fatalf("Args len: got %d, want 3", len(cmp.Left.Args))
	}
	if cmp.Left.Args[0].Kind != ast.OperandLiteral || cmp.Left.Args[0].Value != 5 {
		t.Errorf("Args[0]: got %+v, want literal/5", cmp.Left.Args[0])
	}
	if cmp.Left.Args[1].Kind != ast.OperandValue || cmp.Left.Args[1].Name != "san" {
		t.Errorf("Args[1]: got %+v, want value/san", cmp.Left.Args[1])
	}
	if cmp.Left.Args[2].Kind != ast.OperandAffection || cmp.Left.Args[2].Char != "easton" {
		t.Errorf("Args[2]: got %+v, want affection/easton", cmp.Left.Args[2])
	}
}

// TestParseAggregateOperandNested covers MAX(MIN(a, b), c) — aggregate args
// can themselves be aggregates.
func TestParseAggregateOperandNested(t *testing.T) {
	src := `@episode main:01 "T" {
		@if (MAX(MIN(affection.easton, affection.diego), affection.mauricio) >= 5) {
			NARRATOR: hi.
		}
		@gate { @next main:02 }
	}`
	ep := parseOrFail(t, src)
	cmp := ep.Body[0].(*ast.IfNode).Condition.(*ast.ComparisonCondition)
	if cmp.Left.Kind != ast.OperandMax {
		t.Fatalf("outer Kind: got %q, want max", cmp.Left.Kind)
	}
	if len(cmp.Left.Args) != 2 {
		t.Fatalf("outer Args len: got %d, want 2", len(cmp.Left.Args))
	}
	inner := cmp.Left.Args[0]
	if inner.Kind != ast.OperandMin {
		t.Fatalf("inner Kind: got %q, want min", inner.Kind)
	}
	if len(inner.Args) != 2 {
		t.Fatalf("inner Args len: got %d, want 2", len(inner.Args))
	}
	if inner.Args[0].Kind != ast.OperandAffection || inner.Args[0].Char != "easton" {
		t.Errorf("inner Args[0]: got %+v", inner.Args[0])
	}
}

// TestParseAggregateOperandRightSide covers MAX(...) on the right side of a
// comparison.
func TestParseAggregateOperandRightSide(t *testing.T) {
	src := `@episode main:01 "T" {
		@if (affection.easton > MAX(affection.diego, affection.mauricio, affection.elias)) {
			NARRATOR: hi.
		}
		@gate { @next main:02 }
	}`
	ep := parseOrFail(t, src)
	cmp := ep.Body[0].(*ast.IfNode).Condition.(*ast.ComparisonCondition)
	if cmp.Left.Kind != ast.OperandAffection {
		t.Errorf("Left.Kind: got %q", cmp.Left.Kind)
	}
	if cmp.Right.Kind != ast.OperandMax {
		t.Fatalf("Right.Kind: got %q, want max", cmp.Right.Kind)
	}
	if len(cmp.Right.Args) != 3 {
		t.Errorf("Right.Args len: got %d, want 3", len(cmp.Right.Args))
	}
}

// TestParseAggregateOperandRejectsSingleArg verifies MAX(x) with only one arg
// is a parse error.
func TestParseAggregateOperandRejectsSingleArg(t *testing.T) {
	src := `@episode main:01 "T" {
		@if (MAX(affection.easton) >= 5) {
			NARRATOR: hi.
		}
		@gate { @next main:02 }
	}`
	_, err := parseSource(src)
	if err == nil {
		t.Fatal("expected parse error for MAX(...) with single arg")
	}
	if !strings.Contains(err.Error(), "at least 2 arguments") {
		t.Errorf("error should mention at-least-2-args, got: %v", err)
	}
}

// TestParseOperandLowercaseMaxIsValueOperand verifies lowercase max/min are
// still legal variable names (only uppercase is reserved).
func TestParseOperandLowercaseMaxIsValueOperand(t *testing.T) {
	src := `@episode main:01 "T" {
		@if (max >= 5) {
			NARRATOR: hi.
		}
		@gate { @next main:02 }
	}`
	ep := parseOrFail(t, src)
	cmp := ep.Body[0].(*ast.IfNode).Condition.(*ast.ComparisonCondition)
	if cmp.Left.Kind != ast.OperandValue || cmp.Left.Name != "max" {
		t.Errorf("Left: got %+v, want value/max", cmp.Left)
	}
}

// =============================================================================
// @if / @else / @else @if
// =============================================================================

// TestParseIfElse tests @if with a plain @else.
func TestParseIfElse(t *testing.T) {
	src := `@episode main:01 "Branch" {
	@if (affection.easton >= 5) {
		NARRATOR: Easton smiles at you warmly.
		@affection easton +1
	}
	@else {
		NARRATOR: Easton barely notices you.
	}
	@gate { @next main:02 }
}`
	ep := parseOrFail(t, src)
	ifNode := ep.Body[0].(*ast.IfNode)
	cmp := ifNode.Condition.(*ast.ComparisonCondition)
	if cmp.Left.Kind != ast.OperandAffection || cmp.Left.Char != "easton" {
		t.Errorf("Left: got %+v", cmp.Left)
	}
	if cmp.Op != ">=" || cmp.Right.Kind != ast.OperandLiteral || cmp.Right.Value != 5 {
		t.Errorf("comparison: op=%q right=%+v", cmp.Op, cmp.Right)
	}
	if len(ifNode.Then) != 2 {
		t.Errorf("Then length: got %d, want 2", len(ifNode.Then))
	}
	if len(ifNode.Else) != 1 {
		t.Errorf("Else length: got %d, want 1", len(ifNode.Else))
	}
}

// TestParseElseIfChain tests @if / @else @if / @else chaining.
func TestParseElseIfChain(t *testing.T) {
	src := `@episode main:01 "ElseIf" {
    @if (affection.easton >= 5) {
        NARRATOR: High affection.
    } @else @if (CHA >= 14) {
        NARRATOR: High charisma.
    } @else {
        NARRATOR: Default.
    }
    @gate { @next main:02 }
}`
	ep := parseOrFail(t, src)
	ifNode := ep.Body[0].(*ast.IfNode)
	if len(ifNode.Else) != 1 {
		t.Fatalf("Else length: got %d", len(ifNode.Else))
	}
	elseIf, ok := ifNode.Else[0].(*ast.IfNode)
	if !ok {
		t.Fatalf("Else[0]: expected *IfNode, got %T", ifNode.Else[0])
	}
	if _, ok := elseIf.Condition.(*ast.ComparisonCondition); !ok {
		t.Errorf("ElseIf.Condition: got %T", elseIf.Condition)
	}
	if len(elseIf.Else) != 1 {
		t.Errorf("ElseIf.Else length: got %d", len(elseIf.Else))
	}
}

// TestParseIfNoElse tests @if without an @else.
func TestParseIfNoElse(t *testing.T) {
	src := `@episode main:01 "T" {
		@if (EP01_COMPLETE) {
			NARRATOR: Hi.
		}
		@gate { @next main:02 }
	}`
	ep := parseOrFail(t, src)
	ifNode := ep.Body[0].(*ast.IfNode)
	if ifNode.Else != nil {
		t.Errorf("Else: got %v, want nil", ifNode.Else)
	}
}

// TestParseIfMultipleBodyNodes tests multi-statement @if then-block.
func TestParseIfMultipleBodyNodes(t *testing.T) {
	src := `@episode main:01 "T" {
		@if (EP01_COMPLETE) {
			@bg set classroom
			NARRATOR: Hello.
			@affection mauricio +1
		}
		@gate { @next main:02 }
	}`
	ep := parseOrFail(t, src)
	ifNode := ep.Body[0].(*ast.IfNode)
	if len(ifNode.Then) != 3 {
		t.Errorf("Then length: got %d, want 3", len(ifNode.Then))
	}
}

// =============================================================================
// Gate routing — @next, @end, conditions, mixed
// =============================================================================

// TestParseGateConditional tests a gate with conditional routes and a
// fallback @next.
func TestParseGateConditional(t *testing.T) {
	src := `@episode main:01 "Gates" {
	NARRATOR: The story branches.
	@gate {
		@if (A.success):
			@next main/good/001:01
		@else @if (affection.easton >= 10):
			@next main/bad/001:01
		@else:
			@next main:02
	}
}`
	ep := parseOrFail(t, src)
	if ep.Gate == nil {
		t.Fatal("Gate: expected non-nil")
	}
	if len(ep.Gate.Routes) != 3 {
		t.Fatalf("Routes count: got %d, want 3", len(ep.Gate.Routes))
	}

	// Route 0: A.success
	r0 := ep.Gate.Routes[0]
	ch0, ok := r0.Condition.(*ast.ChoiceCondition)
	if !ok || ch0.Option != "A" || ch0.Result != "success" {
		t.Errorf("Route[0]: got %+v", r0.Condition)
	}
	next0, ok := r0.Leaf.(*ast.NextLeaf)
	if !ok || next0.Target != "main/good/001:01" {
		t.Errorf("Route[0].Leaf: got %+v", r0.Leaf)
	}

	// Route 1: affection.easton >= 10
	r1 := ep.Gate.Routes[1]
	cmp1, ok := r1.Condition.(*ast.ComparisonCondition)
	if !ok {
		t.Fatalf("Route[1].Condition: got %T", r1.Condition)
	}
	if cmp1.Left.Kind != ast.OperandAffection || cmp1.Left.Char != "easton" {
		t.Errorf("Route[1] Left: got %+v", cmp1.Left)
	}
	if cmp1.Op != ">=" || cmp1.Right.Kind != ast.OperandLiteral || cmp1.Right.Value != 10 {
		t.Errorf("Route[1] comparison: op=%q right=%+v", cmp1.Op, cmp1.Right)
	}
	next1 := r1.Leaf.(*ast.NextLeaf)
	if next1.Target != "main/bad/001:01" {
		t.Errorf("Route[1].Target: got %q", next1.Target)
	}

	// Route 2: fallback
	r2 := ep.Gate.Routes[2]
	if r2.Condition != nil {
		t.Errorf("Route[2].Condition: got %v", r2.Condition)
	}
	next2 := r2.Leaf.(*ast.NextLeaf)
	if next2.Target != "main:02" {
		t.Errorf("Route[2].Target: got %q", next2.Target)
	}
}

// TestParseGateDirectNext verifies a gate with a single bare @next.
func TestParseGateDirectNext(t *testing.T) {
	src := `@episode main:01 "T" {
		NARRATOR: Hi.
		@gate {
			@next main:02
		}
	}`
	ep := parseOrFail(t, src)
	if len(ep.Gate.Routes) != 1 {
		t.Fatalf("Routes: got %d", len(ep.Gate.Routes))
	}
	r := ep.Gate.Routes[0]
	if r.Condition != nil {
		t.Error("Condition: want nil")
	}
	next, ok := r.Leaf.(*ast.NextLeaf)
	if !ok || next.Target != "main:02" {
		t.Errorf("Leaf: got %+v", r.Leaf)
	}
}

// TestParseGateNextSlashTarget verifies @next with a slash-bearing branch key.
func TestParseGateNextSlashTarget(t *testing.T) {
	src := `@episode main:01 "T" {
		NARRATOR: Hi.
		@gate {
			@next main/good/001:01
		}
	}`
	ep := parseOrFail(t, src)
	next := ep.Gate.Routes[0].Leaf.(*ast.NextLeaf)
	if next.Target != "main/good/001:01" {
		t.Errorf("Target: got %q", next.Target)
	}
}

// =============================================================================
// Gate @end leaves — single, mixed with @next, all 3 ending types
// =============================================================================

// TestParseGateEndComplete verifies a degenerate `@gate { @end complete }`.
// At source level this is just an EndLeaf — the parser does NOT lower to
// Episode.Ending (that's the emitter's job).
func TestParseGateEndComplete(t *testing.T) {
	src := `@episode main:15 "Finale" {
		NARRATOR: The end.
		@gate { @end complete }
	}`
	ep := parseOrFail(t, src)

	if ep.Ending != nil {
		t.Errorf("Ending: got %+v, want nil (parser never sets Ending)", ep.Ending)
	}
	if ep.Gate == nil {
		t.Fatal("Gate: expected non-nil")
	}
	if len(ep.Gate.Routes) != 1 {
		t.Fatalf("Routes: got %d, want 1", len(ep.Gate.Routes))
	}
	r := ep.Gate.Routes[0]
	if r.Condition != nil {
		t.Errorf("Condition: got %v, want nil", r.Condition)
	}
	end, ok := r.Leaf.(*ast.EndLeaf)
	if !ok {
		t.Fatalf("Leaf: expected *EndLeaf, got %T", r.Leaf)
	}
	if end.Type != ast.EndingComplete {
		t.Errorf("EndLeaf.Type: got %q, want %q", end.Type, ast.EndingComplete)
	}
}

// TestParseGateEndAllTypes verifies all 3 ending types parse.
func TestParseGateEndAllTypes(t *testing.T) {
	cases := []struct {
		name string
		end  string
		want string
	}{
		{"complete", "complete", ast.EndingComplete},
		{"to_be_continued", "to_be_continued", ast.EndingToBeContinued},
		{"bad_ending", "bad_ending", ast.EndingBad},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			src := "@episode main:01 \"T\" { NARRATOR: hi.\n@gate { @end " + c.end + " } }"
			ep := parseOrFail(t, src)
			leaf := ep.Gate.Routes[0].Leaf.(*ast.EndLeaf)
			if leaf.Type != c.want {
				t.Errorf("Type: got %q, want %q", leaf.Type, c.want)
			}
		})
	}
}

// TestParseGateEndInvalidType verifies an unknown @end type is rejected.
func TestParseGateEndInvalidType(t *testing.T) {
	src := `@episode main:01 "T" {
		@gate { @end nope }
	}`
	_, err := parseSource(src)
	if err == nil {
		t.Fatal("expected parse error for invalid @end type")
	}
	if !strings.Contains(err.Error(), "invalid @end type") {
		t.Errorf("error should mention invalid @end type, got: %v", err)
	}
}

// TestParseGateMixedNextAndEnd verifies a gate can mix @next and @end leaves.
func TestParseGateMixedNextAndEnd(t *testing.T) {
	src := `@episode main:01 "T" {
		NARRATOR: hi.
		@gate {
			@if (A.success):
				@next main/good/01:01
			@else @if (B.fail):
				@end bad_ending
			@else:
				@next main:02
		}
	}`
	ep := parseOrFail(t, src)
	if len(ep.Gate.Routes) != 3 {
		t.Fatalf("Routes: got %d", len(ep.Gate.Routes))
	}
	// Route 0: NextLeaf
	if _, ok := ep.Gate.Routes[0].Leaf.(*ast.NextLeaf); !ok {
		t.Errorf("Route[0].Leaf: got %T, want *NextLeaf", ep.Gate.Routes[0].Leaf)
	}
	// Route 1: EndLeaf (bad_ending)
	end1, ok := ep.Gate.Routes[1].Leaf.(*ast.EndLeaf)
	if !ok {
		t.Fatalf("Route[1].Leaf: got %T, want *EndLeaf", ep.Gate.Routes[1].Leaf)
	}
	if end1.Type != ast.EndingBad {
		t.Errorf("Route[1].Leaf.Type: got %q", end1.Type)
	}
	// Route 2: NextLeaf
	if _, ok := ep.Gate.Routes[2].Leaf.(*ast.NextLeaf); !ok {
		t.Errorf("Route[2].Leaf: got %T, want *NextLeaf", ep.Gate.Routes[2].Leaf)
	}
}

// TestParseGatePlainElse tests gate with @if / @else (no @if chain).
func TestParseGatePlainElse(t *testing.T) {
	src := `@episode main:01 "T" {
		NARRATOR: Hi.
		@gate {
			@if (EP01_DONE):
				@next main:03
			@else:
				@next main:02
		}
	}`
	ep := parseOrFail(t, src)
	if len(ep.Gate.Routes) != 2 {
		t.Fatalf("Routes: got %d", len(ep.Gate.Routes))
	}
	if ep.Gate.Routes[0].Condition == nil {
		t.Error("Route[0] should have a condition")
	}
	if ep.Gate.Routes[1].Condition != nil {
		t.Error("Route[1] should be unconditional")
	}
	next := ep.Gate.Routes[1].Leaf.(*ast.NextLeaf)
	if next.Target != "main:02" {
		t.Errorf("fallback target: got %q", next.Target)
	}
}

// TestParseStandaloneEndingRejected verifies that a top-level @ending
// directive (no longer a source-level construct) is rejected with a hint.
func TestParseStandaloneEndingRejected(t *testing.T) {
	src := `@episode main:01 "T" {
		NARRATOR: hi.
		@ending complete
	}`
	_, err := parseSource(src)
	if err == nil {
		t.Fatal("expected parse error for standalone @ending")
	}
	if !strings.Contains(err.Error(), "standalone @ending is not allowed") {
		t.Errorf("error should hint to use @gate { @end ... }, got: %v", err)
	}
}

// TestParseDuplicateGate verifies a duplicate @gate block is rejected.
func TestParseDuplicateGate(t *testing.T) {
	src := `@episode main:01 "T" {
		NARRATOR: hi.
		@gate { @next main:02 }
		@gate { @next main:03 }
	}`
	_, err := parseSource(src)
	if err == nil {
		t.Fatal("expected parse error for duplicate @gate")
	}
	if !strings.Contains(err.Error(), "duplicate @gate") {
		t.Errorf("error should mention duplicate gate, got: %v", err)
	}
}

// TestParseEmptyGate verifies a gate with no routes is rejected.
func TestParseEmptyGate(t *testing.T) {
	src := `@episode main:01 "T" { @gate { } }`
	_, err := parseSource(src)
	if err == nil {
		t.Fatal("expected parse error for empty gate")
	}
}

// =============================================================================
// Concurrent (&) directives
// =============================================================================

// TestParseConcurrent tests that & prefix produces nodes with Concurrent=true.
func TestParseConcurrent(t *testing.T) {
	src := `@episode main:01 "Concurrent" {
    @bg set classroom fade
    &music theme_main
    &malia neutral
    NARRATOR: Hello.
    @gate { @next main:02 }
}`
	ep := parseOrFail(t, src)

	if len(ep.Body) != 4 {
		t.Fatalf("Body length: got %d, want 4", len(ep.Body))
	}

	// Body[0]: bg (leader, not concurrent)
	bg := ep.Body[0].(*ast.BgSetNode)
	if bg.GetConcurrent() {
		t.Error("BgSetNode should not be concurrent")
	}

	// Body[1]: music (concurrent)
	mp := ep.Body[1].(*ast.MusicSetNode)
	if !mp.GetConcurrent() {
		t.Error("MusicSetNode should be concurrent")
	}

	// Body[2]: char show (concurrent)
	cs := ep.Body[2].(*ast.CharShowNode)
	if !cs.GetConcurrent() {
		t.Error("CharShowNode should be concurrent")
	}
	if cs.Char != "malia" || cs.Look != "neutral" {
		t.Errorf("CharShowNode: char=%q look=%q", cs.Char, cs.Look)
	}

	// Body[3]: narrator (not concurrent)
	if _, ok := ep.Body[3].(*ast.NarratorNode); !ok {
		t.Errorf("Body[3]: expected *NarratorNode, got %T", ep.Body[3])
	}
}

// =============================================================================
// Pause
// =============================================================================

// TestParsePause tests @pause — no parameters, always a single click.
func TestParsePause(t *testing.T) {
	src := `@episode main:01 "Pause" {
    @bg set classroom
    @pause
    NARRATOR: Hello.
    @gate { @next main:02 }
}`
	ep := parseOrFail(t, src)
	if len(ep.Body) != 3 {
		t.Fatalf("Body length: got %d, want 3", len(ep.Body))
	}
	if _, ok := ep.Body[1].(*ast.PauseNode); !ok {
		t.Fatalf("Body[1]: expected *PauseNode, got %T", ep.Body[1])
	}
}

// =============================================================================
// CG show — leaf form (name + content only)
// =============================================================================

// TestParseCgShow tests `@cg <name> "<content>"` — a leaf directive with no
// body / duration / transition.
func TestParseCgShow(t *testing.T) {
	src := `@episode main:01 "T" {
		@cg sunset "Camera tilts up from the horizon over the ocean as orange light spreads across the screen, holding briefly on a silhouette of the cliff before fading."
		@gate { @next main:02 }
	}`
	ep := parseOrFail(t, src)
	cg, ok := ep.Body[0].(*ast.CgShowNode)
	if !ok {
		t.Fatalf("Body[0]: expected *CgShowNode, got %T", ep.Body[0])
	}
	if cg.Name != "sunset" {
		t.Errorf("Name: got %q", cg.Name)
	}
	if !strings.Contains(cg.Content, "Camera") {
		t.Errorf("Content: got %q", cg.Content)
	}
}

// TestParseCgRequiresContent verifies @cg without a content string fails.
func TestParseCgRequiresContent(t *testing.T) {
	src := `@episode main:01 "T" {
		@cg sunset
		@gate { @next main:02 }
	}`
	_, err := parseSource(src)
	if err == nil {
		t.Fatal("expected parse error for @cg without content")
	}
}

// =============================================================================
// Background
// =============================================================================

// TestParseBgNoTransition tests `@bg set <name>` without an optional
// transition.
func TestParseBgNoTransition(t *testing.T) {
	src := `@episode main:01 "T" {
		@bg set classroom
		@gate { @next main:02 }
	}`
	ep := parseOrFail(t, src)
	bg := ep.Body[0].(*ast.BgSetNode)
	if bg.Name != "classroom" {
		t.Errorf("Name: got %q", bg.Name)
	}
	if bg.Transition != "" {
		t.Errorf("Transition: got %q, want empty", bg.Transition)
	}
}

// =============================================================================
// Achievement
// =============================================================================

// TestParseAchievementInline verifies @achievement parses as an inline body step.
func TestParseAchievementInline(t *testing.T) {
	src := `@episode main:01 "T" {
		NARRATOR: Hi.
		@achievement HIGH_HEEL_WARRIOR {
			name: "High Heel Warrior"
			rarity: rare
			description: "The first time you used a high heel as a weapon."
		}
		@gate { @next main:02 }
	}`
	ep := parseOrFail(t, src)
	if len(ep.Body) != 2 {
		t.Fatalf("Body length: got %d, want 2", len(ep.Body))
	}
	a, ok := ep.Body[1].(*ast.AchievementNode)
	if !ok {
		t.Fatalf("Body[1]: expected *AchievementNode, got %T", ep.Body[1])
	}
	if a.ID != "HIGH_HEEL_WARRIOR" {
		t.Errorf("ID: got %q", a.ID)
	}
	if a.Rarity != ast.RarityRare {
		t.Errorf("Rarity: got %q", a.Rarity)
	}
	if a.Name == "" || a.Description == "" {
		t.Errorf("name/description empty: name=%q desc=%q", a.Name, a.Description)
	}
}

// TestParseAchievementInsideIf verifies @achievement nested under @if.
func TestParseAchievementInsideIf(t *testing.T) {
	src := `@episode main:05 "T" {
		NARRATOR: hi.
		@if (HIGH_HEEL_EP05) {
			@achievement HIGH_HEEL_WARRIOR {
				name: "High Heel Warrior"
				rarity: rare
				description: "You turned an accessory into a warning."
			}
		}
		@gate { @next main:06 }
	}`
	ep := parseOrFail(t, src)
	ifNode := ep.Body[1].(*ast.IfNode)
	if len(ifNode.Then) != 1 {
		t.Fatalf("Then length: got %d", len(ifNode.Then))
	}
	if _, ok := ifNode.Then[0].(*ast.AchievementNode); !ok {
		t.Fatalf("Then[0]: expected *AchievementNode, got %T", ifNode.Then[0])
	}
}

// TestParseAchievementRejectsBareForm verifies @achievement without a metadata
// block is a parse error.
func TestParseAchievementRejectsBareForm(t *testing.T) {
	src := `@episode main:01 "T" {
		@achievement HIGH_HEEL_WARRIOR
		@gate { @next main:02 }
	}`
	_, err := parseSource(src)
	if err == nil {
		t.Fatal("expected parse error for bare @achievement")
	}
	if !strings.Contains(err.Error(), "requires a block") {
		t.Errorf("error should mention requires-a-block, got: %v", err)
	}
}

// TestParseAchievementRejectsInvalidRarity verifies "common" is banned.
func TestParseAchievementRejectsInvalidRarity(t *testing.T) {
	src := `@episode main:01 "T" {
		NARRATOR: hi.
		@achievement A1 {
			name: "x"
			rarity: common
			description: "y"
		}
		@gate { @next main:02 }
	}`
	_, err := parseSource(src)
	if err == nil {
		t.Fatal("expected parse error for rarity 'common'")
	}
	if !strings.Contains(err.Error(), "invalid rarity") {
		t.Errorf("error should mention invalid rarity, got: %v", err)
	}
}

// TestParseAchievementRejectsMissingField verifies a missing required field
// fails.
func TestParseAchievementRejectsMissingField(t *testing.T) {
	src := `@episode main:01 "T" {
		NARRATOR: hi.
		@achievement A1 {
			name: "x"
			rarity: rare
		}
		@gate { @next main:02 }
	}`
	_, err := parseSource(src)
	if err == nil {
		t.Fatal("expected parse error for missing description")
	}
}

// =============================================================================
// Error path / miscellaneous
// =============================================================================

// TestParseError_EmptyCondition verifies @if () fails.
func TestParseError_EmptyCondition(t *testing.T) {
	src := `@episode main:01 "T" { @if () { NARRATOR: Hi. } @gate { @next main:02 } }`
	_, err := parseSource(src)
	if err == nil {
		t.Fatal("expected error for empty condition")
	}
	if !strings.Contains(err.Error(), "expected condition") {
		t.Errorf("expected 'expected condition' in error, got: %v", err)
	}
}

// TestParseError_EmptyChoice verifies @choice { } fails.
func TestParseError_EmptyChoice(t *testing.T) {
	src := `@episode main:01 "T" { @choice { } @gate { @next main:02 } }`
	_, err := parseSource(src)
	if err == nil {
		t.Fatal("expected error for empty choice")
	}
}

// TestParseComments verifies // comments are skipped.
func TestParseComments(t *testing.T) {
	src := `@episode main:01 "T" {
		// This is a comment
		NARRATOR: Hello.
		// Another comment
		@gate { @next main:02 }
	}`
	ep := parseOrFail(t, src)
	if len(ep.Body) != 1 {
		t.Errorf("Body length: got %d, want 1", len(ep.Body))
	}
}
