// Package parser converts a token stream from the lexer into an AST.
package parser

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/cdotlock/lunascripts/internal/ast"
	"github.com/cdotlock/lunascripts/internal/lexer"
	"github.com/cdotlock/lunascripts/internal/token"
)

// knownKeywords are @-directive keywords that are NOT character names.
// Anything not in this set, when used as @<keyword>, is parsed as a
// character directive (e.g. @malia worried).
var knownKeywords = map[string]bool{
	"bg": true, "cg": true, "phone": true, "text": true,
	"music": true, "sfx": true, "minigame": true, "trick": true,
	"choice":    true,
	"affection": true, "signal": true,
	"butterfly": true, "if": true, "else": true,
	"episode":     true,
	"option":      true,
	"gate":        true,
	"next":        true,
	"end":         true,
	"pause":       true,
	"achievement": true,
}

// validTrickTypes enumerates the 6 locked trick types accepted by the
// engine. Keep in sync with the Trick* constants in package ast.
var validTrickTypes = map[string]bool{
	ast.TrickTap:   true,
	ast.TrickHold:  true,
	ast.TrickSwipe: true,
	ast.TrickShake: true,
	ast.TrickSwing: true,
	ast.TrickTilt:  true,
}

// validSignalKinds enumerates accepted values for the kind token in
// @signal <kind> <event>.
var validSignalKinds = map[string]bool{
	"mark": true,
	"int":  true,
}

// validRarities enumerates accepted achievement rarities. Common is
// intentionally banned.
var validRarities = map[string]bool{
	"uncommon":  true,
	"rare":      true,
	"epic":      true,
	"legendary": true,
}

// validBubbleTypes enumerates the 9 locked bubble types. Keep in sync
// with the BubbleType field doc on CharBubbleNode in package ast.
var validBubbleTypes = map[string]bool{
	"anger":    true,
	"sweat":    true,
	"heart":    true,
	"question": true,
	"exclaim":  true,
	"idea":     true,
	"music":    true,
	"doom":     true,
	"ellipsis": true,
}

// Parser consumes tokens from a Lexer and produces an AST.
type Parser struct {
	l       *lexer.Lexer
	cur     token.Token
	peek    token.Token
	pending ast.Node // set by parseDialogueWithExpr; drained on next parseStatement call
	depth   int      // block nesting depth for recursion limit
}

// New creates a Parser that reads tokens from the given Lexer.
func New(l *lexer.Lexer) *Parser {
	p := &Parser{l: l}
	// Prime cur and peek.
	p.advance()
	p.advance()
	return p
}

// advance moves to the next non-COMMENT, non-NEWLINE token.
func (p *Parser) advance() {
	p.cur = p.peek
	for {
		p.peek = p.l.NextToken()
		if p.peek.Type != token.COMMENT && p.peek.Type != token.NEWLINE {
			break
		}
	}
}

// expect checks that the current token has the given type, then advances.
// Returns an error if the type doesn't match.
func (p *Parser) expect(t token.Type) (token.Token, error) {
	if p.cur.Type != t {
		return p.cur, fmt.Errorf("line %d col %d: expected %s, got %s (%q)",
			p.cur.Line, p.cur.Col, t, p.cur.Type, p.cur.Literal)
	}
	tok := p.cur
	p.advance()
	return tok, nil
}

// Parse parses an entire @episode block and returns the root Episode node.
//
// The source-level Episode always terminates with exactly one @gate block;
// the emitter's lowering pass is responsible for collapsing the degenerate
// `@gate { @end TYPE }` form into Episode.Ending. The parser never sets
// Ending itself.
func (p *Parser) Parse() (*ast.Episode, error) {
	// @episode <branch_key> "<title>" { body @gate { ... } }
	if _, err := p.expect(token.AT); err != nil {
		return nil, err
	}
	ep, err := p.expect(token.IDENT)
	if err != nil || ep.Literal != "episode" {
		return nil, fmt.Errorf("line %d col %d: expected 'episode', got %q",
			ep.Line, ep.Col, ep.Literal)
	}

	key, err := p.expect(token.IDENT)
	if err != nil {
		return nil, err
	}
	title, err := p.expect(token.STRING)
	if err != nil {
		return nil, err
	}
	if _, err := p.expect(token.LBRACE); err != nil {
		return nil, err
	}

	episode := &ast.Episode{
		BranchKey: key.Literal,
		Title:     title.Literal,
	}

	body, gate, err := p.parseEpisodeBody()
	if err != nil {
		return nil, err
	}
	episode.Body = body
	episode.Gate = gate

	if _, err := p.expect(token.RBRACE); err != nil {
		return nil, err
	}
	return episode, nil
}

// parseEpisodeBody parses body nodes until RBRACE. The single @gate block
// is lifted to Episode.Gate; everything else — including @achievement
// triggers — stays in the body as steps.
//
// Standalone @ending is no longer a source-level construct. The emitter
// produces Episode.Ending from a pure `@gate { @end TYPE }` lowering;
// the parser only sees @gate.
func (p *Parser) parseEpisodeBody() ([]ast.Node, *ast.GateBlock, error) {
	var body []ast.Node
	var gate *ast.GateBlock

	for p.cur.Type != token.RBRACE && p.cur.Type != token.EOF {
		// Drain any pending node queued by parseDialogueWithExpr before
		// checking the @gate short-circuit path.
		if p.pending != nil {
			body = append(body, p.pending)
			p.pending = nil
			continue
		}
		if p.cur.Type == token.AT && p.peek.Literal == "gate" {
			if gate != nil {
				return nil, nil, fmt.Errorf("line %d col %d: duplicate @gate block", p.cur.Line, p.cur.Col)
			}
			g, err := p.parseGateBlock()
			if err != nil {
				return nil, nil, err
			}
			gate = g
			continue
		}
		if p.cur.Type == token.AT && p.peek.Literal == "ending" {
			return nil, nil, fmt.Errorf("line %d col %d: standalone @ending is not allowed; use @gate { @end <type> }",
				p.cur.Line, p.cur.Col)
		}
		node, err := p.parseStatement()
		if err != nil {
			return nil, nil, err
		}
		if node == nil {
			continue
		}
		body = append(body, node)
	}
	// Drain final pending node if any.
	if p.pending != nil {
		body = append(body, p.pending)
		p.pending = nil
	}
	return body, gate, nil
}

// parseBlock parses body nodes until RBRACE (but does NOT consume the RBRACE).
func (p *Parser) parseBlock() ([]ast.Node, error) {
	p.depth++
	defer func() { p.depth-- }()
	if p.depth > 50 {
		return nil, fmt.Errorf("line %d col %d: maximum nesting depth exceeded (50)", p.cur.Line, p.cur.Col)
	}
	var nodes []ast.Node
	for p.cur.Type != token.RBRACE && p.cur.Type != token.EOF {
		// Drain any pending node queued by parseDialogueWithExpr.
		if p.pending != nil {
			nodes = append(nodes, p.pending)
			p.pending = nil
			continue
		}
		node, err := p.parseStatement()
		if err != nil {
			return nil, err
		}
		if node != nil {
			nodes = append(nodes, node)
		}
	}
	// Drain final pending node if any (e.g. dialogue-with-expr was the last
	// statement before RBRACE).
	if p.pending != nil {
		nodes = append(nodes, p.pending)
		p.pending = nil
	}
	return nodes, nil
}

