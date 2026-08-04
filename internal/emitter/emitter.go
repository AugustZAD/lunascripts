// Package emitter converts an LS AST into player-ready JSON with resolved asset URLs.
package emitter

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/cdotlock/lunascripts/internal/ast"
)

// ContractVersion identifies the LS source/JSON contract emitted by this
// compiler. Consumers must negotiate this version before activating content.
const ContractVersion = "2.1.0"

// AssetResolver maps semantic asset names to full URLs.
type AssetResolver interface {
	ResolveBg(name string) (string, error)
	ResolveCharacter(char, poseExpr string) (string, error)
	ResolveMusic(name string) (string, error)
	ResolveSfx(name string) (string, error)
	ResolveCg(name string) (string, error)
	ResolveMinigame(gameID string) (string, error)
}

// Warning records a non-fatal issue encountered during emission.
type Warning struct {
	Message string
}

// Emitter walks an AST and produces player-ready JSON.
type Emitter struct {
	resolver AssetResolver
	Warnings []Warning
	seq      int // episode-scoped monotonic step counter (reset per Emit call)
}

// New creates an Emitter with the given asset resolver.
func New(resolver AssetResolver) *Emitter {
	return &Emitter{resolver: resolver}
}

// Emit converts an Episode AST into JSON bytes.
//
// Gate / Ending lowering (Scheme B): when the source gate has exactly one
// unconditional route whose leaf is *EndLeaf, we lower it to Episode.Ending
// and emit `gate: null`, preserving the simple terminal-marker shape the
// overlay system already consumes. Any other gate shape — including a
// single conditional end-leaf, or any mix of next-leaves — is emitted as
// a structured `gate` object.
func (e *Emitter) Emit(ep *ast.Episode) ([]byte, error) {
	e.seq = 0

	// Scheme B lowering: degenerate `@gate { @end TYPE }` → Episode.Ending.
	if ep.Gate != nil && len(ep.Gate.Routes) == 1 {
		only := ep.Gate.Routes[0]
		if only.Condition == nil {
			if leaf, ok := only.Leaf.(*ast.EndLeaf); ok {
				ep.Ending = &ast.EndingNode{Type: leaf.Type}
				ep.Gate = nil
			}
		}
	}

	out := map[string]interface{}{
		"ls_contract_version": ContractVersion,
		"episode_id":          ep.BranchKey,
		"branch_key":          extractBranchKey(ep.BranchKey),
		"seq":                 extractSeq(ep.BranchKey),
		"title":               ep.Title,
		"steps":               e.emitNodes(ep.Body),
	}

	if ep.Gate != nil {
		out["gate"] = e.emitGate(ep.Gate)
	} else {
		out["gate"] = nil
	}

	if ep.Ending != nil {
		out["ending"] = map[string]interface{}{"type": ep.Ending.Type}
	} else {
		out["ending"] = nil
	}

	return json.MarshalIndent(out, "", "  ")
}

// isConcurrent checks if a node carries the concurrent (&) flag.
func isConcurrent(n ast.Node) bool {
	if hc, ok := n.(ast.HasConcurrent); ok {
		return hc.GetConcurrent()
	}
	return false
}

// stepTypeTag maps a step's "type" discriminator to the 2-4 letter tag
// used in the stable step id (see assignStepID).
//
// CONTRACT: This function — together with assignStepID — is the SOLE
// authority on the original-step id format emitted by the compiler.
// Once an episode JSON has been shipped to a backend that persists
// player-session cursors keyed by these ids, NEVER change either
// function's algorithm without coordinating a one-shot data migration.
// Renaming a tag, changing the seq width, or reordering grouping
// semantics will silently invalidate every persisted cursor.
//
// Returns "unk" for any unrecognized type. The validator should reject
// scripts that produce unknown types before they reach the emitter; the
// fallback exists so we never panic if a new step type is added without
// updating this table.
func stepTypeTag(stepType string) string {
	switch stepType {
	case "dialogue":
		return "dlg"
	case "narrator":
		return "nar"
	case "you":
		return "you"
	case "pause":
		return "pau"
	case "choice":
		return "ch"
	case "minigame":
		return "mg"
	case "trick":
		return "trk"
	case "cg_show":
		return "cg"
	case "bg":
		return "bg"
	case "char_show", "bubble":
		return "char"
	case "music", "music_stop":
		return "mus"
	case "sfx":
		return "sfx"
	case "phone_show", "text_message":
		return "phn"
	case "signal":
		return "sig"
	case "affection":
		return "aff"
	case "achievement":
		return "ach"
	case "butterfly":
		return "btf"
	case "if":
		return "ctrl"
	default:
		return "unk"
	}
}

