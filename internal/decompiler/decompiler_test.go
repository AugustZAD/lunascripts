package decompiler

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/cdotlock/lunascripts/internal/emitter"
	"github.com/cdotlock/lunascripts/internal/lexer"
	"github.com/cdotlock/lunascripts/internal/parser"
	"github.com/cdotlock/lunascripts/internal/resolver"
	"github.com/cdotlock/lunascripts/internal/validator"
)

// fixedResolver is an in-memory emitter.AssetResolver wired with the asset
// table for the inline LS sources used in these tests. Returning a stable
// URL for every name lets the decompiler reconstruct the mapping; the
// decompiler in turn must surface those names in the recovered LS source.
type fixedResolver struct {
	baseURL    string
	bg         map[string]string
	characters map[string]map[string]string
	music      map[string]string
	sfx        map[string]string
	cg         map[string]string
	minigames  map[string]string
}

func newFixedResolver() *fixedResolver {
	return &fixedResolver{
		baseURL: "https://oss.example.com/novel_test",
		bg: map[string]string{
			"classroom":   "bg/classroom.png",
			"school_yard": "bg/school_yard.png",
		},
		characters: map[string]map[string]string{
			"malia": {
				"neutral":  "characters/malia_neutral.png",
				"worried":  "characters/malia_worried.png",
				"smirking": "characters/malia_smirking.png",
			},
			"easton": {
				"hopeful": "characters/easton_hopeful.png",
				"hurt":    "characters/easton_hurt.png",
			},
		},
		music: map[string]string{
			"calm_morning": "music/calm_morning.mp3",
			"tense":        "music/tense.mp3",
		},
		sfx: map[string]string{
			"door_creak": "sfx/door_creak.mp3",
		},
		cg: map[string]string{
			"first_kiss": "cg/first_kiss.mp4",
		},
		minigames: map[string]string{
			"reaction_test": "minigames/reaction_test.json",
		},
	}
}

func (r *fixedResolver) ResolveBg(name string) (string, error) {
	return r.baseURL + "/" + r.bg[name], nil
}

func (r *fixedResolver) ResolveCharacter(char, pose string) (string, error) {
	return r.baseURL + "/" + r.characters[char][pose], nil
}

func (r *fixedResolver) ResolveMusic(name string) (string, error) {
	return r.baseURL + "/" + r.music[name], nil
}

func (r *fixedResolver) ResolveSfx(name string) (string, error) {
	return r.baseURL + "/" + r.sfx[name], nil
}

func (r *fixedResolver) ResolveCg(name string) (string, error) {
	return r.baseURL + "/" + r.cg[name], nil
}

func (r *fixedResolver) ResolveMinigame(name string) (string, error) {
	return r.baseURL + "/" + r.minigames[name], nil
}

// compileLS parses, validates and emits an LS source through the live
// pipeline. It is the inverse of Decompile and the test bedrock: the only
// way we know the decompiler produced legal source is to send it back
// through the same parser/emitter and compare the JSON byte-for-byte.
func compileLS(t *testing.T, source string) []byte {
	t.Helper()
	l := lexer.New(source)
	p := parser.New(l)
	ep, err := p.Parse()
	if err != nil {
		t.Fatalf("parse: %v\nsource:\n%s", err, source)
	}
	if errs := validator.Validate(ep); len(errs) > 0 {
		t.Fatalf("validate: %v\nsource:\n%s", errs[0], source)
	}
	out, err := emitter.New(newFixedResolver()).Emit(ep)
	if err != nil {
		t.Fatalf("emit: %v", err)
	}
	return out
}

