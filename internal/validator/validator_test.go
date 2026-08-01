package validator

import (
	"strings"
	"testing"

	"github.com/cdotlock/lunascripts/internal/ast"
)

// unconditionalGate returns a minimal valid @gate with a single @next leaf.
func unconditionalGate(target string) *ast.GateBlock {
	return &ast.GateBlock{
		Routes: []*ast.GateRoute{
			{Leaf: &ast.NextLeaf{Target: target}},
		},
	}
}

func TestValidGateBlock(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01",
		Title:     "Test",
		Body: []ast.Node{
			&ast.NarratorNode{Text: "Hello."},
		},
		Gate: unconditionalGate("main:02"),
	}

	errs := Validate(ep)
	if len(errs) != 0 {
		t.Errorf("expected no errors, got %v", errs)
	}
}

func TestMissingGate(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01",
		Title:     "Test",
		Body: []ast.Node{
			&ast.NarratorNode{Text: "Hello."},
		},
		Gate: nil,
	}

	errs := Validate(ep)
	if len(errs) != 1 {
		t.Fatalf("expected 1 error, got %d: %v", len(errs), errs)
	}
	if errs[0].Code != MissingTerminal {
		t.Errorf("error code = %q, want %q", errs[0].Code, MissingTerminal)
	}
}

func TestBraveOptionWithoutCheck(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01",
		Title:     "Test",
		Body: []ast.Node{
			&ast.ChoiceNode{
				Options: []*ast.OptionNode{
					{
						ID:   "A",
						Mode: "brave",
						Text: "Confront him",
						// Check is nil — should trigger BRAVE_NO_CHECK.
					},
				},
			},
		},
		Gate: unconditionalGate("main:02"),
	}

	errs := Validate(ep)
	hasNoCheck := false
	for _, e := range errs {
		if e.Code == BraveNoCheck {
			hasNoCheck = true
		}
	}
	if !hasNoCheck {
		t.Errorf("expected BRAVE_NO_CHECK error, got %v", errs)
	}
}

func TestValidBraveOptionPass(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01", Title: "T",
		Body: []ast.Node{
			&ast.ChoiceNode{
				Options: []*ast.OptionNode{
					{
						ID: "A", Mode: "brave", Text: "Fight",
						Check: &ast.CheckBlock{Attr: "STR", DC: 14},
						Body: []ast.Node{
							&ast.IfNode{
								Condition: &ast.CheckCondition{Result: "success"},
								Then:      []ast.Node{&ast.NarratorNode{Text: "Win."}},
								Else:      []ast.Node{&ast.NarratorNode{Text: "Lose."}},
							},
						},
					},
				},
			},
		},
		Gate: unconditionalGate("main:02"),
	}
	errs := Validate(ep)
	if len(errs) != 0 {
		t.Errorf("expected no errors, got %v", errs)
	}
}

func TestCheckConditionScope(t *testing.T) {
	tests := []struct {
		name string
		body []ast.Node
		gate *ast.GateBlock
	}{
		{
			name: "top-level body",
			body: []ast.Node{&ast.IfNode{
				Condition: &ast.CheckCondition{Result: "success"},
				Then:      []ast.Node{&ast.NarratorNode{Text: "Invalid."}},
			}},
			gate: unconditionalGate("main:02"),
		},
		{
			name: "safe option body",
			body: []ast.Node{&ast.ChoiceNode{Options: []*ast.OptionNode{{
				ID: "A", Mode: "safe", Text: "Wait",
				Body: []ast.Node{&ast.IfNode{
					Condition: &ast.CheckCondition{Result: "fail"},
					Then:      []ast.Node{&ast.NarratorNode{Text: "Invalid."}},
				}},
			}}}},
			gate: unconditionalGate("main:02"),
		},
		{
			name: "gate route",
			body: []ast.Node{&ast.NarratorNode{Text: "End."}},
			gate: &ast.GateBlock{Routes: []*ast.GateRoute{
				{Condition: &ast.CheckCondition{Result: "success"}, Leaf: &ast.NextLeaf{Target: "main:02"}},
				{Leaf: &ast.EndLeaf{Type: ast.EndingComplete}},
			}},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			errs := Validate(&ast.Episode{BranchKey: "main:01", Title: "T", Body: tt.body, Gate: tt.gate})
			found := false
			for _, err := range errs {
				if err.Code == InvalidCondition && strings.Contains(err.Message, "only valid inside a brave option body") {
					found = true
				}
			}
			if !found {
				t.Fatalf("expected scoped INVALID_CONDITION error, got %v", errs)
			}
		})
	}
}