// assignStepID stamps a stable id onto a single emitted step map.
//
// Format: <seq>_<tag>, where seq is a 4-digit zero-padded 1-based counter
// shared across the entire episode tree (monotonically increasing in DFS
// pre-order), and tag is the short type code returned by stepTypeTag.
// No two steps in the same episode can share an id.
//
// CONTRACT: This function is the SOLE authority on original-step ids.
// See stepTypeTag for the migration warning — both functions move
// together or not at all.
func assignStepID(step map[string]interface{}, seq int) {
	stepType, _ := step["type"].(string)
	step["id"] = fmt.Sprintf("%04d_%s", seq, stepTypeTag(stepType))
}

// emitNodes converts a slice of AST nodes into a slice of steps, grouping
// consecutive concurrent (&-prefixed) nodes into sub-arrays, and stamping
// every emitted step with an episode-scoped stable id.
//
// Grouping rule:
//   - A non-concurrent node (@-prefixed or dialogue) starts a potential group.
//   - Following &-concurrent nodes join the group.
//   - When the next non-concurrent node arrives, the group is flushed.
//   - Single-item groups are emitted as plain objects.
//   - Multi-item groups are emitted as arrays (concurrent execution).
//
// ID assignment: each emitted step (whether solo or inside a concurrent
// group) consumes one seq from e.seq — a single monotonic counter shared
// across the entire episode tree. The parent step is stamped first, then
// child containers (option.steps, minigame.steps, if.then/else,
// phone_show.messages) are emitted via emitChildren, giving children
// higher seqs than their parent (DFS pre-order).
func (e *Emitter) emitNodes(nodes []ast.Node) []interface{} {
	steps := make([]interface{}, 0)
	var group []interface{}

	flush := func() {
		if len(group) == 0 {
			return
		}
		if len(group) == 1 {
			steps = append(steps, group[0])
		} else {
			steps = append(steps, group)
		}
		group = nil
	}

	for _, n := range nodes {
		step := e.emitNode(n)
		if step == nil {
			continue
		}

		e.seq++
		assignStepID(step, e.seq)
		e.emitChildren(n, step)

		if isConcurrent(n) {
			group = append(group, step)
		} else {
			flush()
			group = append(group, step)
		}
	}
	flush()

	return steps
}

// emitNode converts a single AST node into a step map.
func (e *Emitter) emitNode(n ast.Node) map[string]interface{} {
	switch v := n.(type) {
	case *ast.BgSetNode:
		return e.emitBg(v)
	case *ast.CharShowNode:
		return e.emitCharShow(v)
	case *ast.CharBubbleNode:
		return e.emitCharBubble(v)
	case *ast.CgShowNode:
		return e.emitCgShow(v)
	case *ast.DialogueNode:
		return e.emitDialogue(v)
	case *ast.NarratorNode:
		return e.emitNarrator(v)
	case *ast.YouNode:
		return e.emitYou(v)
	case *ast.PhoneShowNode:
		return e.emitPhoneShow(v)
	case *ast.TextMessageNode:
		return e.emitTextMessage(v)
	case *ast.MusicSetNode:
		return e.emitMusic(v)
	case *ast.MusicStopNode:
		return e.emitMusicStop(v)
	case *ast.SfxNode:
		return e.emitSfx(v)
	case *ast.MinigameNode:
		return e.emitMinigame(v)
	case *ast.TrickNode:
		return e.emitTrick(v)
	case *ast.ChoiceNode:
		return e.emitChoice(v)
	case *ast.AffectionNode:
		return e.emitAffection(v)
	case *ast.SignalNode:
		return e.emitSignal(v)
	case *ast.ButterflyNode:
		return map[string]interface{}{"type": "butterfly", "description": v.Description}
	case *ast.AchievementNode:
		// The JSON `achievement_id` field carries the semantic id from
		// LS source `@achievement <id> { ... }` (e.g. "RARE_COURAGE"),
		// distinct from the universal `id` field (the cursor stable-step
		// id, format `<seq>_<tag>`) stamped by assignStepID. Keeping the
		// semantic id under a domain-specific key avoids collision.
		return map[string]interface{}{
			"type":           "achievement",
			"achievement_id": v.ID,
			"name":           v.Name,
			"rarity":         v.Rarity,
			"description":    v.Description,
		}
	case *ast.IfNode:
		return e.emitIf(v)
	case *ast.PauseNode:
		return map[string]interface{}{"type": "pause"}
	default:
		e.warn("unknown node type: %T", n)
		return nil
	}
}

