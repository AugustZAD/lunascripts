package emitter

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/cdotlock/lunascripts/internal/ast"
	"github.com/cdotlock/lunascripts/internal/lexer"
	"github.com/cdotlock/lunascripts/internal/parser"
	"github.com/cdotlock/lunascripts/internal/validator"
)

// mockResolver implements AssetResolver for testing.
type mockResolver struct {
	bg         map[string]string
	characters map[string]map[string]string
	music      map[string]string
	sfx        map[string]string
	cg         map[string]string
	minigames  map[string]string
}

func newMockResolver() *mockResolver {
	return &mockResolver{
		bg: map[string]string{
			"school_classroom": "https://cdn.test/bg/school_classroom.png",
		},
		characters: map[string]map[string]string{
			"alice": {
				"bob__casual__neutral_calm": "https://cdn.test/characters/legacy-owner-mismatch.png",
			},
			"mauricio": {
				"neutral_smirk":      "https://cdn.test/characters/mauricio_neutral_smirk.png",
				"arms_crossed_angry": "https://cdn.test/characters/mauricio_arms_crossed_angry.png",
			},
		},
		music: map[string]string{
			"calm_morning": "https://cdn.test/music/calm_morning.mp3",
		},
		sfx: map[string]string{
			"phone_buzz": "https://cdn.test/sfx/phone_buzz.mp3",
		},
		cg: map[string]string{
			"window_stare": "https://cdn.test/cg/window_stare.mp4",
		},
		minigames: map[string]string{
			"qte_challenge": "https://cdn.test/minigames/qte_challenge/index.html",
		},
	}
}

func (m *mockResolver) ResolveBg(name string) (string, error) {
	if url, ok := m.bg[name]; ok {
		return url, nil
	}
	return "", fmt.Errorf("unknown bg %q", name)
}

func (m *mockResolver) ResolveCharacter(char, poseExpr string) (string, error) {
	if poses, ok := m.characters[char]; ok {
		if url, ok := poses[poseExpr]; ok {
			return url, nil
		}
		return "", fmt.Errorf("unknown pose %q for %q", poseExpr, char)
	}
	return "", fmt.Errorf("unknown character %q", char)
}

func (m *mockResolver) ResolveMusic(name string) (string, error) {
	if url, ok := m.music[name]; ok {
		return url, nil
	}
	return "", fmt.Errorf("unknown music %q", name)
}

func (m *mockResolver) ResolveSfx(name string) (string, error) {
	if url, ok := m.sfx[name]; ok {
		return url, nil
	}
	return "", fmt.Errorf("unknown sfx %q", name)
}

func (m *mockResolver) ResolveCg(name string) (string, error) {
	if url, ok := m.cg[name]; ok {
		return url, nil
	}
	return "", fmt.Errorf("unknown cg %q", name)
}

func (m *mockResolver) ResolveMinigame(gameID string) (string, error) {
	if url, ok := m.minigames[gameID]; ok {
		return url, nil
	}
	return "", fmt.Errorf("unknown minigame %q", gameID)
}

// nextLeaf returns an unconditional NextLeaf-terminated gate route.
func nextLeaf(target string) *ast.GateRoute {
	return &ast.GateRoute{Leaf: &ast.NextLeaf{Target: target}}
}

// endLeaf returns an unconditional EndLeaf-terminated gate route.
func endLeaf(typ string) *ast.GateRoute {
	return &ast.GateRoute{Leaf: &ast.EndLeaf{Type: typ}}
}

func TestEmitMinimal(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01",
		Title:     "Butterfly",
		Body: []ast.Node{
			&ast.BgSetNode{Name: "school_classroom", Transition: "fade"},
			&ast.NarratorNode{Text: "The hallway is empty."},
		},
		Gate: &ast.GateBlock{
			Routes: []*ast.GateRoute{nextLeaf("main:02")},
		},
	}

	em := New(newMockResolver())
	data, err := em.Emit(ep)
	if err != nil {
		t.Fatalf("Emit failed: %v", err)
	}

	var result map[string]interface{}
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatalf("JSON unmarshal failed: %v", err)
	}

	// Check top-level fields.
	if result["ls_contract_version"] != ContractVersion {
		t.Errorf("ls_contract_version = %v, want %q", result["ls_contract_version"], ContractVersion)
	}
	if result["episode_id"] != "main:01" {
		t.Errorf("episode_id = %v, want %q", result["episode_id"], "main:01")
	}
	if result["branch_key"] != "main" {
		t.Errorf("branch_key = %v, want %q", result["branch_key"], "main")
	}
	if result["seq"] != float64(1) {
		t.Errorf("seq = %v, want 1", result["seq"])
	}
	if result["title"] != "Butterfly" {
		t.Errorf("title = %v, want %q", result["title"], "Butterfly")
	}

	// Check steps.
	steps, ok := result["steps"].([]interface{})
	if !ok {
		t.Fatalf("steps is not an array: %T", result["steps"])
	}
	if len(steps) != 2 {
		t.Fatalf("len(steps) = %d, want 2", len(steps))
	}

	// Step 0: bg.
	bg := steps[0].(map[string]interface{})
	if bg["type"] != "bg" {
		t.Errorf("step[0].type = %v, want bg", bg["type"])
	}
	if bg["url"] != "https://cdn.test/bg/school_classroom.png" {
		t.Errorf("step[0].url = %v", bg["url"])
	}
	if bg["transition"] != "fade" {
		t.Errorf("step[0].transition = %v", bg["transition"])
	}

	// Step 1: narrator.
	narr := steps[1].(map[string]interface{})
	if narr["type"] != "narrator" {
		t.Errorf("step[1].type = %v, want narrator", narr["type"])
	}
	if narr["text"] != "The hallway is empty." {
		t.Errorf("step[1].text = %v", narr["text"])
	}

	// Check gate.
	gate, ok := result["gate"].(map[string]interface{})
	if !ok {
		t.Fatalf("gate should be an object, got %T", result["gate"])
	}
	if gate["next"] != "main:02" {
		t.Errorf("gate.next = %v, want main:02", gate["next"])
	}
	if gate["if"] != nil {
		t.Error("gate.if should be nil for unconditional route")
	}

	// No warnings expected.
	if len(em.Warnings) != 0 {
		t.Errorf("unexpected warnings: %v", em.Warnings)
	}
}

func TestCompilePreservesLegacyThreeFieldOwnerMismatch(t *testing.T) {
	src := `@episode main:01 "Legacy three-field look" {
  @alice bob__casual__neutral_calm
  @gate { @end complete }
}`
	ep, err := parser.New(lexer.New(src)).Parse()
	if err != nil {
		t.Fatalf("parse legacy look: %v", err)
	}
	if errs := validator.Validate(ep); len(errs) != 0 {
		t.Fatalf("legacy look must validate unchanged, got %#v", errs)
	}
	out, err := New(newMockResolver()).Emit(ep)
	if err != nil {
		t.Fatalf("emit legacy look: %v", err)
	}
	var result map[string]interface{}
	if err := json.Unmarshal(out, &result); err != nil {
		t.Fatalf("decode emitted JSON: %v", err)
	}
	steps := result["steps"].([]interface{})
	show := steps[0].(map[string]interface{})
	if show["character"] != "alice" || show["look"] != "bob__casual__neutral_calm" {
		t.Fatalf("emitted character look = %q/%q, want unchanged alice/bob__casual__neutral_calm", show["character"], show["look"])
	}
}