func TestDuplicateOptionID(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01", Title: "T",
		Body: []ast.Node{
			&ast.ChoiceNode{
				Options: []*ast.OptionNode{
					{ID: "A", Mode: "safe", Text: "a"},
					{ID: "A", Mode: "safe", Text: "b"},
				},
			},
		},
		Gate: unconditionalGate("main:02"),
	}
	errs := Validate(ep)
	found := false
	for _, e := range errs {
		if e.Code == DuplicateOptionID {
			found = true
		}
	}
	if !found {
		t.Error("expected DUPLICATE_OPTION_ID error")
	}
}

func TestSafeOptionWithCheck(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01", Title: "T",
		Body: []ast.Node{
			&ast.ChoiceNode{
				Options: []*ast.OptionNode{
					{
						ID: "A", Mode: "safe", Text: "a",
						Check: &ast.CheckBlock{Attr: "STR", DC: 10},
					},
				},
			},
		},
		Gate: unconditionalGate("main:02"),
	}
	errs := Validate(ep)
	found := false
	for _, e := range errs {
		if e.Code == SafeOptionHasCheck {
			found = true
		}
	}
	if !found {
		t.Error("expected SAFE_OPTION_HAS_CHECK error")
	}
}

func TestInvalidBubbleType(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01", Title: "T",
		Body: []ast.Node{
			&ast.CharBubbleNode{Char: "c", BubbleType: "sparkle"},
		},
		Gate: unconditionalGate("main:02"),
	}
	errs := Validate(ep)
	found := false
	for _, e := range errs {
		if e.Code == InvalidBubbleType {
			found = true
		}
	}
	if !found {
		t.Error("expected INVALID_BUBBLE_TYPE error")
	}
}

func TestInvalidOptionMode(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01", Title: "T",
		Body: []ast.Node{
			&ast.ChoiceNode{
				Options: []*ast.OptionNode{
					{ID: "A", Mode: "risky", Text: "a"},
				},
			},
		},
		Gate: unconditionalGate("main:02"),
	}
	errs := Validate(ep)
	found := false
	for _, e := range errs {
		if e.Code == InvalidOptionMode {
			found = true
		}
	}
	if !found {
		t.Error("expected INVALID_OPTION_MODE error")
	}
}

// TestMinigameLeafNoBodyValidates pins the new leaf shape — a minigame
// with a name and description passes validation cleanly (there is no
// body to recurse into anymore).
func TestMinigameLeafNoBodyValidates(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01", Title: "T",
		Body: []ast.Node{
			&ast.MinigameNode{
				Name:        "mg1",
				Description: "minigame description placeholder",
			},
		},
		Gate: unconditionalGate("main:02"),
	}
	errs := Validate(ep)
	if len(errs) != 0 {
		t.Errorf("leaf minigame should validate cleanly, got %v", errs)
	}
}

// TestMinigameMissingDescription pins the validator error code for
// minigame missing required description.
func TestMinigameMissingDescription(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01", Title: "T",
		Body: []ast.Node{
			&ast.MinigameNode{Name: "mg1"},
		},
		Gate: unconditionalGate("main:02"),
	}
	errs := Validate(ep)
	found := false
	for _, e := range errs {
		if e.Code == MinigameMissingDescription {
			found = true
		}
	}
	if !found {
		t.Errorf("expected MINIGAME_MISSING_DESCRIPTION, got %v", errs)
	}
}

// TestMinigameMissingName pins the validator error for the empty-name case.
func TestMinigameMissingName(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01", Title: "T",
		Body: []ast.Node{
			&ast.MinigameNode{Description: "d"},
		},
		Gate: unconditionalGate("main:02"),
	}
	errs := Validate(ep)
	found := false
	for _, e := range errs {
		if e.Code == MinigameMissingName {
			found = true
		}
	}
	if !found {
		t.Errorf("expected MINIGAME_MISSING_NAME, got %v", errs)
	}
}