// TestDecompileRoundTrip drives a representative LS source through the full
// loop: LS → JSON → LS' → JSON'. The two JSONs MUST be deep-equal. This is
// the strongest end-to-end guarantee for the decompiler — every step type,
// every condition kind, every gate leaf must round-trip without semantic loss.
func TestDecompileRoundTrip(t *testing.T) {
	source := `@episode main:01 "Round Trip" {
  @bg set classroom
  &music calm_morning
  &malia neutral

  NARRATOR: Senior year, day one.
  YOU: Same mess.
  MALIA: Hey.

  @malia bubble heart

  @phone {
    @text from EASTON: Can we talk?
    @text to EASTON: Not now.
  }

  @malia worried fade
  @music stop
  @sfx door_creak

  @cg first_kiss "Slow push-in on Malia's hand reaching for the doorknob."

  @minigame reaction_test "Tap as soon as the screen flashes — three rounds, faster wins."

  @trick hold "Hold your breath."

  @affection easton +2
  @signal mark EP01_DONE
  @signal int REJECTIONS = 0
  @signal int REJECTIONS +1
  &butterfly "Faced Easton without flinching."
  @achievement FACED_EASTON {
    name: "Eye Contact"
    rarity: uncommon
    description: "You let him come close."
  }

  @if (EP01_DONE) {
    NARRATOR: Flag held.
  } @else {
    NARRATOR: Flag missing.
  }

  @if (affection.easton >= 3) {
    NARRATOR: Affection high.
  }

  @if (MAX(affection.easton, affection.malia) > MIN(san, cha)) {
    NARRATOR: Aggregate compare.
  }

  @choice {
    @option A brave "Step forward." {
      check {
        attr: CHA
        dc: 12
      }
      @if (check.success) {
        EASTON: Thanks.
      } @else {
        EASTON: Forget it.
      }
    }
    @option B safe "Wait." {
      NARRATOR: She waited.
    }
  }

  @pause

  @gate {
    @if (A.fail):
      @next main/bad/001:01
    @else @if (affection.easton >= 2):
      @next main/route/001:01
    @else:
      @next main:02
  }
}
`

	original := compileLS(t, source)

	result, err := Decompile(original)
	if err != nil {
		t.Fatalf("decompile: %v", err)
	}
	if len(result.Episodes) != 1 {
		t.Fatalf("episodes: got %d, want 1", len(result.Episodes))
	}
	if !bytes.Contains(result.Episodes[0].Source, []byte("@episode main:01 \"Round Trip\"")) {
		t.Fatalf("decompiled source missing episode header:\n%s", result.Episodes[0].Source)
	}

	recompiled := compileLSWithMapping(t, result.Episodes[0].Source, result.Mapping)
	assertJSONEqual(t, original, recompiled)
}

// TestDecompileCharShowNoPosition guards the post-rewrite contract: the
// CharShowNode AST no longer carries a Position field. The decompiler must
// emit `@<char> <pose>` (with optional trailing transition) and NEVER inject
// an `at <position>` clause.
func TestDecompileCharShowNoPosition(t *testing.T) {
	source := `@episode main:01 "Char" {
  @bg set classroom
  @malia neutral
  @easton hopeful fade
  @gate {
    @next main:02
  }
}
`
	original := compileLS(t, source)
	result, err := Decompile(original)
	if err != nil {
		t.Fatalf("decompile: %v", err)
	}
	src := string(result.Episodes[0].Source)
	if !bytes.Contains([]byte(src), []byte("@malia neutral")) {
		t.Fatalf("missing @malia neutral line:\n%s", src)
	}
	if !bytes.Contains([]byte(src), []byte("@easton hopeful fade")) {
		t.Fatalf("missing @easton hopeful fade line:\n%s", src)
	}
	if bytes.Contains([]byte(src), []byte(" at ")) {
		t.Fatalf("decompiled source still contains ' at ' position clause:\n%s", src)
	}
}

// TestDecompileBubble checks the `bubble` step recovery — emitter type tag
// changed from "char_bubble" to "bubble" and the surface form is the
// dedicated `@<char> bubble <type>` directive.
func TestDecompileBubble(t *testing.T) {
	source := `@episode main:01 "Bubble" {
  @malia neutral
  @malia bubble heart
  &easton bubble exclaim
  @gate {
    @next main:02
  }
}
`
	original := compileLS(t, source)
	result, err := Decompile(original)
	if err != nil {
		t.Fatalf("decompile: %v", err)
	}
	src := string(result.Episodes[0].Source)
	if !bytes.Contains([]byte(src), []byte("@malia bubble heart")) {
		t.Fatalf("missing @malia bubble heart:\n%s", src)
	}
	if !bytes.Contains([]byte(src), []byte("&easton bubble exclaim")) {
		t.Fatalf("missing &easton bubble exclaim:\n%s", src)
	}
}