func TestEmitChoice(t *testing.T) {
	// Brave option body uses @if (check.success) { ... } @else { ... }.
	ep := &ast.Episode{
		BranchKey: "main:01",
		Title:     "The Choice",
		Body: []ast.Node{
			&ast.ChoiceNode{
				Options: []*ast.OptionNode{
					{
						ID:   "A",
						Mode: "brave",
						Text: "Confront him",
						Check: &ast.CheckBlock{
							Attr: "CHA",
							DC:   14,
						},
						Body: []ast.Node{
							&ast.IfNode{
								Condition: &ast.CheckCondition{Result: "success"},
								Then: []ast.Node{
									&ast.DialogueNode{Character: "MAURICIO", Text: "You got guts."},
								},
								Else: []ast.Node{
									&ast.DialogueNode{Character: "MAURICIO", Text: "Nice try."},
								},
							},
						},
					},
					{
						ID:   "B",
						Mode: "safe",
						Text: "Walk away",
						Body: []ast.Node{
							&ast.NarratorNode{Text: "You turn around quietly."},
						},
					},
				},
			},
		},
		Gate: &ast.GateBlock{
			Routes: []*ast.GateRoute{nextLeaf("main:02")},
		},
	}

	em := New(newMockResolver())
	data, err := em.Emit(ep)
	if err != nil {
		t.Fatalf("Emit failed: %v", err)
	}

	var result map[string]interface{}
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatalf("JSON unmarshal failed: %v", err)
	}

	steps := result["steps"].([]interface{})
	if len(steps) != 1 {
		t.Fatalf("len(steps) = %d, want 1", len(steps))
	}

	choice := steps[0].(map[string]interface{})
	if choice["type"] != "choice" {
		t.Errorf("type = %v, want choice", choice["type"])
	}

	options := choice["options"].([]interface{})
	if len(options) != 2 {
		t.Fatalf("len(options) = %d, want 2", len(options))
	}

	// Option A: brave.
	optA := options[0].(map[string]interface{})
	if optA["id"] != "A" {
		t.Errorf("optA.id = %v", optA["id"])
	}
	if optA["mode"] != "brave" {
		t.Errorf("optA.mode = %v", optA["mode"])
	}
	if optA["text"] != "Confront him" {
		t.Errorf("optA.text = %v", optA["text"])
	}

	check := optA["check"].(map[string]interface{})
	if check["attr"] != "CHA" {
		t.Errorf("check.attr = %v", check["attr"])
	}
	if check["dc"] != float64(14) {
		t.Errorf("check.dc = %v", check["dc"])
	}

	stepsA := optA["steps"].([]interface{})
	if len(stepsA) != 1 {
		t.Fatalf("len(optA.steps) = %d, want 1 (the @if tree)", len(stepsA))
	}
	ifStep := stepsA[0].(map[string]interface{})
	if ifStep["type"] != "if" {
		t.Errorf("optA.steps[0].type = %v, want 'if'", ifStep["type"])
	}
	cond := ifStep["condition"].(map[string]interface{})
	if cond["type"] != "check" {
		t.Errorf("optA.steps[0].condition.type = %v, want 'check'", cond["type"])
	}
	if cond["result"] != "success" {
		t.Errorf("optA.steps[0].condition.result = %v, want 'success'", cond["result"])
	}

	// Option B: safe.
	optB := options[1].(map[string]interface{})
	if optB["id"] != "B" {
		t.Errorf("optB.id = %v", optB["id"])
	}
	if optB["mode"] != "safe" {
		t.Errorf("optB.mode = %v", optB["mode"])
	}
	if optB["check"] != nil {
		t.Errorf("optB.check should be nil for safe option")
	}

	stepsB := optB["steps"].([]interface{})
	if len(stepsB) != 1 {
		t.Fatalf("len(stepsB) = %d, want 1", len(stepsB))
	}
	if stepsB[0].(map[string]interface{})["type"] != "narrator" {
		t.Errorf("optB.steps[0].type = %v", stepsB[0].(map[string]interface{})["type"])
	}
}

func TestEmitConcurrentGrouping(t *testing.T) {
	musicNode := &ast.MusicSetNode{Name: "calm_morning"}
	musicNode.SetConcurrent(true)
	charNode := &ast.CharShowNode{Char: "mauricio", Look: "neutral_smirk"}
	charNode.SetConcurrent(true)

	ep := &ast.Episode{
		BranchKey: "main:01",
		Title:     "Concurrent",
		Body: []ast.Node{
			// Group: bg (leader) + music (concurrent) + char_show (concurrent)
			&ast.BgSetNode{Name: "school_classroom", Transition: "fade"},
			musicNode,
			charNode,
			// Standalone narrator
			&ast.NarratorNode{Text: "Hello."},
			// Pause
			&ast.PauseNode{},
		},
		Gate: &ast.GateBlock{
			Routes: []*ast.GateRoute{nextLeaf("main:02")},
		},
	}

	em := New(newMockResolver())
	data, err := em.Emit(ep)
	if err != nil {
		t.Fatalf("Emit failed: %v", err)
	}

	var result map[string]interface{}
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatalf("JSON unmarshal failed: %v", err)
	}

	steps := result["steps"].([]interface{})
	if len(steps) != 3 {
		t.Fatalf("len(steps) = %d, want 3 (1 group + 1 narrator + 1 pause)", len(steps))
	}

	// Step 0: concurrent group (array of 3 items)
	group, ok := steps[0].([]interface{})
	if !ok {
		t.Fatalf("steps[0] should be an array (concurrent group), got %T", steps[0])
	}
	if len(group) != 3 {
		t.Fatalf("concurrent group length: got %d, want 3", len(group))
	}
	bgStep := group[0].(map[string]interface{})
	if bgStep["type"] != "bg" {
		t.Errorf("group[0].type = %v, want bg", bgStep["type"])
	}
	musicStep := group[1].(map[string]interface{})
	if musicStep["type"] != "music" {
		t.Errorf("group[1].type = %v, want music", musicStep["type"])
	}
	if musicStep["name"] != "calm_morning" {
		t.Errorf("group[1].name = %v, want calm_morning", musicStep["name"])
	}
	charStep := group[2].(map[string]interface{})
	if charStep["type"] != "char_show" {
		t.Errorf("group[2].type = %v, want char_show", charStep["type"])
	}
	// New AST: char_show has no `position`.
	if _, has := charStep["position"]; has {
		t.Error("char_show must not emit a 'position' field in the new model")
	}

	// Step 1: narrator (standalone object)
	narr := steps[1].(map[string]interface{})
	if narr["type"] != "narrator" {
		t.Errorf("steps[1].type = %v, want narrator", narr["type"])
	}

	// Step 2: pause — no `clicks` field in the new model.
	pauseStep := steps[2].(map[string]interface{})
	if pauseStep["type"] != "pause" {
		t.Errorf("steps[2].type = %v, want pause", pauseStep["type"])
	}
	if _, has := pauseStep["clicks"]; has {
		t.Error("pause must not emit a 'clicks' field in the new model")
	}
}

func TestEmitDialogueLowercase(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01", Title: "T",
		Body: []ast.Node{
			&ast.DialogueNode{Character: "JOSIE", Text: "Hi."},
		},
		Gate: &ast.GateBlock{Routes: []*ast.GateRoute{nextLeaf("main:02")}},
	}
	em := New(newMockResolver())
	data, _ := em.Emit(ep)
	if !strings.Contains(string(data), `"character": "josie"`) {
		t.Error("expected lowercase character name in dialogue")
	}
}

func TestEmitGateNull(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01", Title: "T",
		Body: []ast.Node{&ast.NarratorNode{Text: "Hi."}},
	}
	em := New(newMockResolver())
	data, _ := em.Emit(ep)
	if !strings.Contains(string(data), `"gate": null`) {
		t.Error("expected gate: null when no gate")
	}
}