// parseStatement dispatches to the appropriate parser based on current token.
// If a pending node was queued by parseDialogueWithExpr, it is returned first.
func (p *Parser) parseStatement() (ast.Node, error) {
	if p.pending != nil {
		node := p.pending
		p.pending = nil
		return node, nil
	}
	if p.cur.Type == token.AT {
		return p.parseDirective()
	}
	if p.cur.Type == token.AMPERSAND {
		return p.parseConcurrentDirective()
	}
	if p.cur.Type == token.IDENT && p.peek.Type == token.COLON {
		return p.parseDialogue()
	}
	if p.cur.Type == token.IDENT && p.peek.Type == token.LBRACKET {
		return p.parseDialogueWithExpr()
	}
	// Skip unexpected tokens to avoid infinite loops.
	p.advance()
	return nil, nil
}

// parseConcurrentDirective handles &-prefixed directives. It parses the
// directive the same way as @-prefixed ones, then marks the resulting node
// as concurrent.
func (p *Parser) parseConcurrentDirective() (ast.Node, error) {
	node, err := p.parseDirective() // parseDirective consumes AT/AMPERSAND via advance
	if err != nil {
		// If the error is about expecting IDENT but got COLON, this is likely &DIALOGUE: text
		if strings.Contains(err.Error(), "got COLON") || strings.Contains(err.Error(), "got \":\"") {
			return nil, fmt.Errorf("%v (hint: & prefix cannot be used with dialogue lines, remove the &)", err)
		}
		return nil, err
	}
	if hc, ok := node.(ast.HasConcurrent); ok {
		hc.SetConcurrent(true)
	}
	return node, nil
}

// parseDialogue handles IDENT COLON text lines (NARRATOR, YOU, or character).
//
// When this is called, cur=IDENT and peek=COLON. The lexer's internal position
// is right after having read the COLON token, which is exactly where
// ReadDialogueText expects to start. We call it directly, then re-prime
// the parser's cur/peek lookahead.
func (p *Parser) parseDialogue() (ast.Node, error) {
	name := p.cur.Literal

	// The lexer is positioned right after COLON. Call ReadDialogueText.
	textTok := p.l.ReadDialogueText()

	// Re-prime cur and peek, skipping comments and newlines.
	p.cur = p.l.NextToken()
	for p.cur.Type == token.COMMENT || p.cur.Type == token.NEWLINE {
		p.cur = p.l.NextToken()
	}
	p.peek = p.l.NextToken()
	for p.peek.Type == token.COMMENT || p.peek.Type == token.NEWLINE {
		p.peek = p.l.NextToken()
	}

	switch name {
	case "NARRATOR":
		return &ast.NarratorNode{Text: textTok.Literal}, nil
	case "YOU":
		return &ast.YouNode{Text: textTok.Literal}, nil
	default:
		return &ast.DialogueNode{Character: name, Text: textTok.Literal}, nil
	}
}

// parseDialogueWithExpr handles the syntax sugar:
//
//	CHARACTER [pose_expr]: text
//
// Token stream when called: cur=IDENT("MAURICIO"), peek=LBRACKET
// Full stream:  IDENT LBRACKET IDENT RBRACKET COLON <dialogue text>
//
// This is equivalent to:
//
//	@character pose_expr
//	CHARACTER: text
//
// It returns CharShowNode immediately, and queues the dialogue node as
// p.pending so the next parseStatement call drains it — preserving order.
func (p *Parser) parseDialogueWithExpr() (ast.Node, error) {
	name := p.cur.Literal
	charID := strings.ToLower(name)

	// cur=IDENT(name), peek=LBRACKET
	p.advance() // cur=LBRACKET, peek=IDENT(pose)
	p.advance() // cur=IDENT(pose), peek=RBRACKET

	// Read pose_expr IDENT.
	if p.cur.Type != token.IDENT {
		return nil, fmt.Errorf("line %d col %d: expected pose expression after '[', got %s (%q)",
			p.cur.Line, p.cur.Col, p.cur.Type, p.cur.Literal)
	}
	pose := p.cur.Literal

	p.advance() // cur=RBRACKET, peek=COLON

	// Confirm RBRACKET.
	if p.cur.Type != token.RBRACKET {
		return nil, fmt.Errorf("line %d col %d: expected ']' after pose expression, got %s (%q)",
			p.cur.Line, p.cur.Col, p.cur.Type, p.cur.Literal)
	}

	// At this point: cur=RBRACKET, peek=COLON.
	// The lexer's internal pos is now right after the COLON character —
	// exactly where ReadDialogueText expects to start.
	if p.peek.Type != token.COLON {
		return nil, fmt.Errorf("line %d col %d: expected ':' after ']', got %s (%q)",
			p.peek.Line, p.peek.Col, p.peek.Type, p.peek.Literal)
	}

	textTok := p.l.ReadDialogueText()

	// Re-prime cur and peek, skipping comments and newlines.
	p.cur = p.l.NextToken()
	for p.cur.Type == token.COMMENT || p.cur.Type == token.NEWLINE {
		p.cur = p.l.NextToken()
	}
	p.peek = p.l.NextToken()
	for p.peek.Type == token.COMMENT || p.peek.Type == token.NEWLINE {
		p.peek = p.l.NextToken()
	}

	// Queue the dialogue node as pending — returned on the next parseStatement call.
	switch name {
	case "NARRATOR":
		p.pending = &ast.NarratorNode{Text: textTok.Literal}
	case "YOU":
		p.pending = &ast.YouNode{Text: textTok.Literal}
	default:
		p.pending = &ast.DialogueNode{Character: name, Text: textTok.Literal}
	}

	// Return CharShowNode first. The "show vs. swap pose" decision is the
	// engine's at runtime — the parser always emits CharShowNode.
	return &ast.CharShowNode{
		Char: charID,
		Look: pose,
	}, nil
}

// parseDirective parses an @-prefixed or &-prefixed directive.
func (p *Parser) parseDirective() (ast.Node, error) {
	p.advance() // consume AT or AMPERSAND
	keyword := p.cur.Literal

	switch keyword {
	case "bg":
		return p.parseBg()
	case "cg":
		return p.parseCg()
	case "phone":
		return p.parsePhoneBlock()
	case "text":
		return p.parseText()
	case "music":
		return p.parseMusic()
	case "sfx":
		return p.parseSfx()
	case "minigame":
		return p.parseMinigame()
	case "trick":
		return p.parseTrick()
	case "choice":
		return p.parseChoice()
	case "affection":
		return p.parseAffection()
	case "signal":
		return p.parseSignal()
	case "butterfly":
		return p.parseButterfly()
	case "if":
		return p.parseIf()
	case "pause":
		return p.parsePause()
	case "achievement":
		return p.parseAchievement()
	case "on":
		return nil, fmt.Errorf("line %d col %d: @on is not a LS directive — use @if (check.success) / @else inside brave options", p.cur.Line, p.cur.Col)
	default:
		// Not a known keyword — treat as character directive.
		return p.parseCharDirective(keyword)
	}
}