// TestDecompileMusicAndStop covers the MusicSetNode → "music" rename plus
// the new MusicStopNode → "music_stop" step. Both must recover via the
// `@music <name>` / `@music stop` surface form, never the old `play`/
// `crossfade`/`fadeout` verbs.
func TestDecompileMusicAndStop(t *testing.T) {
	source := `@episode main:01 "Music" {
  @bg set classroom
  @music calm_morning
  @music tense
  @music stop
  @gate {
    @next main:02
  }
}
`
	original := compileLS(t, source)
	result, err := Decompile(original)
	if err != nil {
		t.Fatalf("decompile: %v", err)
	}
	src := string(result.Episodes[0].Source)
	if !bytes.Contains([]byte(src), []byte("@music calm_morning")) {
		t.Fatalf("missing @music calm_morning:\n%s", src)
	}
	if !bytes.Contains([]byte(src), []byte("@music tense")) {
		t.Fatalf("missing @music tense:\n%s", src)
	}
	if !bytes.Contains([]byte(src), []byte("@music stop")) {
		t.Fatalf("missing @music stop:\n%s", src)
	}
	// Old verbs must not appear.
	for _, banned := range []string{"play ", "crossfade", "fadeout"} {
		if bytes.Contains([]byte(src), []byte(banned)) {
			t.Fatalf("decompiled source contains banned legacy verb %q:\n%s", banned, src)
		}
	}
}

// TestDecompileSfx checks the SfxNode → "sfx" rename. Same shape as music:
// `@sfx <name>`, no `play` verb.
func TestDecompileSfx(t *testing.T) {
	source := `@episode main:01 "Sfx" {
  @sfx door_creak
  @gate {
    @next main:02
  }
}
`
	original := compileLS(t, source)
	result, err := Decompile(original)
	if err != nil {
		t.Fatalf("decompile: %v", err)
	}
	src := string(result.Episodes[0].Source)
	if !bytes.Contains([]byte(src), []byte("@sfx door_creak")) {
		t.Fatalf("missing @sfx door_creak:\n%s", src)
	}
	if bytes.Contains([]byte(src), []byte("@sfx play")) {
		t.Fatalf("decompiled source still uses legacy '@sfx play':\n%s", src)
	}
}

// TestDecompileCgLeaf documents that CG is now a leaf step — the emitted
// JSON only carries name + content, and the decompiler must render the
// single-line `@cg <name> "<content>"` directive (no body, no `cg show`
// keyword, no duration).
func TestDecompileCgLeaf(t *testing.T) {
	source := `@episode main:01 "CG" {
  @cg first_kiss "Slow push-in as she leans forward; held one beat on her eyes."
  @gate {
    @next main:02
  }
}
`
	original := compileLS(t, source)
	result, err := Decompile(original)
	if err != nil {
		t.Fatalf("decompile: %v", err)
	}
	src := string(result.Episodes[0].Source)
	want := `@cg first_kiss "Slow push-in as she leans forward; held one beat on her eyes."`
	if !bytes.Contains([]byte(src), []byte(want)) {
		t.Fatalf("missing CG leaf line %q:\n%s", want, src)
	}
	// CG no longer has a body — the line must NOT be followed by `{`.
	if bytes.Contains([]byte(src), []byte("@cg first_kiss {")) {
		t.Fatalf("decompiled CG still uses a block body:\n%s", src)
	}
}

// TestDecompileGateWithEndLeaves exercises the new gate shape — routes may
// terminate in `@end <type>` leaves and a single gate can freely mix `@next`
// and `@end`. We assert each surface form is recovered.
func TestDecompileGateWithEndLeaves(t *testing.T) {
	source := `@episode main:01 "Gate End" {
  @bg set classroom
  NARRATOR: setup
  @gate {
    @if (A.success):
      @next main:02
    @else @if (A.fail):
      @end bad_ending
    @else:
      @end complete
  }
}
`
	original := compileLS(t, source)
	result, err := Decompile(original)
	if err != nil {
		t.Fatalf("decompile: %v", err)
	}
	src := string(result.Episodes[0].Source)

	wantLines := []string{
		"@gate {",
		"@if (A.success):",
		"@next main:02",
		"@else @if (A.fail):",
		"@end bad_ending",
		"@else:",
		"@end complete",
	}
	for _, w := range wantLines {
		if !bytes.Contains([]byte(src), []byte(w)) {
			t.Fatalf("gate missing fragment %q:\n%s", w, src)
		}
	}
}