func TestEmitGateConditional(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01", Title: "T",
		Body: []ast.Node{&ast.NarratorNode{Text: "Hi."}},
		Gate: &ast.GateBlock{
			Routes: []*ast.GateRoute{
				{Condition: &ast.ChoiceCondition{Option: "A", Result: "fail"}, Leaf: &ast.NextLeaf{Target: "bad:01"}},
				{Condition: &ast.FlagCondition{Name: "EP01_DONE"}, Leaf: &ast.NextLeaf{Target: "mid:01"}},
				{Leaf: &ast.NextLeaf{Target: "main:02"}},
			},
		},
	}
	em := New(newMockResolver())
	data, _ := em.Emit(ep)
	s := string(data)
	if !strings.Contains(s, `"if"`) {
		t.Error("expected nested if in gate")
	}
	if !strings.Contains(s, `"else"`) {
		t.Error("expected else in gate chain")
	}
}

// TestEmitConditionTypes covers all five condition kinds.
func TestEmitConditionTypes(t *testing.T) {
	tests := []struct {
		name string
		cond ast.Condition
	}{
		{"choice", &ast.ChoiceCondition{Option: "A", Result: "fail"}},
		{"flag", &ast.FlagCondition{Name: "EP01"}},
		{"comparison", &ast.ComparisonCondition{
			Left:  &ast.ComparisonOperand{Kind: ast.OperandValue, Name: "x"},
			Op:    ">=",
			Right: &ast.ComparisonOperand{Kind: ast.OperandLiteral, Value: 5},
		}},
		{"check", &ast.CheckCondition{Result: "success"}},
		{"compound", &ast.CompoundCondition{
			Op:    "&&",
			Left:  &ast.FlagCondition{Name: "a"},
			Right: &ast.FlagCondition{Name: "b"},
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ep := &ast.Episode{
				BranchKey: "main:01", Title: "T",
				Body: []ast.Node{
					&ast.IfNode{Condition: tt.cond, Then: []ast.Node{&ast.NarratorNode{Text: "Hi."}}},
				},
				Gate: &ast.GateBlock{Routes: []*ast.GateRoute{nextLeaf("main:02")}},
			}
			em := New(newMockResolver())
			data, _ := em.Emit(ep)
			s := string(data)
			if !strings.Contains(s, fmt.Sprintf(`"type": "%s"`, tt.name)) {
				t.Errorf("expected condition type %q in output", tt.name)
			}
		})
	}
}

func TestEmitElseIfUnwrap(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01", Title: "T",
		Body: []ast.Node{
			&ast.IfNode{
				Condition: &ast.FlagCondition{Name: "A"},
				Then:      []ast.Node{&ast.NarratorNode{Text: "a"}},
				Else: []ast.Node{
					&ast.IfNode{
						Condition: &ast.FlagCondition{Name: "B"},
						Then:      []ast.Node{&ast.NarratorNode{Text: "b"}},
					},
				},
			},
		},
		Gate: &ast.GateBlock{Routes: []*ast.GateRoute{nextLeaf("main:02")}},
	}
	em := New(newMockResolver())
	data, _ := em.Emit(ep)
	s := string(data)
	// The else should be a bare object (not wrapped in array).
	if strings.Contains(s, `"else": [`) {
		t.Error("@else @if should produce bare object, not array")
	}
}

// TestEmitAllNodeTypes ensures every current AST node type emits without panic.
func TestEmitAllNodeTypes(t *testing.T) {
	nodes := []ast.Node{
		&ast.BgSetNode{Name: "bg1", Transition: "fade"},
		&ast.CharShowNode{Char: "c", Look: "l"},
		&ast.CharBubbleNode{Char: "c", BubbleType: "heart"},
		&ast.CgShowNode{Name: "cg1", Content: "story"},
		&ast.DialogueNode{Character: "CHAR", Text: "hi"},
		&ast.NarratorNode{Text: "n"},
		&ast.YouNode{Text: "y"},
		&ast.PhoneShowNode{Body: []ast.Node{
			&ast.TextMessageNode{Direction: "from", Char: "C", Content: "hi"},
		}},
		&ast.MusicSetNode{Name: "t"},
		&ast.MusicStopNode{},
		&ast.SfxNode{Name: "s"},
		&ast.MinigameNode{Name: "g", Description: "d"},
		&ast.TrickNode{Type: ast.TrickTap, Prompt: "tap."},
		&ast.AffectionNode{Char: "c", Delta: "+1"},
		&ast.SignalNode{Kind: ast.SignalKindMark, Event: "E"},
		&ast.ButterflyNode{Description: "d"},
		&ast.AchievementNode{ID: "X", Name: "n", Rarity: ast.RarityRare, Description: "d"},
		&ast.PauseNode{},
	}
	ep := &ast.Episode{
		BranchKey: "main:01", Title: "T",
		Body: nodes,
		Gate: &ast.GateBlock{Routes: []*ast.GateRoute{nextLeaf("main:02")}},
	}
	em := New(newMockResolver())
	data, err := em.Emit(ep)
	if err != nil {
		t.Fatalf("Emit failed: %v", err)
	}
	if len(data) == 0 {
		t.Error("empty output")
	}
}

func TestEmitAssetWarning(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01", Title: "T",
		Body: []ast.Node{
			&ast.BgSetNode{Name: "nonexistent"},
		},
		Gate: &ast.GateBlock{Routes: []*ast.GateRoute{nextLeaf("main:02")}},
	}
	em := New(newMockResolver())
	em.Emit(ep)
	if len(em.Warnings) == 0 {
		t.Error("expected warning for unknown asset")
	}
}

// TestEmitEndingKey verifies that Episode.Ending (Scheme B lowering target)
// produces a structured "ending" key and absence produces null.
func TestEmitEndingKey(t *testing.T) {
	r := &mockResolver{}
	e := New(r)

	ep := &ast.Episode{
		BranchKey: "main:15",
		Title:     "Finale",
		Body:      []ast.Node{&ast.NarratorNode{Text: "The end."}},
		Ending:    &ast.EndingNode{Type: ast.EndingComplete},
	}
	out, err := e.Emit(ep)
	if err != nil {
		t.Fatalf("Emit err: %v", err)
	}
	var parsed map[string]interface{}
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatalf("unmarshal err: %v", err)
	}
	ending, ok := parsed["ending"].(map[string]interface{})
	if !ok {
		t.Fatalf("ending: got %v, want map[string]interface{}", parsed["ending"])
	}
	if ending["type"] != "complete" {
		t.Errorf("ending.type: got %v, want complete", ending["type"])
	}
	if parsed["gate"] != nil {
		t.Errorf("gate: got %v, want nil (ending is set)", parsed["gate"])
	}
}

func TestEmitEndingAbsent(t *testing.T) {
	r := &mockResolver{}
	e := New(r)

	ep := &ast.Episode{
		BranchKey: "main:01",
		Title:     "Normal",
		Body:      []ast.Node{&ast.NarratorNode{Text: "Hi."}},
		Gate: &ast.GateBlock{
			Routes: []*ast.GateRoute{nextLeaf("main:02")},
		},
	}
	out, err := e.Emit(ep)
	if err != nil {
		t.Fatalf("Emit err: %v", err)
	}
	var parsed map[string]interface{}
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatalf("unmarshal err: %v", err)
	}
	if _, present := parsed["ending"]; !present {
		t.Error("ending key should always be present (null when absent)")
	}
	if parsed["ending"] != nil {
		t.Errorf("ending: got %v, want nil", parsed["ending"])
	}
}