// parseBg parses: @bg set <name> [transition]
func (p *Parser) parseBg() (ast.Node, error) {
	p.advance()                                      // consume "bg"
	if _, err := p.expect(token.IDENT); err != nil { // consume "set"
		return nil, err
	}
	name, err := p.expect(token.IDENT)
	if err != nil {
		return nil, err
	}
	node := &ast.BgSetNode{Name: name.Literal}
	// Optional transition.
	if p.cur.Type == token.IDENT && !p.isDirectiveStart() {
		node.Transition = p.cur.Literal
		p.advance()
	}
	return node, nil
}

// parseCg parses: @cg <name> "<content>"
//
// CG is a leaf directive — no body, no per-script duration, no transition.
// Pacing, camera motion, and emphasis are derived downstream from <content>.
func (p *Parser) parseCg() (ast.Node, error) {
	p.advance() // consume "cg"
	name, err := p.expect(token.IDENT)
	if err != nil {
		return nil, err
	}
	content, err := p.expect(token.STRING)
	if err != nil {
		return nil, fmt.Errorf("line %d col %d: @cg %s requires a quoted content string", content.Line, content.Col, name.Literal)
	}
	return &ast.CgShowNode{
		Name:    name.Literal,
		Content: content.Literal,
	}, nil
}

// parsePhoneBlock parses: @phone { <text-message-only body> }
//
// Inside the @phone block ONLY `@text from/to` directives are allowed.
// Anything else is a parse error.
func (p *Parser) parsePhoneBlock() (ast.Node, error) {
	p.advance() // consume "phone"
	openingBrace, err := p.expect(token.LBRACE)
	if err != nil {
		return nil, err
	}
	if p.cur.Type != token.RBRACE && p.cur.Type != token.EOF && p.cur.Line == openingBrace.Line {
		return nil, fmt.Errorf("line %d col %d: @phone must be written as a multiline block; put each @text from/to message on its own line",
			p.cur.Line, p.cur.Col)
	}

	node := &ast.PhoneShowNode{}
	for p.cur.Type != token.RBRACE && p.cur.Type != token.EOF {
		if p.cur.Type != token.AT || p.peek.Literal != "text" {
			return nil, fmt.Errorf("line %d col %d: inside @phone block, only @text from/to is allowed",
				p.cur.Line, p.cur.Col)
		}
		// Consume AT, then dispatch to parseText.
		p.advance() // consume AT
		// Now cur == "text" IDENT — parseText expects exactly that.
		msg, err := p.parseText()
		if err != nil {
			return nil, err
		}
		if msg != nil {
			node.Body = append(node.Body, msg)
		}
	}
	if _, err := p.expect(token.RBRACE); err != nil {
		return nil, err
	}
	return node, nil
}

// parseText parses: @text from <char>: content  or  @text to <char>: content
//
// After consuming "text", we see direction then char. The char IDENT is
// followed by COLON, mirroring the dialogue IDENT COLON pattern. We then
// call ReadDialogueText directly on the lexer's already-after-COLON position.
func (p *Parser) parseText() (ast.Node, error) {
	p.advance() // consume "text"
	direction := p.cur
	if direction.Type != token.IDENT {
		return nil, fmt.Errorf("line %d: expected direction (from/to), got %s",
			direction.Line, direction.Type)
	}
	if direction.Literal != "from" && direction.Literal != "to" {
		return nil, fmt.Errorf("line %d col %d: @text direction must be 'from' or 'to', got %q",
			direction.Line, direction.Col, direction.Literal)
	}
	p.advance() // consume direction

	// Now cur = char IDENT, peek = COLON.
	char := p.cur
	if char.Type != token.IDENT {
		return nil, fmt.Errorf("line %d: expected character name, got %s",
			char.Line, char.Type)
	}
	if p.peek.Type != token.COLON {
		return nil, fmt.Errorf("line %d: expected COLON after character in @text, got %s",
			p.peek.Line, p.peek.Type)
	}

	// Lexer is right after COLON. Call ReadDialogueText.
	textTok := p.l.ReadDialogueText()

	// Re-prime parser state.
	p.cur = p.l.NextToken()
	for p.cur.Type == token.COMMENT || p.cur.Type == token.NEWLINE {
		p.cur = p.l.NextToken()
	}
	p.peek = p.l.NextToken()
	for p.peek.Type == token.COMMENT || p.peek.Type == token.NEWLINE {
		p.peek = p.l.NextToken()
	}

	return &ast.TextMessageNode{
		Direction: direction.Literal,
		Char:      char.Literal,
		Content:   textTok.Literal,
	}, nil
}

// parseMusic parses: @music <name>  or  @music stop
//
// The engine inspects current playback state and either fades in from
// silence or cross-fades from the currently playing track — the script
// does not distinguish the two cases. `@music stop` fades out.
func (p *Parser) parseMusic() (ast.Node, error) {
	p.advance() // consume "music"
	tok, err := p.expect(token.IDENT)
	if err != nil {
		return nil, err
	}
	if tok.Literal == "stop" {
		return &ast.MusicStopNode{}, nil
	}
	return &ast.MusicSetNode{Name: tok.Literal}, nil
}

// parseSfx parses: @sfx <name>
func (p *Parser) parseSfx() (ast.Node, error) {
	p.advance() // consume "sfx"
	name, err := p.expect(token.IDENT)
	if err != nil {
		return nil, err
	}
	return &ast.SfxNode{Name: name.Literal}, nil
}

// parseMinigame parses: @minigame <name> "<description>"
//
// The minigame is generated downstream by a vibe-coding agent from the
// description prose (which describes both the scene and the simple
// gameplay). The directive is a leaf — no body, no attribute, no rating
// branching, no script-side reward.
func (p *Parser) parseMinigame() (ast.Node, error) {
	p.advance() // consume "minigame"
	name, err := p.expect(token.IDENT)
	if err != nil {
		return nil, err
	}
	desc, err := p.expect(token.STRING)
	if err != nil {
		return nil, err
	}
	return &ast.MinigameNode{
		Name:        name.Literal,
		Description: desc.Literal,
	}, nil
}

// parseTrick parses: @trick <type> "<prompt>"
//
// <type> must be one of the six engine-supported trick types (see
// ast.Trick* constants). "<prompt>" is the one-line player-facing
// imperative. The directive is a leaf — no body, no rating, no reward.
func (p *Parser) parseTrick() (ast.Node, error) {
	p.advance() // consume "trick"

	typeTok, err := p.expect(token.IDENT)
	if err != nil {
		return nil, err
	}
	if !validTrickTypes[typeTok.Literal] {
		return nil, fmt.Errorf("line %d col %d: invalid @trick type %q (valid: tap, hold, swipe, shake, swing, tilt)", typeTok.Line, typeTok.Col, typeTok.Literal)
	}

	promptTok, err := p.expect(token.STRING)
	if err != nil {
		return nil, err
	}

	return &ast.TrickNode{
		Type:   typeTok.Literal,
		Prompt: promptTok.Literal,
	}, nil
}