// TestTrickValidationWhitelist verifies the validator accepts every
// one of the six locked trick types and rejects anything outside.
func TestTrickValidationWhitelist(t *testing.T) {
	good := []string{
		ast.TrickTap, ast.TrickHold, ast.TrickSwipe,
		ast.TrickShake, ast.TrickSwing, ast.TrickTilt,
	}
	for _, ty := range good {
		ep := &ast.Episode{
			BranchKey: "main:01", Title: "T",
			Body: []ast.Node{
				&ast.TrickNode{Type: ty, Prompt: "do it."},
			},
			Gate: unconditionalGate("main:02"),
		}
		if errs := Validate(ep); len(errs) != 0 {
			t.Errorf("trick type %q should validate cleanly, got %v", ty, errs)
		}
	}

	// "blink" was never supported; "nod" is one of the three camera
	// types removed in an earlier iteration; "hold-still" was removed
	// when tilt replaced it — all must now be rejected.
	for _, ty := range []string{"blink", "nod", "turn-away", "close-eyes", "hold-still"} {
		t.Run(ty, func(t *testing.T) {
			ep := &ast.Episode{
				BranchKey: "main:01", Title: "T",
				Body: []ast.Node{
					&ast.TrickNode{Type: ty, Prompt: "go."},
				},
				Gate: unconditionalGate("main:02"),
			}
			errs := Validate(ep)
			found := false
			for _, e := range errs {
				if e.Code == InvalidTrickType {
					found = true
				}
			}
			if !found {
				t.Errorf("expected INVALID_TRICK_TYPE for %q, got %v", ty, errs)
			}
		})
	}
}

// TestTrickMissingPrompt verifies empty prompt is rejected.
func TestTrickMissingPrompt(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01", Title: "T",
		Body: []ast.Node{
			&ast.TrickNode{Type: ast.TrickTap, Prompt: ""},
		},
		Gate: unconditionalGate("main:02"),
	}
	errs := Validate(ep)
	found := false
	for _, e := range errs {
		if e.Code == TrickMissingPrompt {
			found = true
		}
	}
	if !found {
		t.Errorf("expected TRICK_MISSING_PROMPT, got %v", errs)
	}
}

func TestInvalidTransition(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01", Title: "T",
		Body: []ast.Node{
			&ast.BgSetNode{Name: "bg1", Transition: "wipe"},
		},
		Gate: unconditionalGate("main:02"),
	}
	errs := Validate(ep)
	found := false
	for _, e := range errs {
		if e.Code == InvalidTransition {
			found = true
		}
	}
	if !found {
		t.Error("expected INVALID_TRANSITION error for 'wipe'")
	}
}

func TestValidTransitions(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01", Title: "T",
		Body: []ast.Node{
			&ast.BgSetNode{Name: "bg1", Transition: "fade"},
			&ast.CharShowNode{Char: "c", Look: "l", Transition: "cut"},
		},
		Gate: unconditionalGate("main:02"),
	}
	errs := Validate(ep)
	if len(errs) != 0 {
		t.Errorf("expected no errors for valid transitions, got %v", errs)
	}
}

func TestValuesInsideNestedNodes(t *testing.T) {
	// Test checkValues recurses into Choice, IfNode, PhoneShow.
	// Brave-option success/fail branches are now inside the Body as an
	// @if (check.success) tree; we nest the bad bubble types in both branches.
	ep := &ast.Episode{
		BranchKey: "main:01", Title: "T",
		Body: []ast.Node{
			&ast.ChoiceNode{
				Options: []*ast.OptionNode{
					{
						ID: "A", Mode: "brave", Text: "a",
						Check: &ast.CheckBlock{Attr: "STR", DC: 10},
						Body: []ast.Node{
							&ast.IfNode{
								Condition: &ast.CheckCondition{Result: "success"},
								Then:      []ast.Node{&ast.CharBubbleNode{Char: "c", BubbleType: "invalid1"}},
								Else:      []ast.Node{&ast.CharBubbleNode{Char: "c", BubbleType: "invalid2"}},
							},
							&ast.CharBubbleNode{Char: "c", BubbleType: "invalid3"},
						},
					},
				},
			},
			&ast.IfNode{
				Condition: &ast.FlagCondition{Name: "A"},
				Then:      []ast.Node{&ast.CharBubbleNode{Char: "c", BubbleType: "invalid4"}},
				Else:      []ast.Node{&ast.CharBubbleNode{Char: "c", BubbleType: "invalid5"}},
			},
		},
		Gate: unconditionalGate("main:02"),
	}
	errs := Validate(ep)
	bubbleErrors := 0
	for _, e := range errs {
		if e.Code == InvalidBubbleType {
			bubbleErrors++
		}
	}
	if bubbleErrors < 5 {
		t.Errorf("expected at least 5 INVALID_BUBBLE_TYPE errors from nested nodes, got %d", bubbleErrors)
	}
}