// TestEmitSchemeBLowering verifies that the degenerate
// `@gate { @end TYPE }` shape is lowered to Episode.Ending with `gate: null`.
func TestEmitSchemeBLowering(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01", Title: "T",
		Body: []ast.Node{&ast.NarratorNode{Text: "Hi."}},
		Gate: &ast.GateBlock{
			Routes: []*ast.GateRoute{endLeaf(ast.EndingBad)},
		},
	}
	em := New(newMockResolver())
	data, err := em.Emit(ep)
	if err != nil {
		t.Fatalf("Emit failed: %v", err)
	}
	var result map[string]interface{}
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if result["gate"] != nil {
		t.Errorf("gate should be null after Scheme B lowering, got %v", result["gate"])
	}
	ending, ok := result["ending"].(map[string]interface{})
	if !ok {
		t.Fatalf("ending should be a map after Scheme B lowering, got %T", result["ending"])
	}
	if ending["type"] != "bad_ending" {
		t.Errorf("ending.type = %v, want bad_ending", ending["type"])
	}
}

// TestEmitGateConditionalEndDoesNotLower verifies that conditional `@end`
// leaves are NOT collapsed into Episode.Ending — only the unconditional
// single-route shape is lowered.
func TestEmitGateConditionalEndDoesNotLower(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01", Title: "T",
		Body: []ast.Node{&ast.NarratorNode{Text: "Hi."}},
		Gate: &ast.GateBlock{
			Routes: []*ast.GateRoute{
				{
					Condition: &ast.FlagCondition{Name: "WIN"},
					Leaf:      &ast.EndLeaf{Type: ast.EndingComplete},
				},
				endLeaf(ast.EndingBad),
			},
		},
	}
	em := New(newMockResolver())
	data, err := em.Emit(ep)
	if err != nil {
		t.Fatalf("Emit failed: %v", err)
	}
	var result map[string]interface{}
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if result["gate"] == nil {
		t.Error("conditional end leaf must remain in gate (not lowered)")
	}
	if result["ending"] != nil {
		t.Errorf("ending should be nil when gate has conditions, got %v", result["ending"])
	}
}

// TestEmitGateMixedNextAndEnd verifies a gate can mix @next and @end leaves.
func TestEmitGateMixedNextAndEnd(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01", Title: "T",
		Body: []ast.Node{&ast.NarratorNode{Text: "Hi."}},
		Gate: &ast.GateBlock{
			Routes: []*ast.GateRoute{
				{
					Condition: &ast.ComparisonCondition{
						Left:  &ast.ComparisonOperand{Kind: ast.OperandValue, Name: "REJECTIONS"},
						Op:    ">=",
						Right: &ast.ComparisonOperand{Kind: ast.OperandLiteral, Value: 3},
					},
					Leaf: &ast.EndLeaf{Type: ast.EndingBad},
				},
				{
					Condition: &ast.FlagCondition{Name: "HEROIC"},
					Leaf:      &ast.EndLeaf{Type: ast.EndingComplete},
				},
				{Leaf: &ast.NextLeaf{Target: "main:02"}},
			},
		},
	}
	em := New(newMockResolver())
	data, _ := em.Emit(ep)
	var result map[string]interface{}
	json.Unmarshal(data, &result)

	gate, ok := result["gate"].(map[string]interface{})
	if !ok {
		t.Fatalf("gate should be a map, got %T", result["gate"])
	}
	if gate["end"] != "bad_ending" {
		t.Errorf("gate.end = %v, want bad_ending", gate["end"])
	}
	if _, has := gate["next"]; has {
		t.Error("gate root should not carry next (only end here)")
	}
	elseLvl := gate["else"].(map[string]interface{})
	if elseLvl["end"] != "complete" {
		t.Errorf("gate.else.end = %v, want complete", elseLvl["end"])
	}
	fallback := elseLvl["else"].(map[string]interface{})
	if fallback["next"] != "main:02" {
		t.Errorf("fallback next = %v, want main:02", fallback["next"])
	}
}

// TestEmitAchievementStep verifies @achievement emits an inline step
// carrying id, name, rarity, description.
func TestEmitAchievementStep(t *testing.T) {
	r := &mockResolver{}
	e := New(r)

	ep := &ast.Episode{
		BranchKey: "main:01",
		Title:     "T",
		Body: []ast.Node{
			&ast.AchievementNode{
				ID:          "HEEL_WARRIOR",
				Name:        "Heel Warrior",
				Rarity:      ast.RarityRare,
				Description: "desc",
			},
		},
		Gate: &ast.GateBlock{Routes: []*ast.GateRoute{nextLeaf("main:02")}},
	}
	out, err := e.Emit(ep)
	if err != nil {
		t.Fatalf("Emit err: %v", err)
	}
	var parsed map[string]interface{}
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, has := parsed["achievements"]; has {
		t.Error("top-level 'achievements' key should not be present")
	}
	steps := parsed["steps"].([]interface{})
	if len(steps) != 1 {
		t.Fatalf("steps len: got %d, want 1", len(steps))
	}
	step := steps[0].(map[string]interface{})
	if step["type"] != "achievement" {
		t.Errorf("step type: got %v, want 'achievement'", step["type"])
	}
	for _, key := range []string{"achievement_id", "name", "rarity", "description"} {
		if _, ok := step[key]; !ok {
			t.Errorf("achievement step missing %q key", key)
		}
	}
	if step["achievement_id"] != "HEEL_WARRIOR" {
		t.Errorf("achievement_id: got %v, want HEEL_WARRIOR", step["achievement_id"])
	}
	if step["rarity"] != "rare" {
		t.Errorf("rarity: got %v", step["rarity"])
	}
	if step["id"] != "0001_ach" {
		t.Errorf("step.id: got %v, want 0001_ach", step["id"])
	}
}

func TestEmitNoTopLevelAchievementsKey(t *testing.T) {
	r := &mockResolver{}
	e := New(r)

	ep := &ast.Episode{
		BranchKey: "main:01",
		Title:     "T",
		Body:      []ast.Node{&ast.NarratorNode{Text: "hi"}},
		Gate:      &ast.GateBlock{Routes: []*ast.GateRoute{nextLeaf("main:02")}},
	}
	out, err := e.Emit(ep)
	if err != nil {
		t.Fatalf("Emit err: %v", err)
	}
	if strings.Contains(string(out), `"achievements"`) {
		t.Errorf("top-level 'achievements' key should not appear:\n%s", string(out))
	}
}

func TestEmitSignalKind(t *testing.T) {
	r := &mockResolver{}
	e := New(r)

	ep := &ast.Episode{
		BranchKey: "main:01",
		Title:     "T",
		Body: []ast.Node{
			&ast.SignalNode{Kind: ast.SignalKindMark, Event: "A"},
		},
		Gate: &ast.GateBlock{Routes: []*ast.GateRoute{nextLeaf("main:02")}},
	}
	out, err := e.Emit(ep)
	if err != nil {
		t.Fatalf("Emit err: %v", err)
	}
	s := string(out)
	if !strings.Contains(s, `"kind": "mark"`) {
		t.Errorf("missing mark kind:\n%s", s)
	}
	if !strings.Contains(s, `"event": "A"`) {
		t.Errorf("missing event:\n%s", s)
	}
}

