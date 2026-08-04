// Package validator checks semantic correctness of a parsed LS AST.
package validator

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/cdotlock/lunascripts/internal/ast"
)

// Error codes for validation failures.
const (
	MissingTerminal            = "MISSING_TERMINAL"
	IncompleteGate             = "INCOMPLETE_GATE"
	BraveNoCheck               = "BRAVE_NO_CHECK"
	DuplicateOptionID          = "DUPLICATE_OPTION_ID"
	SafeOptionHasCheck         = "SAFE_OPTION_HAS_CHECK"
	InvalidTransition          = "INVALID_TRANSITION"
	InvalidBubbleType          = "INVALID_BUBBLE_TYPE"
	InvalidOptionMode          = "INVALID_OPTION_MODE"
	InvalidEndType             = "INVALID_END_TYPE"
	InvalidCondition           = "INVALID_CONDITION"
	InvalidSignalKind          = "INVALID_SIGNAL_KIND"
	InvalidSignalName          = "INVALID_SIGNAL_NAME"
	InvalidRarity              = "INVALID_RARITY"
	AchievementMissingField    = "ACHIEVEMENT_MISSING_FIELD"
	MinigameMissingDescription = "MINIGAME_MISSING_DESCRIPTION"
	MinigameMissingName        = "MINIGAME_MISSING_NAME"
	InvalidTrickType           = "INVALID_TRICK_TYPE"
	TrickMissingPrompt         = "TRICK_MISSING_PROMPT"
	ReservedKeyword            = "RESERVED_KEYWORD"
	InvalidPhoneContent        = "INVALID_PHONE_CONTENT"
	AggregateTooFewArgs        = "AGGREGATE_TOO_FEW_ARGS"
	GateNextMissingTarget      = "GATE_NEXT_MISSING_TARGET"
	CanonicalLookOwnerMismatch = "CANONICAL_LOOK_OWNER_MISMATCH"
)

func canonicalLookOwner(look string) (string, bool) {
	parts := strings.Split(look, "__")
	if len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
		return "", false
	}
	return strings.ToLower(parts[0]), true
}

// validTrickTypes mirrors the locked set in package ast. Keep in sync
// with the Trick* constants there.
var validTrickTypes = map[string]bool{
	ast.TrickTap:   true,
	ast.TrickHold:  true,
	ast.TrickSwipe: true,
	ast.TrickShake: true,
	ast.TrickSwing: true,
	ast.TrickTilt:  true,
}

var validSignalKinds = map[string]bool{
	ast.SignalKindMark: true,
	ast.SignalKindInt:  true,
}

// validAuthorSignalName is the single source-language naming contract for
// both persistent boolean marks and author-defined integer values. Lowercase
// names remain available to engine-managed values (for example `san`).
var validAuthorSignalName = regexp.MustCompile(`^[A-Z][A-Z0-9_]*$`)

// reservedKeywords are identifiers reserved by the LS language. They
// may not be used as signal mark names, signal int names, or character
// pose names. The list mirrors LS-SPEC.md §保留字 (Appendix B) plus the
// `bubble` character-directive verb and the `MAX` / `MIN` aggregate
// function names.
var reservedKeywords = map[string]bool{
	// Directive verbs.
	"set":    true,
	"bubble": true,
	"from":   true,
	"to":     true,
	"stop":   true,
	// Flow keywords.
	"if":      true,
	"else":    true,
	"next":    true,
	"end":     true,
	"gate":    true,
	"episode": true,
	"choice":  true,
	"option":  true,
	"check":   true,
	"pause":   true,
	// Option modes.
	"brave": true,
	"safe":  true,
	// Ending types.
	"complete":        true,
	"to_be_continued": true,
	"bad_ending":      true,
	// Aggregate functions (case-sensitive uppercase).
	"MAX": true,
	"MIN": true,
	// D20 check result words.
	"success": true,
	"fail":    true,
	"any":     true,
	// Engine-managed numeric names that scripts may only read.
	"san": true, "cha": true, "atk": true,
	"hp": true, "xp": true, "dex": true,
	"int": true, "str": true, "wis": true, "con": true,
}