func TestBraveOptionsInsideNestedNodes(t *testing.T) {
	// Test checkBraveOptions recurses into IfNode and PhoneShow.
	// Each of the brave options below is missing its check block, so
	// we expect BRAVE_NO_CHECK to fire for each.
	ep := &ast.Episode{
		BranchKey: "main:01", Title: "T",
		Body: []ast.Node{
			&ast.IfNode{
				Condition: &ast.FlagCondition{Name: "A"},
				Then: []ast.Node{
					&ast.ChoiceNode{
						Options: []*ast.OptionNode{
							{ID: "B", Mode: "brave", Text: "b"},
						},
					},
				},
				Else: []ast.Node{
					&ast.ChoiceNode{
						Options: []*ast.OptionNode{
							{ID: "C", Mode: "brave", Text: "c"},
						},
					},
				},
			},
			// PhoneShowNode body is whitelisted to text-message only, so
			// putting a choice there exercises checkBraveOptions recursion
			// even though it also generates an InvalidPhoneContent error.
			&ast.PhoneShowNode{
				Body: []ast.Node{
					&ast.ChoiceNode{
						Options: []*ast.OptionNode{
							{ID: "D", Mode: "brave", Text: "d"},
						},
					},
				},
			},
		},
		Gate: unconditionalGate("main:02"),
	}
	errs := Validate(ep)
	braveErrors := 0
	for _, e := range errs {
		if e.Code == BraveNoCheck {
			braveErrors++
		}
	}
	if braveErrors < 3 {
		t.Errorf("expected at least 3 BRAVE_NO_CHECK errors from nested nodes, got %d", braveErrors)
	}
}

func TestValidatorErrorMethod(t *testing.T) {
	e := Error{Code: "TEST_CODE", Message: "test message"}
	s := e.Error()
	if !strings.Contains(s, "TEST_CODE") || !strings.Contains(s, "test message") {
		t.Errorf("Error() = %q, expected code and message", s)
	}
}

// TestSafeOptionWithCheckBlock verifies that a safe option with a check
// block triggers SAFE_OPTION_HAS_CHECK — check is only meaningful for
// brave options.
func TestSafeOptionWithCheckBlock(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01", Title: "T",
		Body: []ast.Node{
			&ast.ChoiceNode{
				Options: []*ast.OptionNode{
					{
						ID: "A", Mode: "safe", Text: "a",
						Check: &ast.CheckBlock{Attr: "CHA", DC: 10},
					},
				},
			},
		},
		Gate: unconditionalGate("main:02"),
	}
	errs := Validate(ep)
	found := false
	for _, e := range errs {
		if e.Code == SafeOptionHasCheck {
			found = true
		}
	}
	if !found {
		t.Error("expected SAFE_OPTION_HAS_CHECK error for safe option with a check block")
	}
}

// TestBraveOptionWithCheckPasses verifies that a brave option with a
// check block and no explicit outcome body passes validation — outcome
// branching is a narrative choice the author makes via @if (check.success),
// not something the validator enforces.
func TestBraveOptionWithCheckPasses(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01", Title: "T",
		Body: []ast.Node{
			&ast.ChoiceNode{
				Options: []*ast.OptionNode{
					{
						ID: "A", Mode: "brave", Text: "a",
						Check: &ast.CheckBlock{Attr: "STR", DC: 14},
					},
				},
			},
		},
		Gate: unconditionalGate("main:02"),
	}
	errs := Validate(ep)
	if len(errs) != 0 {
		t.Errorf("expected no errors, got %v", errs)
	}
}

// TestGateEndLeafValid — a single unconditional @end leaf is a valid gate shape.
func TestGateEndLeafValid(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:15",
		Title:     "Finale",
		Body:      []ast.Node{&ast.NarratorNode{Text: "End."}},
		Gate: &ast.GateBlock{
			Routes: []*ast.GateRoute{
				{Leaf: &ast.EndLeaf{Type: ast.EndingComplete}},
			},
		},
	}
	errs := Validate(ep)
	if len(errs) != 0 {
		t.Errorf("expected no errors, got %v", errs)
	}
}