// firstBodyStep parses + emits an episode source and returns the first
// step of the resulting JSON, as a generic map.
func firstBodyStep(t *testing.T, src string) map[string]interface{} {
	t.Helper()
	l := lexer.New(src)
	p := parser.New(l)
	ep, err := p.Parse()
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	e := New(newMockResolver())
	data, err := e.Emit(ep)
	if err != nil {
		t.Fatalf("emit: %v", err)
	}
	var m map[string]interface{}
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	steps := m["steps"].([]interface{})
	first := steps[0]
	if arr, ok := first.([]interface{}); ok && len(arr) == 1 {
		return arr[0].(map[string]interface{})
	}
	return first.(map[string]interface{})
}

func assertStepEquals(t *testing.T, got, want map[string]interface{}) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("step mismatch\nwant: %#v\n got: %#v", want, got)
	}
}

func TestEmitSignalIntAssign(t *testing.T) {
	src := `@episode main:01 "t" {
  @signal int REJECTIONS = 0
  @gate { @end complete }
}`
	step := firstBodyStep(t, src)
	want := map[string]interface{}{
		"id":    "0001_sig",
		"type":  "signal",
		"kind":  "int",
		"name":  "REJECTIONS",
		"op":    "=",
		"value": float64(0),
	}
	assertStepEquals(t, step, want)
}

func TestEmitSignalIntAdd(t *testing.T) {
	src := `@episode main:01 "t" {
  @signal int REJECTIONS +1
  @gate { @end complete }
}`
	step := firstBodyStep(t, src)
	want := map[string]interface{}{
		"id":    "0001_sig",
		"type":  "signal",
		"kind":  "int",
		"name":  "REJECTIONS",
		"op":    "+",
		"value": float64(1),
	}
	assertStepEquals(t, step, want)
}

func TestEmitSignalIntSub(t *testing.T) {
	src := `@episode main:01 "t" {
  @signal int REJECTIONS -2
  @gate { @end complete }
}`
	step := firstBodyStep(t, src)
	want := map[string]interface{}{
		"id":    "0001_sig",
		"type":  "signal",
		"kind":  "int",
		"name":  "REJECTIONS",
		"op":    "-",
		"value": float64(2),
	}
	assertStepEquals(t, step, want)
}

func TestEmitSignalMarkUnchanged(t *testing.T) {
	src := `@episode main:01 "t" {
  @signal mark HIGH_HEEL_EP05
  @gate { @end complete }
}`
	step := firstBodyStep(t, src)
	want := map[string]interface{}{
		"id":    "0001_sig",
		"type":  "signal",
		"kind":  "mark",
		"event": "HIGH_HEEL_EP05",
	}
	assertStepEquals(t, step, want)
}

func TestEmitIfReadsIntVariableAsComparison(t *testing.T) {
	src := `@episode main:01 "t" {
  @if (REJECTIONS >= 3) {
    NARRATOR: too many
  }
  @gate { @end complete }
}`
	step := firstBodyStep(t, src)
	if step["type"] != "if" {
		t.Fatalf("expected if, got %v", step["type"])
	}
	cond := step["condition"].(map[string]interface{})
	if cond["type"] != "comparison" {
		t.Fatalf("expected comparison, got %v", cond["type"])
	}
	left := cond["left"].(map[string]interface{})
	if left["kind"] != "value" || left["name"] != "REJECTIONS" {
		t.Fatalf("unexpected left: %#v", left)
	}
	if cond["op"] != ">=" {
		t.Fatalf("unexpected op: %v", cond["op"])
	}
	right := cond["right"].(map[string]interface{})
	if right["kind"] != "literal" || right["value"].(float64) != 3 {
		t.Fatalf("unexpected right: %#v", right)
	}
}

// ---------- Operand tests (5 kinds: literal / affection / value / max / min) ----------

func TestEmitOperandLiteral(t *testing.T) {
	src := `@episode main:01 "t" {
  @if (affection.easton >= 5) {
    NARRATOR: warm
  }
  @gate { @end complete }
}`
	step := firstBodyStep(t, src)
	cond := step["condition"].(map[string]interface{})
	right := cond["right"].(map[string]interface{})
	if right["kind"] != "literal" {
		t.Errorf("right.kind = %v, want literal", right["kind"])
	}
	if right["value"].(float64) != 5 {
		t.Errorf("right.value = %v, want 5", right["value"])
	}
}

func TestEmitOperandAffection(t *testing.T) {
	src := `@episode main:01 "t" {
  @if (affection.easton >= 5) {
    NARRATOR: warm
  }
  @gate { @end complete }
}`
	step := firstBodyStep(t, src)
	cond := step["condition"].(map[string]interface{})
	left := cond["left"].(map[string]interface{})
	if left["kind"] != "affection" || left["char"] != "easton" {
		t.Errorf("left = %#v, want affection/easton", left)
	}
}

func TestEmitOperandVsOperandComparison(t *testing.T) {
	// affection.easton > affection.diego
	src := `@episode main:01 "t" {
  @if (affection.easton > affection.diego) {
    NARRATOR: closer to easton
  }
  @gate { @end complete }
}`
	step := firstBodyStep(t, src)
	cond := step["condition"].(map[string]interface{})
	left := cond["left"].(map[string]interface{})
	right := cond["right"].(map[string]interface{})
	if left["kind"] != "affection" || left["char"] != "easton" {
		t.Errorf("left = %#v, want affection/easton", left)
	}
	if right["kind"] != "affection" || right["char"] != "diego" {
		t.Errorf("right = %#v, want affection/diego", right)
	}
	if cond["op"] != ">" {
		t.Errorf("op = %v, want >", cond["op"])
	}
}

func TestEmitOperandLiteralOnLeft(t *testing.T) {
	// 5 < affection.easton
	src := `@episode main:01 "t" {
  @if (5 < affection.easton) {
    NARRATOR: warm
  }
  @gate { @end complete }
}`
	step := firstBodyStep(t, src)
	cond := step["condition"].(map[string]interface{})
	left := cond["left"].(map[string]interface{})
	if left["kind"] != "literal" || left["value"].(float64) != 5 {
		t.Errorf("left = %#v, want literal 5", left)
	}
}

func TestEmitOperandMax2Args(t *testing.T) {
	src := `@episode main:01 "t" {
  @if (MAX(affection.easton, affection.diego) >= 5) {
    NARRATOR: somebody likes you
  }
  @gate { @end complete }
}`
	step := firstBodyStep(t, src)
	cond := step["condition"].(map[string]interface{})
	left := cond["left"].(map[string]interface{})
	if left["kind"] != "max" {
		t.Fatalf("left.kind = %v, want max", left["kind"])
	}
	args := left["args"].([]interface{})
	if len(args) != 2 {
		t.Fatalf("max.args length = %d, want 2", len(args))
	}
	for _, a := range args {
		am := a.(map[string]interface{})
		if am["kind"] != "affection" {
			t.Errorf("max.args[*].kind = %v, want affection", am["kind"])
		}
	}
}

func TestEmitOperandMin3Args(t *testing.T) {
	src := `@episode main:01 "t" {
  @if (MIN(affection.easton, affection.diego, affection.mauricio) >= 2) {
    NARRATOR: all warming up
  }
  @gate { @end complete }
}`
	step := firstBodyStep(t, src)
	cond := step["condition"].(map[string]interface{})
	left := cond["left"].(map[string]interface{})
	if left["kind"] != "min" {
		t.Fatalf("left.kind = %v, want min", left["kind"])
	}
	args := left["args"].([]interface{})
	if len(args) != 3 {
		t.Fatalf("min.args length = %d, want 3", len(args))
	}
}