var validRarities = map[string]bool{
	ast.RarityUncommon:  true,
	ast.RarityRare:      true,
	ast.RarityEpic:      true,
	ast.RarityLegendary: true,
}

// validEndTypes enumerates the ending type values accepted by EndLeaf
// (the `@end <type>` leaf inside a @gate route).
var validEndTypes = map[string]bool{
	ast.EndingComplete:      true,
	ast.EndingToBeContinued: true,
	ast.EndingBad:           true,
}

var validTransitions = map[string]bool{
	"fade": true, "cut": true, "slow": true, "dissolve": true,
}

var validBubbleTypes = map[string]bool{
	"anger": true, "sweat": true, "heart": true, "question": true,
	"exclaim": true, "idea": true, "music": true, "doom": true,
	"ellipsis": true,
}

// Error represents a single validation failure.
type Error struct {
	Code    string
	Message string
}

func (e Error) Error() string {
	return fmt.Sprintf("[%s] %s", e.Code, e.Message)
}

// Validate checks semantic correctness of an Episode AST and returns all errors found.
func Validate(ep *ast.Episode) []Error {
	var errs []Error

	// Every episode MUST terminate with a @gate block. The emitter may
	// later lower a degenerate `@gate { @end TYPE }` into Episode.Ending,
	// but at source-AST level a missing gate is a hard error.
	if ep.Gate == nil {
		errs = append(errs, Error{
			Code:    MissingTerminal,
			Message: "episode is missing a terminal: add @gate { ... } at the end of the episode",
		})
	} else {
		checkGateCompleteness(ep.Gate, &errs)
		checkGateLeaves(ep.Gate, &errs)
	}

	// Brave options must have check block and both outcomes.
	checkBraveOptions(ep.Body, &errs)

	// Check value whitelists.
	checkValues(ep.Body, &errs)

	// Validate condition trees (body @if and @gate routes).
	checkConditions(ep.Body, false, &errs)
	if ep.Gate != nil {
		for _, route := range ep.Gate.Routes {
			if route.Condition != nil {
				checkCondition(route.Condition, false, &errs)
			}
		}
	}

	// Validate signal kinds (recursive over whole body).
	checkSignals(ep.Body, &errs)

	// Validate inline @achievement steps (field completeness + rarity).
	checkAchievements(ep.Body, &errs)

	return errs
}

// checkGateCompleteness verifies the gate has a valid completeness shape:
// either a single unconditional route (one route, Condition == nil), or
// a chain of conditional routes terminated by an unconditional fallback
// (last route's Condition must be nil).
func checkGateCompleteness(gate *ast.GateBlock, errs *[]Error) {
	if len(gate.Routes) == 0 {
		*errs = append(*errs, Error{
			Code:    IncompleteGate,
			Message: "@gate has no routes; must contain a single unconditional @next/@end or an @if/@else chain ending in an unconditional fallback",
		})
		return
	}
	last := gate.Routes[len(gate.Routes)-1]
	if last.Condition != nil {
		*errs = append(*errs, Error{
			Code:    IncompleteGate,
			Message: "@gate is missing an unconditional fallback: the final route must be an @else (or a single unconditional @next/@end)",
		})
	}
}