func TestMissingTerminalErrors(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01",
		Title:     "T",
		Body:      []ast.Node{&ast.NarratorNode{Text: "Hi."}},
	}
	errs := Validate(ep)
	if len(errs) == 0 {
		t.Fatal("expected MISSING_TERMINAL error, got none")
	}
	if errs[0].Code != MissingTerminal {
		t.Errorf("Code: got %q, want %q", errs[0].Code, MissingTerminal)
	}
}

// TestInvalidEndType pins rejection of unknown @end type values.
func TestInvalidEndType(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01",
		Title:     "T",
		Body:      []ast.Node{&ast.NarratorNode{Text: "Hi."}},
		Gate: &ast.GateBlock{
			Routes: []*ast.GateRoute{
				{Leaf: &ast.EndLeaf{Type: "nope"}},
			},
		},
	}
	errs := Validate(ep)
	var found bool
	for _, e := range errs {
		if e.Code == InvalidEndType {
			found = true
		}
	}
	if !found {
		t.Errorf("expected INVALID_END_TYPE in %v", errs)
	}
}

// TestIncompleteGate verifies a gate whose last route is conditional
// triggers INCOMPLETE_GATE.
func TestIncompleteGate(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01",
		Title:     "T",
		Body:      []ast.Node{&ast.NarratorNode{Text: "Hi."}},
		Gate: &ast.GateBlock{
			Routes: []*ast.GateRoute{
				{
					Condition: &ast.FlagCondition{Name: "A"},
					Leaf:      &ast.EndLeaf{Type: ast.EndingComplete},
				},
				// No unconditional fallback — incomplete.
			},
		},
	}
	errs := Validate(ep)
	found := false
	for _, e := range errs {
		if e.Code == IncompleteGate {
			found = true
		}
	}
	if !found {
		t.Errorf("expected INCOMPLETE_GATE, got %v", errs)
	}
}

// TestGateNextMissingTarget verifies a @next with empty target triggers
// GATE_NEXT_MISSING_TARGET.
func TestGateNextMissingTarget(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01",
		Title:     "T",
		Body:      []ast.Node{&ast.NarratorNode{Text: "Hi."}},
		Gate: &ast.GateBlock{
			Routes: []*ast.GateRoute{
				{Leaf: &ast.NextLeaf{Target: ""}},
			},
		},
	}
	errs := Validate(ep)
	found := false
	for _, e := range errs {
		if e.Code == GateNextMissingTarget {
			found = true
		}
	}
	if !found {
		t.Errorf("expected GATE_NEXT_MISSING_TARGET, got %v", errs)
	}
}

func TestInvalidCompoundConditionOp(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01",
		Title:     "T",
		Body: []ast.Node{
			&ast.IfNode{
				Condition: &ast.CompoundCondition{
					Op:    "xor", // invalid
					Left:  &ast.FlagCondition{Name: "A"},
					Right: &ast.FlagCondition{Name: "B"},
				},
				Then: []ast.Node{&ast.NarratorNode{Text: "x"}},
			},
		},
		Gate: unconditionalGate("main:02"),
	}
	errs := Validate(ep)
	var found bool
	for _, e := range errs {
		if e.Code == InvalidCondition && strings.Contains(e.Message, `"xor"`) {
			found = true
		}
	}
	if !found {
		t.Errorf("expected INVALID_CONDITION for invalid compound op, got %v", errs)
	}
}

// TestAchievementIdDuplicationAllowed pins the decision that two inline
// @achievement steps sharing the same id are valid — engines dedup at
// unlock time, and authors may deliberately echo a single unlock point
// from several narrative branches.
func TestAchievementIdDuplicationAllowed(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01",
		Title:     "T",
		Body: []ast.Node{
			&ast.AchievementNode{ID: "A", Name: "x", Rarity: ast.RarityRare, Description: "d"},
			&ast.AchievementNode{ID: "A", Name: "x", Rarity: ast.RarityRare, Description: "d"},
		},
		Gate: unconditionalGate("main:02"),
	}
	errs := Validate(ep)
	if len(errs) != 0 {
		t.Errorf("duplicate ids should validate cleanly, got %v", errs)
	}
}

func TestInvalidRarityValidation(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01", Title: "T",
		Body: []ast.Node{
			&ast.AchievementNode{ID: "A", Name: "n", Rarity: "common", Description: "d"},
		},
		Gate: unconditionalGate("main:02"),
	}
	errs := Validate(ep)
	found := false
	for _, e := range errs {
		if e.Code == InvalidRarity {
			found = true
		}
	}
	if !found {
		t.Errorf("expected INVALID_RARITY, got %v", errs)
	}
}