// parseChoice parses: @choice { @option ... }
func (p *Parser) parseChoice() (ast.Node, error) {
	p.advance() // consume "choice"
	if _, err := p.expect(token.LBRACE); err != nil {
		return nil, err
	}

	node := &ast.ChoiceNode{}

	for p.cur.Type != token.RBRACE && p.cur.Type != token.EOF {
		if p.cur.Type == token.AT && p.peek.Literal == "option" {
			opt, err := p.parseOption()
			if err != nil {
				return nil, err
			}
			node.Options = append(node.Options, opt)
		} else {
			p.advance()
		}
	}

	if len(node.Options) == 0 {
		return nil, fmt.Errorf("line %d col %d: @choice block has no @option entries", p.cur.Line, p.cur.Col)
	}

	if _, err := p.expect(token.RBRACE); err != nil {
		return nil, err
	}
	return node, nil
}

// parseOption parses: @option <ID> <brave|safe> "<text>" { body }
func (p *Parser) parseOption() (*ast.OptionNode, error) {
	p.advance() // consume AT
	p.advance() // consume "option"
	id, err := p.expect(token.IDENT)
	if err != nil {
		return nil, err
	}
	mode, err := p.expect(token.IDENT)
	if err != nil {
		return nil, err
	}
	text, err := p.expect(token.STRING)
	if err != nil {
		return nil, err
	}
	if _, err := p.expect(token.LBRACE); err != nil {
		return nil, err
	}

	opt := &ast.OptionNode{
		ID:   id.Literal,
		Mode: mode.Literal,
		Text: text.Literal,
	}

	if mode.Literal == "brave" {
		err := p.parseBraveOptionBody(opt)
		if err != nil {
			return nil, err
		}
	} else {
		// Safe option: body is direct narrative content.
		body, err := p.parseBlock()
		if err != nil {
			return nil, err
		}
		opt.Body = body
	}

	if _, err := p.expect(token.RBRACE); err != nil {
		return nil, err
	}
	return opt, nil
}

// parseBraveOptionBody parses a brave option body:
//
//	check { attr: X  dc: N }
//	<any LS body statements — typically @if (check.success) { ... } @else { ... }>
//
// The check block must appear somewhere in the body (validator enforces
// its presence). Beyond that, body statements are plain LS — authors
// use @if with the CheckCondition (check.success / check.fail) to route
// on the resolved check outcome.
func (p *Parser) parseBraveOptionBody(opt *ast.OptionNode) error {
	for p.cur.Type != token.RBRACE && p.cur.Type != token.EOF {
		if p.cur.Type == token.IDENT && p.cur.Literal == "check" {
			p.advance() // consume "check"
			if _, err := p.expect(token.LBRACE); err != nil {
				return err
			}
			check := &ast.CheckBlock{}
			// Parse key-value pairs inside check block.
			for p.cur.Type != token.RBRACE && p.cur.Type != token.EOF {
				if p.cur.Type == token.IDENT {
					key := p.cur.Literal
					p.advance() // consume key
					if _, err := p.expect(token.COLON); err != nil {
						return err
					}
					switch key {
					case "attr":
						val, err := p.expect(token.IDENT)
						if err != nil {
							return err
						}
						check.Attr = val.Literal
					case "dc":
						val, err := p.expect(token.NUMBER)
						if err != nil {
							return err
						}
						dc, dcErr := strconv.Atoi(val.Literal)
						if dcErr != nil {
							return fmt.Errorf("line %d col %d: invalid dc value %q", val.Line, val.Col, val.Literal)
						}
						check.DC = dc
					default:
						p.advance() // skip unknown key values
					}
				} else {
					p.advance()
				}
			}
			if _, err := p.expect(token.RBRACE); err != nil {
				return err
			}
			opt.Check = check
		} else {
			node, err := p.parseStatement()
			if err != nil {
				return err
			}
			if node != nil {
				opt.Body = append(opt.Body, node)
			}
		}
	}
	return nil
}

// parseAffection parses: @affection <char> +/-N
func (p *Parser) parseAffection() (ast.Node, error) {
	p.advance() // consume "affection"
	char, err := p.expect(token.IDENT)
	if err != nil {
		return nil, err
	}
	delta, err := p.expect(token.SIGNED_NUMBER)
	if err != nil {
		return nil, err
	}
	return &ast.AffectionNode{Char: char.Literal, Delta: delta.Literal}, nil
}

// parseSignal parses: @signal <kind> ...
//
// Two kinds:
//   - mark: @signal mark <event>    — event is IDENT or STRING
//   - int:  @signal int <name> <op> <value>
//     op ∈ { "=", "+", "-" }; value is an integer literal.
//     "=" accepts NUMBER or SIGNED_NUMBER (may be negative).
//     "+"/"-" accepts NUMBER only (the sign is in the operator).
func (p *Parser) parseSignal() (ast.Node, error) {
	p.advance() // consume "signal"
	kindTok, err := p.expect(token.IDENT)
	if err != nil {
		return nil, fmt.Errorf("line %d col %d: expected signal kind after '@signal' (one of: mark, int), got %s (%q)",
			kindTok.Line, kindTok.Col, kindTok.Type, kindTok.Literal)
	}
	if !validSignalKinds[kindTok.Literal] {
		return nil, fmt.Errorf("line %d col %d: invalid signal kind %q (valid: mark, int)",
			kindTok.Line, kindTok.Col, kindTok.Literal)
	}

	switch kindTok.Literal {
	case ast.SignalKindMark:
		return p.parseSignalMark(kindTok)
	case ast.SignalKindInt:
		return p.parseSignalInt(kindTok)
	default:
		// Unreachable due to validSignalKinds whitelist above.
		return nil, fmt.Errorf("line %d col %d: unhandled signal kind %q", kindTok.Line, kindTok.Col, kindTok.Literal)
	}
}

// parseSignalMark parses the event name (IDENT or STRING) following
// `@signal mark`.
func (p *Parser) parseSignalMark(kindTok token.Token) (ast.Node, error) {
	var event string
	if p.cur.Type == token.STRING {
		event = p.cur.Literal
		p.advance()
	} else {
		tok, err := p.expect(token.IDENT)
		if err != nil {
			return nil, fmt.Errorf("line %d col %d: expected event name after '@signal mark', got %s (%q)",
				tok.Line, tok.Col, tok.Type, tok.Literal)
		}
		event = tok.Literal
	}
	return &ast.SignalNode{Kind: ast.SignalKindMark, Event: event}, nil
}