// checkGateLeaves validates every gate route's terminal leaf.
//
//   - *ast.EndLeaf  : Type must be in validEndTypes.
//   - *ast.NextLeaf : Target must be non-empty.
func checkGateLeaves(gate *ast.GateBlock, errs *[]Error) {
	for i, route := range gate.Routes {
		switch leaf := route.Leaf.(type) {
		case *ast.EndLeaf:
			if !validEndTypes[leaf.Type] {
				*errs = append(*errs, Error{
					Code:    InvalidEndType,
					Message: fmt.Sprintf("@gate route #%d: invalid @end type %q (must be complete, to_be_continued, or bad_ending)", i+1, leaf.Type),
				})
			}
		case *ast.NextLeaf:
			if leaf.Target == "" {
				*errs = append(*errs, Error{
					Code:    GateNextMissingTarget,
					Message: fmt.Sprintf("@gate route #%d: @next is missing its target branch_key", i+1),
				})
			}
		case nil:
			*errs = append(*errs, Error{
				Code:    IncompleteGate,
				Message: fmt.Sprintf("@gate route #%d has no terminal leaf (@next or @end)", i+1),
			})
		default:
			*errs = append(*errs, Error{
				Code:    IncompleteGate,
				Message: fmt.Sprintf("@gate route #%d has unknown leaf type %T", i+1, leaf),
			})
		}
	}
}

// checkSignals walks the body and ensures every SignalNode has a valid
// kind and a non-reserved name.
func checkSignals(nodes []ast.Node, errs *[]Error) {
	for _, n := range nodes {
		switch v := n.(type) {
		case *ast.SignalNode:
			if !validSignalKinds[v.Kind] {
				*errs = append(*errs, Error{
					Code:    InvalidSignalKind,
					Message: fmt.Sprintf("@signal has invalid kind %q (valid: mark, int)", v.Kind),
				})
				continue
			}
			switch v.Kind {
			case ast.SignalKindMark:
				if !validAuthorSignalName.MatchString(v.Event) {
					*errs = append(*errs, Error{
						Code:    InvalidSignalName,
						Message: fmt.Sprintf("@signal mark %q: author signal names must use SCREAMING_SNAKE_CASE (for example: FIRST_MEETING)", v.Event),
					})
				}
				if reservedKeywords[v.Event] {
					*errs = append(*errs, Error{
						Code:    ReservedKeyword,
						Message: fmt.Sprintf("@signal mark %q: name is a reserved keyword; choose a different name", v.Event),
					})
				}
			case ast.SignalKindInt:
				if !validAuthorSignalName.MatchString(v.Name) {
					*errs = append(*errs, Error{
						Code:    InvalidSignalName,
						Message: fmt.Sprintf("@signal int %q: author signal names must use SCREAMING_SNAKE_CASE (for example: LOVE_POINTS)", v.Name),
					})
				}
				if reservedKeywords[v.Name] {
					*errs = append(*errs, Error{
						Code:    ReservedKeyword,
						Message: fmt.Sprintf("@signal int %q: name is a reserved keyword or collides with an engine-managed value; choose a different name", v.Name),
					})
				}
			}
		case *ast.ChoiceNode:
			for _, opt := range v.Options {
				checkSignals(opt.Body, errs)
			}
		case *ast.IfNode:
			checkSignals(v.Then, errs)
			checkSignals(v.Else, errs)
		case *ast.PhoneShowNode:
			checkSignals(v.Body, errs)
		}
	}
}

// checkAchievements walks the body and validates every @achievement node:
// required metadata fields are present and rarity is in the whitelist.
// Duplicate ids are not checked — two inline triggers sharing an id are
// valid source; the engine handles dedup at unlock time.
func checkAchievements(nodes []ast.Node, errs *[]Error) {
	for _, n := range nodes {
		switch v := n.(type) {
		case *ast.AchievementNode:
			if v.ID == "" {
				*errs = append(*errs, Error{
					Code:    AchievementMissingField,
					Message: "achievement has empty id",
				})
				continue
			}
			if v.Name == "" {
				*errs = append(*errs, Error{
					Code:    AchievementMissingField,
					Message: fmt.Sprintf("achievement %q missing 'name'", v.ID),
				})
			}
			if v.Description == "" {
				*errs = append(*errs, Error{
					Code:    AchievementMissingField,
					Message: fmt.Sprintf("achievement %q missing 'description'", v.ID),
				})
			}
			if !validRarities[v.Rarity] {
				*errs = append(*errs, Error{
					Code:    InvalidRarity,
					Message: fmt.Sprintf("achievement %q has invalid rarity %q (must be uncommon, rare, epic, or legendary)", v.ID, v.Rarity),
				})
			}
		case *ast.ChoiceNode:
			for _, opt := range v.Options {
				checkAchievements(opt.Body, errs)
			}
		case *ast.IfNode:
			checkAchievements(v.Then, errs)
			checkAchievements(v.Else, errs)
		case *ast.PhoneShowNode:
			checkAchievements(v.Body, errs)
		}
	}
}