func TestEmitOperandMax4Args(t *testing.T) {
	src := `@episode main:01 "t" {
  @if (MAX(affection.easton, affection.diego, affection.mauricio, affection.mark) >= 10) {
    NARRATOR: harem
  }
  @gate { @end complete }
}`
	step := firstBodyStep(t, src)
	cond := step["condition"].(map[string]interface{})
	left := cond["left"].(map[string]interface{})
	if left["kind"] != "max" {
		t.Fatalf("left.kind = %v, want max", left["kind"])
	}
	args := left["args"].([]interface{})
	if len(args) != 4 {
		t.Fatalf("max.args length = %d, want 4", len(args))
	}
}

func TestEmitOperandMaxMixedKinds(t *testing.T) {
	// max(affection, value, literal)
	src := `@episode main:01 "t" {
  @if (MAX(affection.easton, REJECTIONS, 5) >= 7) {
    NARRATOR: above floor
  }
  @gate { @end complete }
}`
	step := firstBodyStep(t, src)
	cond := step["condition"].(map[string]interface{})
	left := cond["left"].(map[string]interface{})
	args := left["args"].([]interface{})
	if len(args) != 3 {
		t.Fatalf("args length = %d, want 3", len(args))
	}
	a0 := args[0].(map[string]interface{})
	a1 := args[1].(map[string]interface{})
	a2 := args[2].(map[string]interface{})
	if a0["kind"] != "affection" {
		t.Errorf("args[0].kind = %v, want affection", a0["kind"])
	}
	if a1["kind"] != "value" || a1["name"] != "REJECTIONS" {
		t.Errorf("args[1] = %#v, want value/REJECTIONS", a1)
	}
	if a2["kind"] != "literal" || a2["value"].(float64) != 5 {
		t.Errorf("args[2] = %#v, want literal 5", a2)
	}
}

func TestEmitOperandRecursiveNesting(t *testing.T) {
	// MAX(affection.easton, MIN(affection.diego, affection.mauricio)) >= 5
	src := `@episode main:01 "t" {
  @if (MAX(affection.easton, MIN(affection.diego, affection.mauricio)) >= 5) {
    NARRATOR: yes
  }
  @gate { @end complete }
}`
	step := firstBodyStep(t, src)
	cond := step["condition"].(map[string]interface{})
	left := cond["left"].(map[string]interface{})
	if left["kind"] != "max" {
		t.Fatalf("outer kind = %v, want max", left["kind"])
	}
	args := left["args"].([]interface{})
	if len(args) != 2 {
		t.Fatalf("outer args length = %d, want 2", len(args))
	}
	inner := args[1].(map[string]interface{})
	if inner["kind"] != "min" {
		t.Errorf("nested kind = %v, want min", inner["kind"])
	}
	innerArgs := inner["args"].([]interface{})
	if len(innerArgs) != 2 {
		t.Fatalf("inner args length = %d, want 2", len(innerArgs))
	}
}

// ---------- Step ID tests (Task 1: Stable Step ID & Content-Addressed Cursor) ----------

// TestStepTypeTag verifies the type-tag mapping is exactly the documented
// contract. Backends key persisted player cursors on these tags — changing
// any value here is a breaking schema change requiring a data migration.
func TestStepTypeTag(t *testing.T) {
	tests := []struct {
		stepType string
		want     string
	}{
		{"dialogue", "dlg"},
		{"narrator", "nar"},
		{"you", "you"},
		{"pause", "pau"},
		{"choice", "ch"},
		{"minigame", "mg"},
		{"trick", "trk"},
		{"cg_show", "cg"},
		{"bg", "bg"},
		{"char_show", "char"},
		{"bubble", "char"},
		{"music", "mus"},
		{"music_stop", "mus"},
		{"sfx", "sfx"},
		{"phone_show", "phn"},
		{"text_message", "phn"},
		{"signal", "sig"},
		{"affection", "aff"},
		{"achievement", "ach"},
		{"butterfly", "btf"},
		{"if", "ctrl"},
		{"unknown_future_type", "unk"},
	}
	for _, tt := range tests {
		t.Run(tt.stepType, func(t *testing.T) {
			if got := stepTypeTag(tt.stepType); got != tt.want {
				t.Errorf("stepTypeTag(%q) = %q, want %q", tt.stepType, got, tt.want)
			}
		})
	}
}

// TestStepIDFormatTopLevel verifies that top-level steps get sequential
// episode-scoped 4-digit ids, in declaration order.
func TestStepIDFormatTopLevel(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01",
		Title:     "T",
		Body: []ast.Node{
			&ast.NarratorNode{Text: "1"},
			&ast.DialogueNode{Character: "JOSIE", Text: "2"},
			&ast.YouNode{Text: "3"},
			&ast.PauseNode{},
			&ast.BgSetNode{Name: "x"},
			&ast.MusicSetNode{Name: "m"},
		},
		Gate: &ast.GateBlock{Routes: []*ast.GateRoute{nextLeaf("main:02")}},
	}
	em := New(newMockResolver())
	data, err := em.Emit(ep)
	if err != nil {
		t.Fatalf("Emit: %v", err)
	}
	var result map[string]interface{}
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	steps := result["steps"].([]interface{})

	wantIDs := []string{"0001_nar", "0002_dlg", "0003_you", "0004_pau", "0005_bg", "0006_mus"}
	if len(steps) != len(wantIDs) {
		t.Fatalf("len(steps)=%d, want %d", len(steps), len(wantIDs))
	}
	for i, want := range wantIDs {
		step := steps[i].(map[string]interface{})
		if got := step["id"]; got != want {
			t.Errorf("steps[%d].id = %v, want %q", i, got, want)
		}
	}
}

// TestStepIDConcurrentGroupSharesParentCounter verifies a concurrent
// group consumes sequential seqs from the parent container — it is NOT a
// nested 0001 restart.
func TestStepIDConcurrentGroupSharesParentCounter(t *testing.T) {
	bg := &ast.BgSetNode{Name: "bg1"}
	music := &ast.MusicSetNode{Name: "calm_morning"}
	music.SetConcurrent(true)
	char := &ast.CharShowNode{Char: "mauricio", Look: "neutral_smirk"}
	char.SetConcurrent(true)
	narr := &ast.NarratorNode{Text: "after"}

	ep := &ast.Episode{
		BranchKey: "main:01",
		Title:     "T",
		Body:      []ast.Node{bg, music, char, narr},
		Gate:      &ast.GateBlock{Routes: []*ast.GateRoute{nextLeaf("main:02")}},
	}
	em := New(newMockResolver())
	data, err := em.Emit(ep)
	if err != nil {
		t.Fatalf("Emit: %v", err)
	}
	var result map[string]interface{}
	json.Unmarshal(data, &result)
	steps := result["steps"].([]interface{})

	group, ok := steps[0].([]interface{})
	if !ok {
		t.Fatalf("steps[0] should be array, got %T", steps[0])
	}
	if len(group) != 3 {
		t.Fatalf("group length = %d, want 3", len(group))
	}
	wantGroupIDs := []string{"0001_bg", "0002_mus", "0003_char"}
	for i, want := range wantGroupIDs {
		g := group[i].(map[string]interface{})
		if g["id"] != want {
			t.Errorf("group[%d].id = %v, want %q", i, g["id"], want)
		}
	}

	narrStep := steps[1].(map[string]interface{})
	if narrStep["id"] != "0004_nar" {
		t.Errorf("narrator after group should be 0004_nar, got %v", narrStep["id"])
	}
}