// parseSignalInt parses `<name> <op> <value>` following `@signal int`.
func (p *Parser) parseSignalInt(kindTok token.Token) (ast.Node, error) {
	nameTok, err := p.expect(token.IDENT)
	if err != nil {
		return nil, fmt.Errorf("line %d col %d: expected variable name after '@signal int', got %s (%q)",
			nameTok.Line, nameTok.Col, nameTok.Type, nameTok.Literal)
	}

	// Operator: ASSIGN ('='), or a sign merged into SIGNED_NUMBER ('+N' / '-N').
	switch p.cur.Type {
	case token.ASSIGN:
		p.advance() // consume '='
		// Value: NUMBER or SIGNED_NUMBER.
		if p.cur.Type != token.NUMBER && p.cur.Type != token.SIGNED_NUMBER {
			return nil, fmt.Errorf("line %d col %d: expected integer literal after '@signal int %s =', got %s (%q)",
				p.cur.Line, p.cur.Col, nameTok.Literal, p.cur.Type, p.cur.Literal)
		}
		valTok := p.cur
		p.advance()
		if p.cur.Type == token.DOT {
			return nil, fmt.Errorf("line %d col %d: '@signal int %s = ...' requires an integer literal; %q looks like a float",
				valTok.Line, valTok.Col, nameTok.Literal, valTok.Literal+".")
		}
		n, err := strconv.Atoi(valTok.Literal)
		if err != nil {
			return nil, fmt.Errorf("line %d col %d: invalid integer %q in '@signal int %s = ...': %v",
				valTok.Line, valTok.Col, valTok.Literal, nameTok.Literal, err)
		}
		return &ast.SignalNode{
			Kind:  ast.SignalKindInt,
			Name:  nameTok.Literal,
			Op:    ast.SignalOpAssign,
			Value: n,
		}, nil

	case token.SIGNED_NUMBER:
		// '+N' or '-N' lexed as a single signed number token.
		valTok := p.cur
		p.advance()
		n, err := strconv.Atoi(valTok.Literal)
		if err != nil {
			return nil, fmt.Errorf("line %d col %d: invalid signed integer %q in '@signal int %s ...': %v",
				valTok.Line, valTok.Col, valTok.Literal, nameTok.Literal, err)
		}
		if n == 0 {
			return nil, fmt.Errorf("line %d col %d: '@signal int %s +0' or '-0' is meaningless; use '@signal int %s = 0' to assign",
				valTok.Line, valTok.Col, nameTok.Literal, nameTok.Literal)
		}
		op := ast.SignalOpAdd
		abs := n
		if n < 0 {
			op = ast.SignalOpSub
			abs = -n
		}
		return &ast.SignalNode{
			Kind:  ast.SignalKindInt,
			Name:  nameTok.Literal,
			Op:    op,
			Value: abs,
		}, nil

	default:
		if p.cur.Type == token.ILLEGAL && (p.cur.Literal == "+" || p.cur.Literal == "-") {
			return nil, fmt.Errorf("line %d col %d: '@signal int %s %s...': no whitespace allowed between sign and digit (write '%s1' or '%s2', not '%s 1')",
				p.cur.Line, p.cur.Col, nameTok.Literal, p.cur.Literal, p.cur.Literal, p.cur.Literal, p.cur.Literal)
		}
		return nil, fmt.Errorf("line %d col %d: expected '=', '+N', or '-N' after '@signal int %s', got %s (%q)",
			p.cur.Line, p.cur.Col, nameTok.Literal, p.cur.Type, p.cur.Literal)
	}
}

// parseAchievement parses:
//
//	@achievement <id> {
//	  name: "..."
//	  rarity: <uncommon|rare|epic|legendary>
//	  description: "..."
//	}
//
// The block form is the only form — reaching this node in execution
// fires the achievement. Conditional triggering is expressed by wrapping
// in @if (condition) { @achievement ... { ... } }.
func (p *Parser) parseAchievement() (ast.Node, error) {
	p.advance() // consume "achievement"

	idTok, err := p.expect(token.IDENT)
	if err != nil {
		return nil, fmt.Errorf("line %d col %d: expected achievement id after '@achievement', got %s (%q)",
			idTok.Line, idTok.Col, idTok.Type, idTok.Literal)
	}

	if p.cur.Type != token.LBRACE {
		return nil, fmt.Errorf("line %d col %d: @achievement %s requires a block with name / rarity / description fields",
			p.cur.Line, p.cur.Col, idTok.Literal)
	}
	p.advance() // consume LBRACE

	node := &ast.AchievementNode{ID: idTok.Literal}
	seen := map[string]bool{}

	for p.cur.Type != token.RBRACE && p.cur.Type != token.EOF {
		if p.cur.Type != token.IDENT {
			return nil, fmt.Errorf("line %d col %d: expected achievement field key, got %s (%q)",
				p.cur.Line, p.cur.Col, p.cur.Type, p.cur.Literal)
		}
		key := p.cur.Literal
		if seen[key] {
			return nil, fmt.Errorf("line %d col %d: duplicate achievement field %q", p.cur.Line, p.cur.Col, key)
		}
		seen[key] = true
		p.advance() // consume key
		if _, err := p.expect(token.COLON); err != nil {
			return nil, err
		}
		switch key {
		case "name":
			val, err := p.expect(token.STRING)
			if err != nil {
				return nil, fmt.Errorf("line %d col %d: achievement name must be a quoted string", val.Line, val.Col)
			}
			node.Name = val.Literal
		case "description":
			val, err := p.expect(token.STRING)
			if err != nil {
				return nil, fmt.Errorf("line %d col %d: achievement description must be a quoted string", val.Line, val.Col)
			}
			node.Description = val.Literal
		case "rarity":
			val, err := p.expect(token.IDENT)
			if err != nil {
				return nil, fmt.Errorf("line %d col %d: achievement rarity must be an identifier", val.Line, val.Col)
			}
			if !validRarities[val.Literal] {
				return nil, fmt.Errorf("line %d col %d: invalid rarity %q (must be uncommon, rare, epic, or legendary)",
					val.Line, val.Col, val.Literal)
			}
			node.Rarity = val.Literal
		default:
			return nil, fmt.Errorf("line %d col %d: unknown achievement field %q (expected name, rarity, or description)",
				p.cur.Line, p.cur.Col, key)
		}
	}

	if _, err := p.expect(token.RBRACE); err != nil {
		return nil, err
	}

	// All three fields required.
	if node.Name == "" {
		return nil, fmt.Errorf("achievement %q: missing required field 'name'", node.ID)
	}
	if node.Rarity == "" {
		return nil, fmt.Errorf("achievement %q: missing required field 'rarity'", node.ID)
	}
	if node.Description == "" {
		return nil, fmt.Errorf("achievement %q: missing required field 'description'", node.ID)
	}
	return node, nil
}

// parseButterfly parses: @butterfly "<desc>"
//
// Butterfly records are NOT consulted by gate routing — they are fuzzy
// player-profile fuel for downstream content-generation agents. (Gate
// routing always uses deterministic conditions: signal mark, signal int,
// affection, choice history.)
func (p *Parser) parseButterfly() (ast.Node, error) {
	p.advance() // consume "butterfly"
	desc, err := p.expect(token.STRING)
	if err != nil {
		return nil, err
	}
	return &ast.ButterflyNode{Description: desc.Literal}, nil
}