// validCompoundOps and validComparisonOps enumerate accepted operators in
// structured condition nodes.
var validCompoundOps = map[string]bool{"&&": true, "||": true}
var validComparisonOps = map[string]bool{
	">=": true, "<=": true, ">": true, "<": true, "==": true, "!=": true,
}
var validChoiceResults = map[string]bool{"success": true, "fail": true, "any": true}

// validOperandKinds enumerates the five comparison-operand kinds.
var validOperandKinds = map[string]bool{
	ast.OperandLiteral:   true,
	ast.OperandAffection: true,
	ast.OperandValue:     true,
	ast.OperandMax:       true,
	ast.OperandMin:       true,
}

// checkConditions walks nodes and validates every Condition tree it finds.
// check.success/check.fail are context-local and may only appear while walking
// the body of the brave option that owns the current D20 result.
func checkConditions(nodes []ast.Node, allowCheck bool, errs *[]Error) {
	for _, n := range nodes {
		switch v := n.(type) {
		case *ast.IfNode:
			if v.Condition != nil {
				checkCondition(v.Condition, allowCheck, errs)
			}
			checkConditions(v.Then, allowCheck, errs)
			checkConditions(v.Else, allowCheck, errs)
		case *ast.ChoiceNode:
			for _, opt := range v.Options {
				checkConditions(opt.Body, opt.Mode == "brave", errs)
			}
		case *ast.PhoneShowNode:
			checkConditions(v.Body, allowCheck, errs)
		}
	}
}

// checkCondition validates a single Condition AST node recursively.
func checkCondition(c ast.Condition, allowCheck bool, errs *[]Error) {
	switch v := c.(type) {
	case *ast.ChoiceCondition:
		if !validChoiceResults[v.Result] {
			*errs = append(*errs, Error{
				Code:    InvalidCondition,
				Message: fmt.Sprintf("choice condition %s.%s has invalid result (must be success, fail, or any)", v.Option, v.Result),
			})
		}
	case *ast.ComparisonCondition:
		if !validComparisonOps[v.Op] {
			*errs = append(*errs, Error{
				Code:    InvalidCondition,
				Message: fmt.Sprintf("comparison has invalid operator %q", v.Op),
			})
		}
		if v.Left == nil {
			*errs = append(*errs, Error{
				Code:    InvalidCondition,
				Message: "comparison is missing its left operand",
			})
		} else {
			validateOperand(v.Left, "left", errs)
		}
		if v.Right == nil {
			*errs = append(*errs, Error{
				Code:    InvalidCondition,
				Message: "comparison is missing its right operand",
			})
		} else {
			validateOperand(v.Right, "right", errs)
		}
	case *ast.CompoundCondition:
		if !validCompoundOps[v.Op] {
			*errs = append(*errs, Error{
				Code:    InvalidCondition,
				Message: fmt.Sprintf("compound condition has invalid operator %q", v.Op),
			})
		}
		if v.Left != nil {
			checkCondition(v.Left, allowCheck, errs)
		}
		if v.Right != nil {
			checkCondition(v.Right, allowCheck, errs)
		}
	case *ast.FlagCondition:
		if !validAuthorSignalName.MatchString(v.Name) {
			*errs = append(*errs, Error{
				Code:    InvalidSignalName,
				Message: fmt.Sprintf("@if flag %q: author signal readers must use SCREAMING_SNAKE_CASE", v.Name),
			})
		}
	case *ast.CheckCondition:
		if !allowCheck {
			*errs = append(*errs, Error{
				Code:    InvalidCondition,
				Message: "check.success/check.fail is only valid inside a brave option body",
			})
		}
		if v.Result != "success" && v.Result != "fail" {
			*errs = append(*errs, Error{
				Code:    InvalidCondition,
				Message: fmt.Sprintf("check condition result %q is invalid (must be success or fail)", v.Result),
			})
		}
	case nil:
		// nil condition can appear in unconditional gate routes; caller handles.
	default:
		*errs = append(*errs, Error{
			Code:    InvalidCondition,
			Message: fmt.Sprintf("unknown condition type %T", c),
		})
	}
}