// TestStepIDChoiceContinuesCounter verifies that choice option bodies
// continue the episode-scoped COUNTER.
func TestStepIDChoiceContinuesCounter(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01",
		Title:     "T",
		Body: []ast.Node{
			&ast.NarratorNode{Text: "intro"},  // 0001_nar
			&ast.NarratorNode{Text: "intro2"}, // 0002_nar
			&ast.ChoiceNode{ // 0003_ch
				Options: []*ast.OptionNode{
					{
						ID:   "A",
						Mode: "safe",
						Text: "A",
						Body: []ast.Node{
							&ast.DialogueNode{Character: "X", Text: "a1"},
							&ast.NarratorNode{Text: "a2"},
							&ast.DialogueNode{Character: "X", Text: "a3"},
						},
					},
					{
						ID:   "B",
						Mode: "safe",
						Text: "B",
						Body: []ast.Node{
							&ast.DialogueNode{Character: "X", Text: "b1"},
							&ast.DialogueNode{Character: "X", Text: "b2"},
							&ast.NarratorNode{Text: "b3"},
						},
					},
				},
			},
			&ast.NarratorNode{Text: "outro"}, // 0010_nar (continues parent COUNTER past choice)
		},
		Gate: &ast.GateBlock{Routes: []*ast.GateRoute{nextLeaf("main:02")}},
	}
	em := New(newMockResolver())
	data, err := em.Emit(ep)
	if err != nil {
		t.Fatalf("Emit: %v", err)
	}
	var result map[string]interface{}
	json.Unmarshal(data, &result)

	steps := result["steps"].([]interface{})
	for i, want := range []string{"0001_nar", "0002_nar", "0003_ch", "0010_nar"} {
		got := steps[i].(map[string]interface{})["id"]
		if got != want {
			t.Errorf("top-level steps[%d].id = %v, want %q", i, got, want)
		}
	}

	choice := steps[2].(map[string]interface{})
	options := choice["options"].([]interface{})

	stepsA := options[0].(map[string]interface{})["steps"].([]interface{})
	for i, want := range []string{"0004_dlg", "0005_nar", "0006_dlg"} {
		got := stepsA[i].(map[string]interface{})["id"]
		if got != want {
			t.Errorf("optA.steps[%d].id = %v, want %q", i, got, want)
		}
	}

	stepsB := options[1].(map[string]interface{})["steps"].([]interface{})
	for i, want := range []string{"0007_dlg", "0008_dlg", "0009_nar"} {
		got := stepsB[i].(map[string]interface{})["id"]
		if got != want {
			t.Errorf("optB.steps[%d].id = %v, want %q", i, got, want)
		}
	}
}

// TestStepIDIfContinuesCounter verifies that if.then and if.else
// continue the episode-scoped COUNTER after the if step itself.
func TestStepIDIfContinuesCounter(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01",
		Title:     "T",
		Body: []ast.Node{
			&ast.IfNode{
				Condition: &ast.FlagCondition{Name: "X"},
				Then: []ast.Node{
					&ast.NarratorNode{Text: "t1"},
					&ast.DialogueNode{Character: "X", Text: "t2"},
				},
				Else: []ast.Node{
					&ast.DialogueNode{Character: "X", Text: "e1"},
					&ast.NarratorNode{Text: "e2"},
					&ast.PauseNode{},
				},
			},
		},
		Gate: &ast.GateBlock{Routes: []*ast.GateRoute{nextLeaf("main:02")}},
	}
	em := New(newMockResolver())
	data, err := em.Emit(ep)
	if err != nil {
		t.Fatalf("Emit: %v", err)
	}
	var result map[string]interface{}
	json.Unmarshal(data, &result)

	steps := result["steps"].([]interface{})
	ifStep := steps[0].(map[string]interface{})
	if ifStep["id"] != "0001_ctrl" {
		t.Errorf("if step id = %v, want 0001_ctrl", ifStep["id"])
	}

	thenBranch := ifStep["then"].([]interface{})
	for i, want := range []string{"0002_nar", "0003_dlg"} {
		got := thenBranch[i].(map[string]interface{})["id"]
		if got != want {
			t.Errorf("then[%d].id = %v, want %q", i, got, want)
		}
	}

	elseBranch := ifStep["else"].([]interface{})
	for i, want := range []string{"0004_dlg", "0005_nar", "0006_pau"} {
		got := elseBranch[i].(map[string]interface{})["id"]
		if got != want {
			t.Errorf("else[%d].id = %v, want %q", i, got, want)
		}
	}
}

// TestStepIDPhoneShowContinuesCounter verifies phone_show.messages
// continues the episode-scoped COUNTER.
func TestStepIDPhoneShowContinuesCounter(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01",
		Title:     "T",
		Body: []ast.Node{
			&ast.NarratorNode{Text: "before"}, // 0001_nar
			&ast.PhoneShowNode{ // 0002_phn
				Body: []ast.Node{
					&ast.TextMessageNode{Direction: "from", Char: "easton", Content: "hi"},
					&ast.TextMessageNode{Direction: "to", Char: "malia", Content: "yo"},
				},
			},
		},
		Gate: &ast.GateBlock{Routes: []*ast.GateRoute{nextLeaf("main:02")}},
	}
	em := New(newMockResolver())
	data, err := em.Emit(ep)
	if err != nil {
		t.Fatalf("Emit: %v", err)
	}
	var result map[string]interface{}
	json.Unmarshal(data, &result)
	steps := result["steps"].([]interface{})

	if steps[0].(map[string]interface{})["id"] != "0001_nar" {
		t.Errorf("steps[0].id = %v, want 0001_nar", steps[0].(map[string]interface{})["id"])
	}
	phone := steps[1].(map[string]interface{})
	if phone["id"] != "0002_phn" {
		t.Errorf("phone_show id = %v, want 0002_phn", phone["id"])
	}

	messages := phone["messages"].([]interface{})
	for i, want := range []string{"0003_phn", "0004_phn"} {
		got := messages[i].(map[string]interface{})["id"]
		if got != want {
			t.Errorf("messages[%d].id = %v, want %q", i, got, want)
		}
	}
}

// TestStepIDMinigameLeaf verifies that @minigame is a leaf step.
func TestStepIDMinigameLeaf(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01",
		Title:     "T",
		Body: []ast.Node{
			&ast.NarratorNode{Text: "intro"}, // 0001_nar
			&ast.MinigameNode{ // 0002_mg
				Name:        "qte_challenge",
				Description: "d",
			},
			&ast.NarratorNode{Text: "after"}, // 0003_nar
		},
		Gate: &ast.GateBlock{Routes: []*ast.GateRoute{nextLeaf("main:02")}},
	}
	em := New(newMockResolver())
	data, err := em.Emit(ep)
	if err != nil {
		t.Fatalf("Emit failed: %v", err)
	}
	var result map[string]interface{}
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatalf("Unmarshal failed: %v", err)
	}
	steps := result["steps"].([]interface{})
	mg := steps[1].(map[string]interface{})
	if mg["id"] != "0002_mg" {
		t.Errorf("minigame id = %v, want 0002_mg", mg["id"])
	}
	if _, has := mg["steps"]; has {
		t.Error("minigame should not have a 'steps' child container")
	}
	after := steps[2].(map[string]interface{})
	if after["id"] != "0003_nar" {
		t.Errorf("step after minigame should be 0003_nar, got %v", after["id"])
	}
}