// parseIf parses: @if (condition) { body } [@else @if (...) { } | @else { }]
func (p *Parser) parseIf() (ast.Node, error) {
	p.advance() // consume "if"

	cond, err := p.readCondition()
	if err != nil {
		return nil, err
	}

	if _, err := p.expect(token.LBRACE); err != nil {
		return nil, err
	}
	then, err := p.parseBlock()
	if err != nil {
		return nil, err
	}
	if _, err := p.expect(token.RBRACE); err != nil {
		return nil, err
	}

	node := &ast.IfNode{
		Condition: cond,
		Then:      then,
	}

	// Check for @else @if (chain) or @else { } (plain).
	if p.cur.Type == token.AT && p.peek.Literal == "else" {
		p.advance() // consume AT
		p.advance() // consume "else"

		if p.cur.Type == token.AT && p.peek.Literal == "if" {
			// @else @if — recursive chain
			p.advance() // consume AT so parseIf sees "if" as cur
			elseIf, err := p.parseIf()
			if err != nil {
				return nil, err
			}
			node.Else = []ast.Node{elseIf}
		} else {
			// plain @else { }
			if _, err := p.expect(token.LBRACE); err != nil {
				return nil, err
			}
			els, err := p.parseBlock()
			if err != nil {
				return nil, err
			}
			if _, err := p.expect(token.RBRACE); err != nil {
				return nil, err
			}
			node.Else = els
		}
	}

	return node, nil
}

// readCondition reads a parenthesized condition and parses it into a typed
// Condition AST. Shared by body @if and gate @if.
//
// Grammar (recursive descent, left-associative):
//
//	expr       = or_expr
//	or_expr    = and_expr ( "||" and_expr )*
//	and_expr   = primary ( "&&" primary )*
//	primary    = "(" expr ")"
//	           | choice       ( IDENT "." ( "success" | "fail" | "any" ) )
//	           | check        ( "check" "." ( "success" | "fail" ) )
//	           | comparison   ( operand OP operand )
//	           | flag         ( IDENT )
//	operand    = NUMBER | SIGNED_NUMBER
//	           | "affection" "." IDENT
//	           | "MAX" "(" operand ( "," operand )+ ")"
//	           | "MIN" "(" operand ( "," operand )+ ")"
//	           | IDENT                       (bare value name)
func (p *Parser) readCondition() (ast.Condition, error) {
	if _, err := p.expect(token.LPAREN); err != nil {
		return nil, err
	}

	cond, err := p.parseOrExpr()
	if err != nil {
		return nil, err
	}

	if _, err := p.expect(token.RPAREN); err != nil {
		return nil, err
	}
	return cond, nil
}

// parseOrExpr parses an 'or_expr' — one or more primaries joined by "||".
// "||" has lower precedence than "&&".
func (p *Parser) parseOrExpr() (ast.Condition, error) {
	left, err := p.parseAndExpr()
	if err != nil {
		return nil, err
	}
	for p.cur.Type == token.OR {
		p.advance() // consume ||
		right, err := p.parseAndExpr()
		if err != nil {
			return nil, err
		}
		left = &ast.CompoundCondition{Op: "||", Left: left, Right: right}
	}
	return left, nil
}

// parseAndExpr parses an 'and_expr' — one or more primaries joined by "&&".
func (p *Parser) parseAndExpr() (ast.Condition, error) {
	left, err := p.parseConditionPrimary()
	if err != nil {
		return nil, err
	}
	for p.cur.Type == token.AND {
		p.advance() // consume &&
		right, err := p.parseConditionPrimary()
		if err != nil {
			return nil, err
		}
		left = &ast.CompoundCondition{Op: "&&", Left: left, Right: right}
	}
	return left, nil
}

// parseConditionPrimary parses a single leaf condition or a parenthesized
// sub-expression.
//
// Decision tree for the leading token:
//   - LPAREN                                  → recurse into ( expr )
//   - STRING                                  → error (no string-literal conditions)
//   - IDENT "check" "." ...                   → CheckCondition
//   - IDENT "affection" "." ...               → ComparisonCondition (operand-driven)
//   - IDENT "." (success|fail|any)            → ChoiceCondition
//   - NUMBER | SIGNED_NUMBER                  → ComparisonCondition (literal left)
//   - IDENT "MAX"/"MIN" "(" ... ")"           → ComparisonCondition (aggregate left)
//   - IDENT <op> ...                          → ComparisonCondition (value left)
//   - IDENT (bare, not followed by op/./LPAREN) → FlagCondition
func (p *Parser) parseConditionPrimary() (ast.Condition, error) {
	// Parenthesized sub-expression.
	if p.cur.Type == token.LPAREN {
		p.advance() // consume (
		inner, err := p.parseOrExpr()
		if err != nil {
			return nil, err
		}
		if _, err := p.expect(token.RPAREN); err != nil {
			return nil, err
		}
		return inner, nil
	}

	// String literals are no longer valid conditions — InfluenceCondition
	// was removed. Surface a clear error so authors know what to use instead.
	if p.cur.Type == token.STRING {
		return nil, fmt.Errorf("line %d col %d: string literal not allowed as condition; supported types: choice, flag, comparison, compound, check",
			p.cur.Line, p.cur.Col)
	}

	// Numeric-literal-left comparison: 5 < affection.easton  etc.
	if p.cur.Type == token.NUMBER || p.cur.Type == token.SIGNED_NUMBER {
		left, err := p.parseOperand()
		if err != nil {
			return nil, err
		}
		return p.finishComparison(left)
	}

	if p.cur.Type != token.IDENT {
		return nil, fmt.Errorf("line %d col %d: expected condition, got %s (%q)",
			p.cur.Line, p.cur.Col, p.cur.Type, p.cur.Literal)
	}

	// IDENT-led leaves. First handle the dotted shapes (check, affection,
	// generic choice) — they consume the IDENT differently from operands.
	if p.peek.Type == token.DOT {
		firstTok := p.cur

		// Context-local: check.success / check.fail.
		if firstTok.Literal == "check" {
			p.advance() // consume "check"
			p.advance() // consume DOT
			if p.cur.Type != token.IDENT {
				return nil, fmt.Errorf("line %d col %d: expected identifier after 'check.', got %s (%q)",
					p.cur.Line, p.cur.Col, p.cur.Type, p.cur.Literal)
			}
			secondTok := p.cur
			p.advance() // consume second IDENT
			if secondTok.Literal != "success" && secondTok.Literal != "fail" {
				return nil, fmt.Errorf("line %d col %d: check.<result> must be 'success' or 'fail', got %q",
					secondTok.Line, secondTok.Col, secondTok.Literal)
			}
			return &ast.CheckCondition{Result: secondTok.Literal}, nil
		}

		// affection.<char> — operand-led comparison.
		if firstTok.Literal == "affection" {
			left, err := p.parseOperand()
			if err != nil {
				return nil, err
			}
			return p.finishComparison(left)
		}

		// Otherwise: ChoiceCondition — <option_id>.success|fail|any.
		p.advance() // consume first IDENT
		p.advance() // consume DOT
		if p.cur.Type != token.IDENT {
			return nil, fmt.Errorf("line %d col %d: expected identifier after '.', got %s (%q)",
				p.cur.Line, p.cur.Col, p.cur.Type, p.cur.Literal)
		}
		secondTok := p.cur
		p.advance() // consume second IDENT
		result := secondTok.Literal
		if result != "success" && result != "fail" && result != "any" {
			return nil, fmt.Errorf("line %d col %d: choice condition result must be 'success', 'fail', or 'any', got %q",
				secondTok.Line, secondTok.Col, result)
		}
		return &ast.ChoiceCondition{Option: firstTok.Literal, Result: result}, nil
	}

	// Aggregate-left comparison: MAX(...) / MIN(...) ...
	if (p.cur.Literal == "MAX" || p.cur.Literal == "MIN") && p.peek.Type == token.LPAREN {
		left, err := p.parseOperand()
		if err != nil {
			return nil, err
		}
		return p.finishComparison(left)
	}

	// Bare IDENT: either comparison (IDENT op operand) or flag (IDENT alone).
	nameTok := p.cur
	p.advance() // consume IDENT

	if isComparisonOp(p.cur.Type) {
		// Re-construct a value operand from nameTok, then finish the comparison.
		left := &ast.ComparisonOperand{
			Kind: ast.OperandValue,
			Name: nameTok.Literal,
		}
		return p.finishComparison(left)
	}

	return &ast.FlagCondition{Name: nameTok.Literal}, nil
}