// validateOperand recursively validates a ComparisonOperand tree.
// `side` is a human label ("left", "right", or "arg") used in error
// messages so authors can locate the offending operand.
func validateOperand(op *ast.ComparisonOperand, side string, errs *[]Error) {
	if !validOperandKinds[op.Kind] {
		*errs = append(*errs, Error{
			Code:    InvalidCondition,
			Message: fmt.Sprintf("%s operand has unknown kind %q (valid: literal, affection, value, max, min)", side, op.Kind),
		})
		return
	}
	switch op.Kind {
	case ast.OperandLiteral:
		// No further structural checks — Value defaults to 0.
	case ast.OperandAffection:
		if op.Char == "" {
			*errs = append(*errs, Error{
				Code:    InvalidCondition,
				Message: fmt.Sprintf("%s affection operand has empty character name", side),
			})
		}
	case ast.OperandValue:
		if op.Name == "" {
			*errs = append(*errs, Error{
				Code:    InvalidCondition,
				Message: fmt.Sprintf("%s value operand has empty name", side),
			})
		}
	case ast.OperandMax, ast.OperandMin:
		funcName := "MAX"
		if op.Kind == ast.OperandMin {
			funcName = "MIN"
		}
		if len(op.Args) < 2 {
			*errs = append(*errs, Error{
				Code:    AggregateTooFewArgs,
				Message: fmt.Sprintf("%s %s aggregate requires at least 2 args, got %d", side, funcName, len(op.Args)),
			})
		}
		for i, arg := range op.Args {
			if arg == nil {
				*errs = append(*errs, Error{
					Code:    InvalidCondition,
					Message: fmt.Sprintf("%s %s aggregate has nil arg #%d", side, funcName, i+1),
				})
				continue
			}
			validateOperand(arg, "arg", errs)
		}
	}
}

// checkBraveOptions recursively validates brave option constraints.
func checkBraveOptions(nodes []ast.Node, errs *[]Error) {
	for _, n := range nodes {
		switch v := n.(type) {
		case *ast.ChoiceNode:
			// Check for duplicate option IDs within this choice.
			seen := make(map[string]bool)
			for _, opt := range v.Options {
				if seen[opt.ID] {
					*errs = append(*errs, Error{
						Code:    DuplicateOptionID,
						Message: fmt.Sprintf("duplicate option ID %q in @choice block", opt.ID),
					})
				}
				seen[opt.ID] = true

				switch opt.Mode {
				case "brave":
					if opt.Check == nil {
						*errs = append(*errs, Error{
							Code:    BraveNoCheck,
							Message: fmt.Sprintf("brave option %q is missing a @check block", opt.ID),
						})
					}
				case "safe":
					if opt.Check != nil {
						*errs = append(*errs, Error{
							Code:    SafeOptionHasCheck,
							Message: fmt.Sprintf("safe option %q should not have a check block", opt.ID),
						})
					}
				default:
					*errs = append(*errs, Error{
						Code:    InvalidOptionMode,
						Message: fmt.Sprintf("option %q has invalid mode %q (must be 'brave' or 'safe')", opt.ID, opt.Mode),
					})
				}
				checkBraveOptions(opt.Body, errs)
			}
		case *ast.IfNode:
			checkBraveOptions(v.Then, errs)
			checkBraveOptions(v.Else, errs)
		case *ast.PhoneShowNode:
			checkBraveOptions(v.Body, errs)
		}
	}
}

