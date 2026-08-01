package emitter_test

import (
	"testing"
)

// TestGoldenEp01 is disabled until testdata/ep01.ls.md and testdata/ep01_output.json
// are migrated to the new AST + LS spec. The existing testdata files still
// use the old syntax (@... show ... at left, &music play, @phone hide,
// @malia hide, etc.) and the old output shape (positions on char_show,
// clicks on pause, music_play/sfx_play step types). Reviving this test
// requires a coordinated rewrite of both source and expected JSON.
func TestGoldenEp01(t *testing.T) {
	t.Skip("testdata not yet updated to new AST + LS spec")
}