func (e *Emitter) emitBg(n *ast.BgSetNode) map[string]interface{} {
	m := map[string]interface{}{
		"type": "bg",
		"name": n.Name,
	}
	url, err := e.resolver.ResolveBg(n.Name)
	if err != nil {
		e.warn("bg %q: %v", n.Name, err)
	} else {
		m["url"] = url
	}
	if n.Transition != "" {
		m["transition"] = n.Transition
	}
	return m
}

func (e *Emitter) emitCharShow(n *ast.CharShowNode) map[string]interface{} {
	m := map[string]interface{}{
		"type":      "char_show",
		"character": n.Char,
		"look":      n.Look,
	}
	url, err := e.resolver.ResolveCharacter(n.Char, n.Look)
	if err != nil {
		e.warn("char_show %q/%q: %v", n.Char, n.Look, err)
	} else {
		m["url"] = url
	}
	if n.Transition != "" {
		m["transition"] = n.Transition
	}
	return m
}

func (e *Emitter) emitCharBubble(n *ast.CharBubbleNode) map[string]interface{} {
	return map[string]interface{}{
		"type":        "bubble",
		"character":   n.Char,
		"bubble_type": n.BubbleType,
	}
}

// emitCgShow emits a CG step. CG is a leaf node: no body, no duration,
// no transition. Pacing and camera motion are encoded in `content` and
// realised by the agent-forge pipeline downstream.
func (e *Emitter) emitCgShow(n *ast.CgShowNode) map[string]interface{} {
	m := map[string]interface{}{
		"type":    "cg_show",
		"name":    n.Name,
		"content": n.Content,
	}
	url, err := e.resolver.ResolveCg(n.Name)
	if err != nil {
		e.warn("cg_show %q: %v", n.Name, err)
	} else {
		m["url"] = url
	}
	return m
}

func (e *Emitter) emitDialogue(n *ast.DialogueNode) map[string]interface{} {
	return map[string]interface{}{
		"type":      "dialogue",
		"character": strings.ToLower(n.Character),
		"text":      n.Text,
	}
}

func (e *Emitter) emitNarrator(n *ast.NarratorNode) map[string]interface{} {
	return map[string]interface{}{
		"type": "narrator",
		"text": n.Text,
	}
}

func (e *Emitter) emitYou(n *ast.YouNode) map[string]interface{} {
	return map[string]interface{}{
		"type": "you",
		"text": n.Text,
	}
}

func (e *Emitter) emitPhoneShow(n *ast.PhoneShowNode) map[string]interface{} {
	return map[string]interface{}{
		"type": "phone_show",
	}
}

func (e *Emitter) emitTextMessage(n *ast.TextMessageNode) map[string]interface{} {
	return map[string]interface{}{
		"type":      "text_message",
		"direction": n.Direction,
		"character": strings.ToLower(n.Char),
		"text":      n.Content,
	}
}

func (e *Emitter) emitMusic(n *ast.MusicSetNode) map[string]interface{} {
	m := map[string]interface{}{
		"type": "music",
		"name": n.Name,
	}
	url, err := e.resolver.ResolveMusic(n.Name)
	if err != nil {
		e.warn("music %q: %v", n.Name, err)
	} else {
		m["url"] = url
	}
	return m
}

func (e *Emitter) emitMusicStop(_ *ast.MusicStopNode) map[string]interface{} {
	return map[string]interface{}{"type": "music_stop"}
}

func (e *Emitter) emitSfx(n *ast.SfxNode) map[string]interface{} {
	m := map[string]interface{}{
		"type": "sfx",
		"name": n.Name,
	}
	url, err := e.resolver.ResolveSfx(n.Name)
	if err != nil {
		e.warn("sfx %q: %v", n.Name, err)
	} else {
		m["url"] = url
	}
	return m
}

func (e *Emitter) emitMinigame(n *ast.MinigameNode) map[string]interface{} {
	// Leaf step: { type, name, description, game_url }. Rewards live
	// entirely on the engine side; the script declares none of them.
	m := map[string]interface{}{
		"type":        "minigame",
		"name":        n.Name,
		"description": n.Description,
	}
	url, err := e.resolver.ResolveMinigame(n.Name)
	if err != nil {
		e.warn("minigame %q: %v", n.Name, err)
	} else {
		m["game_url"] = url
	}
	return m
}