func TestInvalidSignalKindValidation(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01", Title: "T",
		Body: []ast.Node{&ast.SignalNode{Kind: "garbage", Event: "X"}},
		Gate: unconditionalGate("main:02"),
	}
	errs := Validate(ep)
	found := false
	for _, e := range errs {
		if e.Code == InvalidSignalKind {
			found = true
		}
	}
	if !found {
		t.Errorf("expected INVALID_SIGNAL_KIND, got %v", errs)
	}
}

func TestValidateSignalIntReservedName(t *testing.T) {
	// @signal int san should fail — "san" is an engine-reserved name.
	ep := &ast.Episode{
		BranchKey: "main:01",
		Title:     "t",
		Body: []ast.Node{
			&ast.SignalNode{Kind: ast.SignalKindInt, Name: "san", Op: ast.SignalOpAssign, Value: 0},
		},
		Gate: &ast.GateBlock{
			Routes: []*ast.GateRoute{
				{Leaf: &ast.EndLeaf{Type: ast.EndingComplete}},
			},
		},
	}
	errs := Validate(ep)
	found := false
	for _, e := range errs {
		if e.Code == ReservedKeyword {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected ReservedKeyword error, got: %v", errs)
	}
}

func TestValidateSignalIntReservedNameIsItself(t *testing.T) {
	// @signal int int = 0 — 'int' is both the kind word and in the
	// reserved-keywords list. Must be rejected by the ReservedKeyword check.
	ep := &ast.Episode{
		BranchKey: "main:01",
		Title:     "t",
		Body: []ast.Node{
			&ast.SignalNode{Kind: ast.SignalKindInt, Name: "int", Op: ast.SignalOpAssign, Value: 0},
		},
		Gate: &ast.GateBlock{
			Routes: []*ast.GateRoute{
				{Leaf: &ast.EndLeaf{Type: ast.EndingComplete}},
			},
		},
	}
	errs := Validate(ep)
	found := false
	for _, e := range errs {
		if e.Code == ReservedKeyword {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected ReservedKeyword error for '@signal int int', got: %v", errs)
	}
}

func TestValidateAuthorSignalNamesUseScreamingSnakeCase(t *testing.T) {
	valid := []ast.Node{
		&ast.SignalNode{Kind: ast.SignalKindMark, Event: "FIRST_MEETING"},
		&ast.SignalNode{Kind: ast.SignalKindInt, Name: "LOVE_POINTS", Op: ast.SignalOpAdd, Value: 1},
	}
	ep := &ast.Episode{
		BranchKey: "main:01",
		Title:     "t",
		Body:      valid,
		Gate:      unconditionalGate("main:02"),
	}
	for _, err := range Validate(ep) {
		if err.Code == InvalidSignalName {
			t.Fatalf("uppercase author signal unexpectedly rejected: %v", err)
		}
	}

	invalid := []struct {
		name string
		kind string
	}{
		{name: "love_points", kind: ast.SignalKindInt},
		{name: "Love_Points", kind: ast.SignalKindInt},
		{name: "1_LOVE_POINTS", kind: ast.SignalKindInt},
		{name: "LOVE-POINTS", kind: ast.SignalKindInt},
		{name: "first_meeting", kind: ast.SignalKindMark},
	}
	for _, tc := range invalid {
		t.Run(tc.kind+"/"+tc.name, func(t *testing.T) {
			node := &ast.SignalNode{Kind: tc.kind, Name: tc.name, Event: tc.name, Op: ast.SignalOpAdd, Value: 1}
			ep := &ast.Episode{BranchKey: "main:01", Title: "t", Body: []ast.Node{node}, Gate: unconditionalGate("main:02")}
			found := false
			for _, err := range Validate(ep) {
				if err.Code == InvalidSignalName {
					found = true
				}
			}
			if !found {
				t.Fatalf("expected %s for %q", InvalidSignalName, tc.name)
			}
		})
	}
}

func TestValidateSignalIntOK(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01",
		Title:     "t",
		Body: []ast.Node{
			&ast.SignalNode{Kind: ast.SignalKindInt, Name: "REJECTIONS", Op: ast.SignalOpAssign, Value: 0},
			&ast.SignalNode{Kind: ast.SignalKindInt, Name: "REJECTIONS", Op: ast.SignalOpAdd, Value: 1},
		},
		Gate: &ast.GateBlock{
			Routes: []*ast.GateRoute{
				{Leaf: &ast.EndLeaf{Type: ast.EndingComplete}},
			},
		},
	}
	errs := Validate(ep)
	for _, e := range errs {
		if e.Code == ReservedKeyword || e.Code == InvalidSignalKind {
			t.Fatalf("unexpected error: %v", e)
		}
	}
}

// TestAggregateTooFewArgs pins the MAX/MIN aggregate args>=2 rule.
func TestAggregateTooFewArgs(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01", Title: "T",
		Body: []ast.Node{
			&ast.IfNode{
				Condition: &ast.ComparisonCondition{
					Left: &ast.ComparisonOperand{
						Kind: ast.OperandMax,
						Args: []*ast.ComparisonOperand{
							{Kind: ast.OperandAffection, Char: "easton"},
						},
					},
					Op:    ">=",
					Right: &ast.ComparisonOperand{Kind: ast.OperandLiteral, Value: 5},
				},
				Then: []ast.Node{&ast.NarratorNode{Text: "x"}},
			},
		},
		Gate: unconditionalGate("main:02"),
	}
	errs := Validate(ep)
	found := false
	for _, e := range errs {
		if e.Code == AggregateTooFewArgs {
			found = true
		}
	}
	if !found {
		t.Errorf("expected AGGREGATE_TOO_FEW_ARGS, got %v", errs)
	}
}