// TestDecompileGateSchemeBEnding covers the emitter's Scheme B lowering: a
// pure `@gate { @end TYPE }` becomes `gate: null` + `ending: {type: TYPE}`
// in JSON. The decompiler must reconstruct the source gate from the ending
// marker alone.
func TestDecompileGateSchemeBEnding(t *testing.T) {
	source := `@episode main:01 "Pure End" {
  NARRATOR: closing line
  @gate {
    @end to_be_continued
  }
}
`
	original := compileLS(t, source)

	// Sanity-check Scheme B fired in the emitter output.
	var raw map[string]interface{}
	if err := json.Unmarshal(original, &raw); err != nil {
		t.Fatalf("unmarshal original: %v", err)
	}
	if raw["gate"] != nil {
		t.Fatalf("expected gate:null after Scheme B lowering, got %v", raw["gate"])
	}
	if ending, ok := raw["ending"].(map[string]interface{}); !ok || ending["type"] != "to_be_continued" {
		t.Fatalf("expected ending.type=to_be_continued, got %v", raw["ending"])
	}

	result, err := Decompile(original)
	if err != nil {
		t.Fatalf("decompile: %v", err)
	}
	src := string(result.Episodes[0].Source)
	if !bytes.Contains([]byte(src), []byte("@end to_be_continued")) {
		t.Fatalf("decompiled source missing @end to_be_continued:\n%s", src)
	}

	recompiled := compileLSWithMapping(t, result.Episodes[0].Source, result.Mapping)
	assertJSONEqual(t, original, recompiled)
}

// TestDecompileComparisonOperandKinds locks down the five ComparisonOperand
// kinds the new AST defines:
//
//   - literal   : bare integer
//   - affection : affection.<char>
//   - value     : bare name (san / CHA / signal-int variable)
//   - max       : MAX(a, b, ...)
//   - min       : MIN(a, b, ...)
//
// We assemble a single episode whose @if conditions cover all five and
// verify every surface form appears in the decompiled source.
func TestDecompileComparisonOperandKinds(t *testing.T) {
	source := `@episode main:01 "Operands" {
  @bg set classroom
  @signal int REJECTIONS = 0

  @if (REJECTIONS >= 1) {
    NARRATOR: value-kind operand.
  }
  @if (affection.easton > 2) {
    NARRATOR: affection-kind operand.
  }
  @if (san <= 50) {
    NARRATOR: engine-managed value operand.
  }
  @if (MAX(affection.easton, affection.malia) >= 3) {
    NARRATOR: max aggregate operand.
  }
  @if (MIN(san, cha) < 80) {
    NARRATOR: min aggregate operand.
  }
  @if (10 > affection.easton) {
    NARRATOR: literal on the left side.
  }

  @gate {
    @next main:02
  }
}
`
	original := compileLS(t, source)
	result, err := Decompile(original)
	if err != nil {
		t.Fatalf("decompile: %v", err)
	}
	src := string(result.Episodes[0].Source)

	wantForms := []string{
		"REJECTIONS >= 1",                        // value
		"affection.easton > 2",                   // affection
		"san <= 50",                              // value (engine scalar)
		"MAX(affection.easton, affection.malia)", // max
		"MIN(san, cha)",                          // min
		"10 > affection.easton",                  // literal on left
	}
	for _, w := range wantForms {
		if !bytes.Contains([]byte(src), []byte(w)) {
			t.Fatalf("decompiled source missing operand form %q:\n%s", w, src)
		}
	}

	// And the whole thing must round-trip back to identical JSON.
	recompiled := compileLSWithMapping(t, result.Episodes[0].Source, result.Mapping)
	assertJSONEqual(t, original, recompiled)
}

// TestDecompileArrayNamesEpisodes feeds two episodes as a JSON array (the
// "all episodes in one file" wire format) and checks the decompiler:
//   - produces one file per episode
//   - names them uniquely
//   - merges every episode's assets into the same mapping output.
func TestDecompileArrayNamesEpisodes(t *testing.T) {
	ep1 := compileLS(t, `@episode main:01 "First" {
  @bg set classroom
  @malia neutral
  @gate {
    @next main:02
  }
}
`)
	ep2 := compileLS(t, `@episode main:02 "Second" {
  @bg set school_yard
  @easton hopeful
  @gate {
    @end complete
  }
}
`)

	input := append([]byte("["), ep1...)
	input = append(input, ',')
	input = append(input, ep2...)
	input = append(input, ']')

	result, err := Decompile(input)
	if err != nil {
		t.Fatalf("decompile: %v", err)
	}
	if got, want := len(result.Episodes), 2; got != want {
		t.Fatalf("episodes: got %d, want %d", got, want)
	}
	if result.Episodes[0].Name == result.Episodes[1].Name {
		t.Fatalf("episode names should be unique, got %q", result.Episodes[0].Name)
	}
	if !bytes.Contains(result.Mapping, []byte(`"characters"`)) {
		t.Fatalf("mapping missing character assets:\n%s", result.Mapping)
	}
	// Both characters should land in the merged mapping.
	if !bytes.Contains(result.Mapping, []byte(`"malia"`)) {
		t.Fatalf("mapping missing malia:\n%s", result.Mapping)
	}
	if !bytes.Contains(result.Mapping, []byte(`"easton"`)) {
		t.Fatalf("mapping missing easton:\n%s", result.Mapping)
	}
}