// TestStepIDTrickLeaf verifies trick is a leaf step with the trk tag
// and consumes a single seq.
func TestStepIDTrickLeaf(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01",
		Title:     "T",
		Body: []ast.Node{
			&ast.NarratorNode{Text: "intro"}, // 0001_nar
			&ast.TrickNode{ // 0002_trk
				Type:   ast.TrickTap,
				Prompt: "Tap to keep up.",
			},
			&ast.NarratorNode{Text: "after"}, // 0003_nar
		},
		Gate: &ast.GateBlock{Routes: []*ast.GateRoute{nextLeaf("main:02")}},
	}
	em := New(newMockResolver())
	data, err := em.Emit(ep)
	if err != nil {
		t.Fatalf("Emit failed: %v", err)
	}
	var result map[string]interface{}
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatalf("Unmarshal failed: %v", err)
	}
	steps := result["steps"].([]interface{})
	trick := steps[1].(map[string]interface{})
	if trick["type"] != "trick" {
		t.Errorf("trick type = %v, want trick", trick["type"])
	}
	if trick["id"] != "0002_trk" {
		t.Errorf("trick id = %v, want 0002_trk", trick["id"])
	}
	if trick["trick_type"] != "tap" {
		t.Errorf("trick_type = %v, want tap", trick["trick_type"])
	}
	if trick["prompt"] != "Tap to keep up." {
		t.Errorf("prompt = %v", trick["prompt"])
	}
	if _, has := trick["steps"]; has {
		t.Error("trick must not carry a body / steps container")
	}
	after := steps[2].(map[string]interface{})
	if after["id"] != "0003_nar" {
		t.Errorf("step after trick should be 0003_nar, got %v", after["id"])
	}
}

// TestStepIDCgShowLeaf verifies cg_show is now a leaf step — it consumes
// one seq, carries no body / steps / duration / transition, and the next
// sibling continues the parent COUNTER directly.
func TestStepIDCgShowLeaf(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01",
		Title:     "T",
		Body: []ast.Node{
			&ast.CgShowNode{
				Name:    "window_stare",
				Content: "Slow camera push-in on the rain-streaked window.",
			},
			&ast.NarratorNode{Text: "after"},
		},
		Gate: &ast.GateBlock{Routes: []*ast.GateRoute{nextLeaf("main:02")}},
	}
	em := New(newMockResolver())
	data, err := em.Emit(ep)
	if err != nil {
		t.Fatalf("Emit failed: %v", err)
	}
	var result map[string]interface{}
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatalf("Unmarshal failed: %v", err)
	}
	steps := result["steps"].([]interface{})
	cg := steps[0].(map[string]interface{})
	if cg["id"] != "0001_cg" {
		t.Errorf("cg_show id = %v, want 0001_cg", cg["id"])
	}
	if cg["content"] != "Slow camera push-in on the rain-streaked window." {
		t.Errorf("cg.content = %v", cg["content"])
	}
	for _, key := range []string{"steps", "duration", "transition", "body"} {
		if _, has := cg[key]; has {
			t.Errorf("cg_show must not carry %q (leaf step)", key)
		}
	}
	after := steps[1].(map[string]interface{})
	if after["id"] != "0002_nar" {
		t.Errorf("step after cg_show should be 0002_nar, got %v", after["id"])
	}
}

// TestStepIDDeterminism verifies that compiling the same source twice
// produces byte-identical output.
func TestStepIDDeterminism(t *testing.T) {
	src := `@episode main:01 "T" {
  @bg set school_classroom fade
  &music calm_morning
  NARRATOR: line one.
  YOU: thinking.
  @pause
  @choice {
    @option A safe "go" {
      NARRATOR: a1
      X: hi
    }
    @option B safe "stay" {
      X: b1
      NARRATOR: b2
    }
  }
  @if (FLAG_X) {
    NARRATOR: t1
    X: t2
  } @else {
    X: e1
  }
  @signal mark DONE
  @gate { @end complete }
}`

	emit := func() string {
		l := lexer.New(src)
		p := parser.New(l)
		ep, err := p.Parse()
		if err != nil {
			t.Fatalf("parse: %v", err)
		}
		em := New(newMockResolver())
		data, err := em.Emit(ep)
		if err != nil {
			t.Fatalf("emit: %v", err)
		}
		return string(data)
	}

	first := emit()
	second := emit()
	if first != second {
		t.Errorf("compile is non-deterministic; identical source produced different output")
	}

	var result map[string]interface{}
	if err := json.Unmarshal([]byte(first), &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	walkSteps(result["steps"], func(step map[string]interface{}, path string) {
		typeVal, _ := step["type"].(string)
		if _, hasID := step["id"]; !hasID {
			t.Errorf("step at %s (type=%s) missing id field", path, typeVal)
		}
	})
}

// walkSteps recursively walks an emitted-steps tree, calling visit on
// every emitted step (= map with a "type" field that is a known step
// type). Skips non-step subtrees like `condition`, gate `if`/`else`,
// comparison `left`/`right`, etc.
func walkSteps(node interface{}, visit func(step map[string]interface{}, path string)) {
	walkStepsAt(node, "steps", visit)
}

func walkStepsAt(node interface{}, path string, visit func(step map[string]interface{}, path string)) {
	switch v := node.(type) {
	case map[string]interface{}:
		if t, ok := v["type"].(string); ok && stepTypeTag(t) != "unk" {
			visit(v, path)
		}
		for _, key := range []string{"steps", "messages", "then", "else", "options"} {
			if child, ok := v[key]; ok {
				walkStepsAt(child, path+"."+key, visit)
			}
		}
	case []interface{}:
		for i, item := range v {
			walkStepsAt(item, fmt.Sprintf("%s[%d]", path, i), visit)
		}
	}
}

// TestStepIDGloballyUnique verifies the episode-scoped invariant: no two
// steps anywhere in the episode tree share the same id.
func TestStepIDGloballyUnique(t *testing.T) {
	ep := &ast.Episode{
		BranchKey: "main:01",
		Title:     "T",
		Body: []ast.Node{
			&ast.NarratorNode{Text: "intro"},
			&ast.ChoiceNode{
				Options: []*ast.OptionNode{
					{ID: "A", Mode: "safe", Text: "A", Body: []ast.Node{
						&ast.DialogueNode{Character: "X", Text: "a1"},
						&ast.NarratorNode{Text: "a2"},
					}},
					{ID: "B", Mode: "safe", Text: "B", Body: []ast.Node{
						&ast.DialogueNode{Character: "X", Text: "b1"},
					}},
				},
			},
			&ast.IfNode{
				Condition: &ast.FlagCondition{Name: "X"},
				Then:      []ast.Node{&ast.NarratorNode{Text: "t1"}},
				Else:      []ast.Node{&ast.DialogueNode{Character: "X", Text: "e1"}},
			},
			&ast.MinigameNode{Name: "mg", Description: "d"},
			&ast.TrickNode{Type: ast.TrickTap, Prompt: "tap."},
			&ast.CgShowNode{Name: "x", Content: "c"},
			&ast.PhoneShowNode{
				Body: []ast.Node{
					&ast.TextMessageNode{Direction: "from", Char: "x", Content: "hi"},
				},
			},
		},
		Gate: &ast.GateBlock{Routes: []*ast.GateRoute{nextLeaf("main:02")}},
	}
	em := New(newMockResolver())
	data, err := em.Emit(ep)
	if err != nil {
		t.Fatalf("Emit: %v", err)
	}
	var result map[string]interface{}
	json.Unmarshal(data, &result)

	var ids []string
	walkSteps(result["steps"], func(step map[string]interface{}, path string) {
		if id, ok := step["id"].(string); ok {
			ids = append(ids, id)
		}
	})

	seen := map[string]bool{}
	for _, id := range ids {
		if seen[id] {
			t.Errorf("duplicate step id %q across entire episode tree", id)
		}
		seen[id] = true
	}
	if len(seen) != len(ids) {
		t.Errorf("expected %d unique ids, got %d unique out of %d total", len(ids), len(seen), len(ids))
	}
}