// TestAggregateValid pins a well-formed MAX comparison validates cleanly.
func TestAggregateValid(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01", Title: "T",
		Body: []ast.Node{
			&ast.IfNode{
				Condition: &ast.ComparisonCondition{
					Left: &ast.ComparisonOperand{
						Kind: ast.OperandMax,
						Args: []*ast.ComparisonOperand{
							{Kind: ast.OperandAffection, Char: "easton"},
							{Kind: ast.OperandAffection, Char: "diego"},
						},
					},
					Op:    ">=",
					Right: &ast.ComparisonOperand{Kind: ast.OperandLiteral, Value: 5},
				},
				Then: []ast.Node{&ast.NarratorNode{Text: "x"}},
			},
		},
		Gate: unconditionalGate("main:02"),
	}
	errs := Validate(ep)
	if len(errs) != 0 {
		t.Errorf("expected no errors, got %v", errs)
	}
}

// TestPhoneBodyRejectsNonTextMessage pins that @phone only accepts
// TextMessageNode children.
func TestPhoneBodyRejectsNonTextMessage(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01", Title: "T",
		Body: []ast.Node{
			&ast.PhoneShowNode{
				Body: []ast.Node{
					&ast.NarratorNode{Text: "no narration inside phone"},
				},
			},
		},
		Gate: unconditionalGate("main:02"),
	}
	errs := Validate(ep)
	found := false
	for _, e := range errs {
		if e.Code == InvalidPhoneContent {
			found = true
		}
	}
	if !found {
		t.Errorf("expected INVALID_PHONE_CONTENT, got %v", errs)
	}
}

// TestPhoneBodyAcceptsTextMessage pins that text messages inside @phone
// validate cleanly.
func TestPhoneBodyAcceptsTextMessage(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01", Title: "T",
		Body: []ast.Node{
			&ast.PhoneShowNode{
				Body: []ast.Node{
					&ast.TextMessageNode{Direction: "from", Char: "josie", Content: "hi"},
					&ast.TextMessageNode{Direction: "to", Char: "josie", Content: "hi back"},
				},
			},
		},
		Gate: unconditionalGate("main:02"),
	}
	errs := Validate(ep)
	if len(errs) != 0 {
		t.Errorf("expected no errors, got %v", errs)
	}
}

// TestReservedPoseName pins that `bubble` is rejected as a pose name on
// CharShowNode.
func TestReservedPoseName(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01", Title: "T",
		Body: []ast.Node{
			&ast.CharShowNode{Char: "josie", Look: "bubble"},
		},
		Gate: unconditionalGate("main:02"),
	}
	errs := Validate(ep)
	found := false
	for _, e := range errs {
		if e.Code == ReservedKeyword {
			found = true
		}
	}
	if !found {
		t.Errorf("expected RESERVED_KEYWORD for pose 'bubble', got %v", errs)
	}
}