// compileLSWithMapping is the helper used by round-trip tests. It writes
// the recovered mapping JSON to a tempfile, loads it into the real
// resolver, then compiles the recovered LS source against it — proving
// the asset table the decompiler emitted is consistent with the source it
// emitted in the same pass. Going through resolver.LoadMapping (rather
// than reusing newFixedResolver) ensures the mapping JSON shape itself is
// part of the contract under test.
func compileLSWithMapping(t *testing.T, source, mappingJSON []byte) []byte {
	t.Helper()
	dir := t.TempDir()
	mappingPath := filepath.Join(dir, "assets_mapping.json")
	if err := os.WriteFile(mappingPath, mappingJSON, 0644); err != nil {
		t.Fatalf("write mapping: %v", err)
	}
	res, err := resolver.LoadMapping(mappingPath)
	if err != nil {
		t.Fatalf("load recovered mapping: %v\n%s", err, mappingJSON)
	}
	l := lexer.New(string(source))
	p := parser.New(l)
	ep, err := p.Parse()
	if err != nil {
		t.Fatalf("recompile parse: %v\nsource:\n%s", err, source)
	}
	if errs := validator.Validate(ep); len(errs) > 0 {
		t.Fatalf("recompile validate: %v\nsource:\n%s", errs[0], source)
	}
	out, err := emitter.New(res).Emit(ep)
	if err != nil {
		t.Fatalf("recompile emit: %v", err)
	}
	return out
}

// TestDecompileMappingShape sanity-checks the recovered mapping JSON for a
// representative episode. The mapping must split into the six asset
// categories and reproduce the source base URL.
func TestDecompileMappingShape(t *testing.T) {
	source := `@episode main:01 "Mapping" {
  @bg set classroom
  @malia neutral
  @music calm_morning
  @sfx door_creak
  @cg first_kiss "A quiet, lingering shot."
  @minigame reaction_test "Tap to react."
  @gate {
    @next main:02
  }
}
`
	original := compileLS(t, source)
	result, err := Decompile(original)
	if err != nil {
		t.Fatalf("decompile: %v", err)
	}
	if !bytes.Contains(result.Mapping, []byte(`"base_url": "https://oss.example.com/novel_test"`)) {
		t.Fatalf("mapping missing recovered base_url:\n%s", result.Mapping)
	}
	for _, key := range []string{`"bg"`, `"characters"`, `"music"`, `"sfx"`, `"cg"`, `"minigames"`} {
		if !bytes.Contains(result.Mapping, []byte(key)) {
			t.Fatalf("mapping missing %s segment:\n%s", key, result.Mapping)
		}
	}
}

// assertJSONEqual decodes two byte slices as JSON and demands deep equality.
// Used by round-trip tests so that whitespace / key-order differences from
// re-marshalling never produce false negatives.
func assertJSONEqual(t *testing.T, expected, actual []byte) {
	t.Helper()
	var expectedJSON interface{}
	if err := json.Unmarshal(expected, &expectedJSON); err != nil {
		t.Fatalf("unmarshal expected: %v", err)
	}
	var actualJSON interface{}
	if err := json.Unmarshal(actual, &actualJSON); err != nil {
		t.Fatalf("unmarshal actual: %v", err)
	}
	if !reflect.DeepEqual(expectedJSON, actualJSON) {
		expectedNorm, _ := json.MarshalIndent(expectedJSON, "", "  ")
		actualNorm, _ := json.MarshalIndent(actualJSON, "", "  ")
		t.Fatalf("json mismatch\nexpected:\n%s\nactual:\n%s", expectedNorm, actualNorm)
	}
}