// finishComparison consumes a comparison operator and the right-hand operand,
// then returns a ComparisonCondition. Caller must have already produced the
// left operand and left p.cur positioned at the operator token.
func (p *Parser) finishComparison(left *ast.ComparisonOperand) (ast.Condition, error) {
	if !isComparisonOp(p.cur.Type) {
		return nil, fmt.Errorf("line %d col %d: expected comparison operator (>=, <=, >, <, ==, !=), got %s (%q)",
			p.cur.Line, p.cur.Col, p.cur.Type, p.cur.Literal)
	}
	op := operatorLiteral(p.cur.Type)
	p.advance() // consume operator

	right, err := p.parseOperand()
	if err != nil {
		return nil, err
	}
	return &ast.ComparisonCondition{
		Left:  left,
		Op:    op,
		Right: right,
	}, nil
}

// parseOperand parses one side of a comparison. Five operand kinds:
//
//   - NUMBER / SIGNED_NUMBER             → literal
//   - "affection" "." IDENT              → affection
//   - "MAX" "(" operand ("," operand)+ ")" → max (aggregate)
//   - "MIN" "(" operand ("," operand)+ ")" → min (aggregate)
//   - bare IDENT                         → value (engine-managed or @signal int)
//
// `MAX` / `MIN` are reserved words — must be uppercase. Lowercase `max`/`min`
// fall through to the value-operand path (still legal as variable names).
func (p *Parser) parseOperand() (*ast.ComparisonOperand, error) {
	// Integer literal.
	if p.cur.Type == token.NUMBER || p.cur.Type == token.SIGNED_NUMBER {
		tok := p.cur
		p.advance()
		n, err := strconv.Atoi(tok.Literal)
		if err != nil {
			return nil, fmt.Errorf("line %d col %d: invalid integer literal %q", tok.Line, tok.Col, tok.Literal)
		}
		return &ast.ComparisonOperand{
			Kind:  ast.OperandLiteral,
			Value: n,
		}, nil
	}

	if p.cur.Type != token.IDENT {
		return nil, fmt.Errorf("line %d col %d: expected operand (literal, affection.<char>, MAX(...), MIN(...), or bare value name), got %s (%q)",
			p.cur.Line, p.cur.Col, p.cur.Type, p.cur.Literal)
	}

	// affection.<char>
	if p.cur.Literal == "affection" && p.peek.Type == token.DOT {
		p.advance() // consume "affection"
		p.advance() // consume DOT
		if p.cur.Type != token.IDENT {
			return nil, fmt.Errorf("line %d col %d: expected character id after 'affection.', got %s (%q)",
				p.cur.Line, p.cur.Col, p.cur.Type, p.cur.Literal)
		}
		charTok := p.cur
		p.advance() // consume char IDENT
		return &ast.ComparisonOperand{
			Kind: ast.OperandAffection,
			Char: charTok.Literal,
		}, nil
	}

	// MAX(...) / MIN(...) — reserved keywords, uppercase only.
	if (p.cur.Literal == "MAX" || p.cur.Literal == "MIN") && p.peek.Type == token.LPAREN {
		kind := ast.OperandMax
		if p.cur.Literal == "MIN" {
			kind = ast.OperandMin
		}
		return p.parseAggregateOperand(kind)
	}

	// Bare IDENT → value operand (engine scalar or @signal int variable).
	nameTok := p.cur
	p.advance()
	return &ast.ComparisonOperand{
		Kind: ast.OperandValue,
		Name: nameTok.Literal,
	}, nil
}

// parseAggregateOperand parses MAX(...) or MIN(...). Caller has confirmed
// p.cur is the keyword (MAX or MIN) and p.peek is LPAREN. kind must be one
// of ast.OperandMax / ast.OperandMin.
//
// args must have length >= 2; a 1-arg aggregate is a parse error per spec.
func (p *Parser) parseAggregateOperand(kind string) (*ast.ComparisonOperand, error) {
	kwTok := p.cur
	p.advance() // consume MAX / MIN
	if _, err := p.expect(token.LPAREN); err != nil {
		return nil, err
	}

	var args []*ast.ComparisonOperand
	first, err := p.parseOperand()
	if err != nil {
		return nil, err
	}
	args = append(args, first)

	for p.cur.Type == token.COMMA {
		p.advance() // consume ','
		next, err := p.parseOperand()
		if err != nil {
			return nil, err
		}
		args = append(args, next)
	}

	if _, err := p.expect(token.RPAREN); err != nil {
		return nil, err
	}

	if len(args) < 2 {
		return nil, fmt.Errorf("line %d col %d: %s(...) requires at least 2 arguments, got %d",
			kwTok.Line, kwTok.Col, kwTok.Literal, len(args))
	}

	return &ast.ComparisonOperand{
		Kind: kind,
		Args: args,
	}, nil
}

// isComparisonOp reports whether a token type is a comparison operator.
func isComparisonOp(t token.Type) bool {
	switch t {
	case token.GTE, token.LTE, token.GT, token.LT, token.EQ, token.NEQ:
		return true
	}
	return false
}

// operatorLiteral returns the canonical source-form of a comparison operator.
func operatorLiteral(t token.Type) string {
	switch t {
	case token.GTE:
		return ">="
	case token.LTE:
		return "<="
	case token.GT:
		return ">"
	case token.LT:
		return "<"
	case token.EQ:
		return "=="
	case token.NEQ:
		return "!="
	}
	return ""
}

// parsePause parses: @pause
//
// No parameters — a pause always waits for exactly one player click.
func (p *Parser) parsePause() (ast.Node, error) {
	p.advance() // consume "pause"
	return &ast.PauseNode{}, nil
}