func (e *Emitter) emitTrick(n *ast.TrickNode) map[string]interface{} {
	// Engine-native leaf step: { type, trick_type, prompt }. No asset,
	// no URL, no rewards. The engine MUST block until the player
	// completes the body action.
	return map[string]interface{}{
		"type":       "trick",
		"trick_type": n.Type,
		"prompt":     n.Prompt,
	}
}

func (e *Emitter) emitChoice(n *ast.ChoiceNode) map[string]interface{} {
	options := make([]interface{}, 0, len(n.Options))
	for _, opt := range n.Options {
		o := map[string]interface{}{
			"id":   opt.ID,
			"mode": opt.Mode,
			"text": opt.Text,
		}
		if opt.Check != nil {
			o["check"] = map[string]interface{}{
				"attr": opt.Check.Attr,
				"dc":   opt.Check.DC,
			}
		}
		options = append(options, o)
	}
	return map[string]interface{}{
		"type":    "choice",
		"options": options,
	}
}

func (e *Emitter) emitAffection(n *ast.AffectionNode) map[string]interface{} {
	delta := parseDelta(n.Delta)
	if delta == 0 && n.Delta != "0" && n.Delta != "+0" && n.Delta != "-0" {
		e.warn("affection %q: invalid delta %q, defaulting to 0", n.Char, n.Delta)
	}
	return map[string]interface{}{
		"type":      "affection",
		"character": n.Char,
		"delta":     delta,
	}
}

func (e *Emitter) emitSignal(n *ast.SignalNode) map[string]interface{} {
	switch n.Kind {
	case ast.SignalKindMark:
		return map[string]interface{}{
			"type":  "signal",
			"kind":  "mark",
			"event": n.Event,
		}
	case ast.SignalKindInt:
		return map[string]interface{}{
			"type":  "signal",
			"kind":  "int",
			"name":  n.Name,
			"op":    n.Op,
			"value": n.Value,
		}
	default:
		// Defensive: unknown kind is caught by validator, but keep the
		// emitter resilient — emit a best-effort shape so downstream
		// debugging isn't hampered.
		return map[string]interface{}{
			"type": "signal",
			"kind": n.Kind,
		}
	}
}

func (e *Emitter) emitIf(n *ast.IfNode) map[string]interface{} {
	return map[string]interface{}{
		"type":      "if",
		"condition": e.emitCondition(n.Condition),
	}
}

// emitChildren attaches child containers to a step AFTER the parent has
// been stamped with its id, ensuring children get higher seqs (DFS pre-order).
//
// CG is no longer a container — it's a leaf step whose `content` field
// carries the narrative for downstream rendering.
func (e *Emitter) emitChildren(n ast.Node, step map[string]interface{}) {
	switch v := n.(type) {
	case *ast.PhoneShowNode:
		if len(v.Body) > 0 {
			step["messages"] = e.emitNodes(v.Body)
		}
	case *ast.ChoiceNode:
		options := step["options"].([]interface{})
		for i, opt := range v.Options {
			if len(opt.Body) > 0 {
				options[i].(map[string]interface{})["steps"] = e.emitNodes(opt.Body)
			}
		}
	case *ast.IfNode:
		step["then"] = e.emitNodes(v.Then)
		if len(v.Else) > 0 {
			if len(v.Else) == 1 {
				if elseIf, ok := v.Else[0].(*ast.IfNode); ok {
					step["else"] = e.emitNestedIf(elseIf)
					return
				}
			}
			step["else"] = e.emitNodes(v.Else)
		}
	}
}

// emitNestedIf builds a nested @else @if node. The nested IfStep does NOT
// get an id (only its then/else children are stamped via emitNodes).
func (e *Emitter) emitNestedIf(n *ast.IfNode) map[string]interface{} {
	m := map[string]interface{}{
		"type":      "if",
		"condition": e.emitCondition(n.Condition),
		"then":      e.emitNodes(n.Then),
	}
	if len(n.Else) > 0 {
		if len(n.Else) == 1 {
			if elseIf, ok := n.Else[0].(*ast.IfNode); ok {
				m["else"] = e.emitNestedIf(elseIf)
				return m
			}
		}
		m["else"] = e.emitNodes(n.Else)
	}
	return m
}

// emitGate emits the top-level gate routing object. By the time Emit
// reaches here, Scheme B lowering has already collapsed any pure
// `@gate { @end TYPE }` into Episode.Ending — every gate we see has
// at least one *NextLeaf or at least one conditional route.
func (e *Emitter) emitGate(g *ast.GateBlock) interface{} {
	return e.emitGateRoute(g.Routes, 0)
}