// checkValues validates enum-like fields (transitions, bubble types,
// trick types, minigame fields) and enforces the phone-overlay body
// whitelist.
func checkValues(nodes []ast.Node, errs *[]Error) {
	for _, n := range nodes {
		switch v := n.(type) {
		case *ast.CharShowNode:
			if v.Transition != "" && !validTransitions[v.Transition] {
				*errs = append(*errs, Error{
					Code:    InvalidTransition,
					Message: fmt.Sprintf("character %q show has invalid transition %q", v.Char, v.Transition),
				})
			}
			// `bubble` is a reserved word: it must not appear as a pose
			// name. The character-bubble animation has its own node type.
			if v.Look == "bubble" {
				*errs = append(*errs, Error{
					Code:    ReservedKeyword,
					Message: fmt.Sprintf("character %q has reserved pose name %q (use @<char> bubble <type> for bubble animations)", v.Char, v.Look),
				})
			}
			if owner, canonical := canonicalLookOwner(v.Look); canonical && owner != strings.ToLower(v.Char) {
				*errs = append(*errs, Error{
					Code: CanonicalLookOwnerMismatch,
					Message: fmt.Sprintf(
						"canonical look %q belongs to %q but is staged on character %q",
						v.Look, owner, v.Char,
					),
				})
			}
		case *ast.CharBubbleNode:
			if v.BubbleType == "" {
				*errs = append(*errs, Error{
					Code:    InvalidBubbleType,
					Message: fmt.Sprintf("character %q has empty bubble type (valid: anger, sweat, heart, question, exclaim, idea, music, doom, ellipsis)", v.Char),
				})
			} else if !validBubbleTypes[v.BubbleType] {
				*errs = append(*errs, Error{
					Code:    InvalidBubbleType,
					Message: fmt.Sprintf("character %q has invalid bubble type %q", v.Char, v.BubbleType),
				})
			}
		case *ast.BgSetNode:
			if v.Transition != "" && !validTransitions[v.Transition] {
				*errs = append(*errs, Error{
					Code:    InvalidTransition,
					Message: fmt.Sprintf("bg %q has invalid transition %q", v.Name, v.Transition),
				})
			}
		case *ast.ChoiceNode:
			for _, opt := range v.Options {
				checkValues(opt.Body, errs)
			}
		case *ast.IfNode:
			checkValues(v.Then, errs)
			checkValues(v.Else, errs)
		case *ast.MinigameNode:
			if v.Name == "" {
				*errs = append(*errs, Error{
					Code:    MinigameMissingName,
					Message: "@minigame missing required <name> (asset handle)",
				})
			}
			if v.Description == "" {
				*errs = append(*errs, Error{
					Code:    MinigameMissingDescription,
					Message: fmt.Sprintf("@minigame %q missing required description (one prose paragraph: scene + simple gameplay)", v.Name),
				})
			}
		case *ast.TrickNode:
			if !validTrickTypes[v.Type] {
				*errs = append(*errs, Error{
					Code:    InvalidTrickType,
					Message: fmt.Sprintf("@trick has invalid type %q (valid: tap, hold, swipe, shake, swing, tilt)", v.Type),
				})
			}
			if v.Prompt == "" {
				*errs = append(*errs, Error{
					Code:    TrickMissingPrompt,
					Message: fmt.Sprintf("@trick %s missing required quoted prompt", v.Type),
				})
			}
		case *ast.PhoneShowNode:
			// Phone overlay body is a strict whitelist: only text
			// messages may appear inside @phone { ... }.
			for _, child := range v.Body {
				if _, ok := child.(*ast.TextMessageNode); !ok {
					*errs = append(*errs, Error{
						Code:    InvalidPhoneContent,
						Message: fmt.Sprintf("@phone body contains disallowed node %T (only @<char> from/to text messages are permitted inside the phone overlay)", child),
					})
				}
			}
			checkValues(v.Body, errs)
		}
	}
}