// parseCharDirective parses character directives:
//
//	@<char> <pose> [transition]    → CharShowNode (show or pose-swap)
//	@<char> bubble <type>          → CharBubbleNode
//
// `bubble` is reserved — no pose may be named "bubble".
func (p *Parser) parseCharDirective(char string) (ast.Node, error) {
	p.advance() // consume character name
	if p.cur.Type != token.IDENT {
		return nil, fmt.Errorf("line %d col %d: expected pose or 'bubble' after '@%s', got %s (%q)",
			p.cur.Line, p.cur.Col, char, p.cur.Type, p.cur.Literal)
	}
	action := p.cur
	if action.Literal == "bubble" {
		p.advance() // consume "bubble"
		return p.parseCharBubble(char)
	}
	// Treat as pose. `bubble` is reserved — no pose can be named it.
	pose := action.Literal
	p.advance() // consume pose

	node := &ast.CharShowNode{
		Char: char,
		Look: pose,
	}
	// Optional transition.
	if p.cur.Type == token.IDENT && !p.isDirectiveStart() {
		node.Transition = p.cur.Literal
		p.advance()
	}
	return node, nil
}

// parseCharBubble parses: bubble <type>
//
// Caller has already consumed the "bubble" keyword. <type> is required and
// must be one of the 9 locked bubble types (see validBubbleTypes).
func (p *Parser) parseCharBubble(char string) (ast.Node, error) {
	if p.cur.Type != token.IDENT {
		return nil, fmt.Errorf("line %d col %d: @%s bubble requires a type argument (one of: anger, sweat, heart, question, exclaim, idea, music, doom, ellipsis)",
			p.cur.Line, p.cur.Col, char)
	}
	bubbleTok := p.cur
	if !validBubbleTypes[bubbleTok.Literal] {
		return nil, fmt.Errorf("line %d col %d: invalid bubble type %q for @%s (valid: anger, sweat, heart, question, exclaim, idea, music, doom, ellipsis)",
			bubbleTok.Line, bubbleTok.Col, bubbleTok.Literal, char)
	}
	p.advance() // consume bubble type
	return &ast.CharBubbleNode{
		Char:       char,
		BubbleType: bubbleTok.Literal,
	}, nil
}

// validEndTypes enumerates the accepted values for the gate `@end <type>` leaf.
var validEndTypes = map[string]bool{
	ast.EndingComplete:      true,
	ast.EndingToBeContinued: true,
	ast.EndingBad:           true,
}

// parseGateBlock parses: @gate { route ... }
//
// A route is one of:
//
//	@if (<cond>): <leaf>
//	@else @if (<cond>): <leaf>
//	@else: <leaf>
//	@next <branch_key>       (unconditional NextLeaf)
//	@end <type>              (unconditional EndLeaf)
//
// Routes are evaluated top-to-bottom; the first matching condition wins.
// A gate may freely mix @next and @end leaves.
func (p *Parser) parseGateBlock() (*ast.GateBlock, error) {
	p.advance() // consume AT
	p.advance() // consume "gate"
	if _, err := p.expect(token.LBRACE); err != nil {
		return nil, err
	}

	block := &ast.GateBlock{}

	for p.cur.Type != token.RBRACE && p.cur.Type != token.EOF {
		if p.cur.Type == token.AT {
			switch p.peek.Literal {
			case "if":
				route, err := p.parseGateIf()
				if err != nil {
					return nil, err
				}
				block.Routes = append(block.Routes, route)
			case "else":
				route, err := p.parseGateElse()
				if err != nil {
					return nil, err
				}
				block.Routes = append(block.Routes, route)
			case "next", "end":
				// Unconditional leaf — most common is `@gate { @next ... }`
				// or `@gate { @end <type> }` (terminal episode).
				leaf, err := p.parseGateLeaf()
				if err != nil {
					return nil, err
				}
				block.Routes = append(block.Routes, &ast.GateRoute{Leaf: leaf})
			default:
				p.advance()
			}
		} else {
			p.advance()
		}
	}

	if len(block.Routes) == 0 {
		return nil, fmt.Errorf("line %d col %d: @gate block has no routes", p.cur.Line, p.cur.Col)
	}

	if _, err := p.expect(token.RBRACE); err != nil {
		return nil, err
	}
	return block, nil
}

// parseGateIf parses: @if (<condition>): <leaf>
func (p *Parser) parseGateIf() (*ast.GateRoute, error) {
	p.advance() // consume AT
	p.advance() // consume "if"

	cond, err := p.readCondition()
	if err != nil {
		return nil, err
	}

	if _, err := p.expect(token.COLON); err != nil {
		return nil, err
	}

	leaf, err := p.parseGateLeaf()
	if err != nil {
		return nil, err
	}

	return &ast.GateRoute{Condition: cond, Leaf: leaf}, nil
}

// parseGateElse parses: @else @if (...): <leaf> OR @else: <leaf>
func (p *Parser) parseGateElse() (*ast.GateRoute, error) {
	p.advance() // consume AT
	p.advance() // consume "else"

	// Check for @else @if (chained condition).
	if p.cur.Type == token.AT && p.peek.Literal == "if" {
		return p.parseGateIf()
	}

	// Plain @else: <leaf>
	if _, err := p.expect(token.COLON); err != nil {
		return nil, err
	}

	leaf, err := p.parseGateLeaf()
	if err != nil {
		return nil, err
	}

	return &ast.GateRoute{Condition: nil, Leaf: leaf}, nil
}

// parseGateLeaf consumes one of `@next <branch_key>` or `@end <type>` and
// returns the corresponding GateLeaf node. The leaf type is validated:
// `@end` types must be in validEndTypes.
func (p *Parser) parseGateLeaf() (ast.GateLeaf, error) {
	if _, err := p.expect(token.AT); err != nil {
		return nil, err
	}
	kw, err := p.expect(token.IDENT)
	if err != nil {
		return nil, err
	}
	switch kw.Literal {
	case "next":
		target, err := p.expect(token.IDENT)
		if err != nil {
			return nil, err
		}
		return &ast.NextLeaf{Target: target.Literal}, nil
	case "end":
		endType, err := p.expect(token.IDENT)
		if err != nil {
			return nil, fmt.Errorf("line %d col %d: expected ending type after '@end', got %s (%q)",
				endType.Line, endType.Col, endType.Type, endType.Literal)
		}
		if !validEndTypes[endType.Literal] {
			return nil, fmt.Errorf("line %d col %d: invalid @end type %q (must be one of: complete, to_be_continued, bad_ending)",
				endType.Line, endType.Col, endType.Literal)
		}
		return &ast.EndLeaf{Type: endType.Literal}, nil
	default:
		return nil, fmt.Errorf("line %d col %d: expected 'next' or 'end' inside @gate, got %q",
			kw.Line, kw.Col, kw.Literal)
	}
}

// isDirectiveStart returns true if cur looks like the start of a new directive
// (i.e. the next thing is @something or NAME:dialogue). Used to stop consuming
// optional trailing IDENTs.
func (p *Parser) isDirectiveStart() bool {
	// We only need this for optional-ident lookahead. If the current IDENT
	// is followed by AT/AMPERSAND or followed by COLON (dialogue), it's a new statement.
	if p.peek.Type == token.AT || p.peek.Type == token.AMPERSAND {
		return false // The current ident is before an @/& — it's likely a param.
	}
	if p.peek.Type == token.COLON {
		// Current IDENT + COLON = dialogue start. Don't consume.
		return true
	}
	if p.peek.Type == token.LBRACKET {
		// Current IDENT + LBRACKET = dialogue sugar (CHARACTER [look]: text). Don't consume.
		return true
	}
	return false
}