// emitGateRoute recursively builds a nested if/else chain from gate routes.
// Each route's Leaf is either a *NextLeaf (emit `next: <target>`) or a
// *EndLeaf (emit `end: <type>`). Conditional routes wrap with `if` and
// chain remaining routes under `else`; unconditional routes are terminal
// (emit only the leaf field).
func (e *Emitter) emitGateRoute(routes []*ast.GateRoute, idx int) map[string]interface{} {
	if idx >= len(routes) {
		return nil
	}

	r := routes[idx]
	m := e.emitGateLeaf(r.Leaf)

	if r.Condition != nil {
		m["if"] = e.emitCondition(r.Condition)
		if idx+1 < len(routes) {
			m["else"] = e.emitGateRoute(routes, idx+1)
		}
	}

	return m
}

// emitGateLeaf renders a single gate leaf (next-route or end-marker) as
// the field map for one gate node.
func (e *Emitter) emitGateLeaf(leaf ast.GateLeaf) map[string]interface{} {
	switch l := leaf.(type) {
	case *ast.NextLeaf:
		return map[string]interface{}{"next": l.Target}
	case *ast.EndLeaf:
		return map[string]interface{}{"end": l.Type}
	default:
		e.warn("unknown gate leaf type: %T", leaf)
		return map[string]interface{}{}
	}
}

// emitOperand converts a ComparisonOperand AST node to its JSON map. All
// five kinds are emitted with a `kind` discriminator plus the kind-specific
// payload field (`value`, `char`, `name`, or `args`).
func (e *Emitter) emitOperand(op *ast.ComparisonOperand) map[string]interface{} {
	if op == nil {
		e.warn("comparison operand is nil")
		return nil
	}
	switch op.Kind {
	case ast.OperandLiteral:
		return map[string]interface{}{"kind": "literal", "value": op.Value}
	case ast.OperandAffection:
		return map[string]interface{}{"kind": "affection", "char": op.Char}
	case ast.OperandValue:
		return map[string]interface{}{"kind": "value", "name": op.Name}
	case ast.OperandMax, ast.OperandMin:
		args := make([]interface{}, 0, len(op.Args))
		for _, a := range op.Args {
			args = append(args, e.emitOperand(a))
		}
		return map[string]interface{}{"kind": op.Kind, "args": args}
	default:
		e.warn("unknown comparison operand kind: %q", op.Kind)
		return nil
	}
}

// emitCondition converts a Condition AST node to a JSON map.
// All condition types are fully structured — no raw expression strings —
// so the backend can consume them directly without re-parsing.
func (e *Emitter) emitCondition(c ast.Condition) map[string]interface{} {
	switch v := c.(type) {
	case *ast.ChoiceCondition:
		return map[string]interface{}{
			"type":   "choice",
			"option": v.Option,
			"result": v.Result,
		}
	case *ast.FlagCondition:
		return map[string]interface{}{
			"type": "flag",
			"name": v.Name,
		}
	case *ast.ComparisonCondition:
		return map[string]interface{}{
			"type":  "comparison",
			"left":  e.emitOperand(v.Left),
			"op":    v.Op,
			"right": e.emitOperand(v.Right),
		}
	case *ast.CompoundCondition:
		return map[string]interface{}{
			"type":  "compound",
			"op":    v.Op,
			"left":  e.emitCondition(v.Left),
			"right": e.emitCondition(v.Right),
		}
	case *ast.CheckCondition:
		return map[string]interface{}{
			"type":   "check",
			"result": v.Result,
		}
	default:
		e.warn("unknown condition type: %T", c)
		return map[string]interface{}{"type": "unknown"}
	}
}

func (e *Emitter) warn(format string, args ...interface{}) {
	e.Warnings = append(e.Warnings, Warning{Message: fmt.Sprintf(format, args...)})
}

// extractBranchKey extracts the branch key from an episode id like "main:01" -> "main".
func extractBranchKey(episodeID string) string {
	idx := strings.LastIndex(episodeID, ":")
	if idx < 0 {
		return episodeID
	}
	return episodeID[:idx]
}

// extractSeq extracts the sequence number from an episode id like "main:01" -> 1.
func extractSeq(episodeID string) int {
	idx := strings.LastIndex(episodeID, ":")
	if idx < 0 || idx == len(episodeID)-1 {
		return 0
	}
	n, err := strconv.Atoi(episodeID[idx+1:])
	if err != nil {
		return 0
	}
	return n
}

// parseDelta converts a signed delta string like "+3" or "-5" to an int.
func parseDelta(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}
