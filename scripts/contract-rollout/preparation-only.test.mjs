import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  applyAuditReport,
  buildDiffEvidence,
  validateDiffEvidence,
  validatePreparationReport,
} from "./preparation.mjs";

const SHA = "a".repeat(40);
const BASE = "b".repeat(40);
const TREE = "c".repeat(40);
const OLD_BLOB = "d".repeat(40);
const NEW_BLOB = "e".repeat(40);
const PATCH = `diff --git a/vendor/lunascripts/revision.txt b/vendor/lunascripts/revision.txt\nindex ${OLD_BLOB}..${NEW_BLOB} 100644\n--- a/vendor/lunascripts/revision.txt\n+++ b/vendor/lunascripts/revision.txt\n@@ -1 +1 @@\n-old\n+new\n`;
const PATCH_DIGEST = `sha256:${createHash("sha256").update(PATCH).digest("hex")}`;
const canonicalize = (value) => Array.isArray(value)
  ? value.map(canonicalize)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
    : value;

function gitRunner(raw = `:100644 100644 ${OLD_BLOB} ${NEW_BLOB} M\0vendor/lunascripts/revision.txt\0`) {
  return {
    capture(command, args, options = {}) {
      assert.equal(command, "git");
      if (args[0] === "merge-base") return BASE;
      if (args[0] === "rev-parse" && args[1] === `${SHA}^{tree}`) return TREE;
      if (args[0] === "diff" && args.includes("--raw")) return raw;
      if (args[0] === "diff" && args.includes("--binary")) return PATCH;
      throw new Error(`unexpected git command: ${args.join(" ")}`);
    },
  };
}

test("full diff evidence binds merge-base, modes, types, blobs, tree, and binary patch", () => {
  const evidence = buildDiffEvidence({
    runner: gitRunner(), cwd: "/tmp/ide", baseSha: BASE, headSha: SHA,
    allowed: ["vendor/lunascripts"], expectedTreeSha: TREE, expectedPatchSha256: PATCH_DIGEST,
  });
  assert.deepEqual(evidence, {
    baseSha: BASE,
    headSha: SHA,
    mergeBaseSha: BASE,
    headTreeSha: TREE,
    expectedTreeSha: TREE,
    patchSha256: PATCH_DIGEST,
    expectedPatchSha256: PATCH_DIGEST,
    files: [{
      path: "vendor/lunascripts/revision.txt", status: "modified", previousPath: null,
      oldMode: "100644", newMode: "100644", oldType: "blob", newType: "blob",
      baseBlobSha: OLD_BLOB, headBlobSha: NEW_BLOB,
    }],
    digest: evidence.digest,
  });
  assert.match(evidence.digest, /^sha256:[0-9a-f]{64}$/);
  assert.doesNotThrow(() => validateDiffEvidence(evidence, ["vendor/lunascripts"]));
});

test("diff evidence fails closed on unsafe status, path, mode, type, regeneration, or divergence", () => {
  const cases = [
    [`:100644 000000 ${OLD_BLOB} ${"0".repeat(40)} D\0vendor/lunascripts/revision.txt\0`, /delete/i],
    [`:100644 100644 ${OLD_BLOB} ${NEW_BLOB} R100\0old\0vendor/lunascripts/revision.txt\0`, /rename/i],
    [`:100644 120000 ${OLD_BLOB} ${NEW_BLOB} M\0vendor/lunascripts/revision.txt\0`, /symlink|mode/i],
    [`:100644 160000 ${OLD_BLOB} ${NEW_BLOB} M\0vendor/lunascripts/revision.txt\0`, /submodule|mode/i],
    [`:100644 100644 ${OLD_BLOB} ${NEW_BLOB} M\0.github/workflows/deploy.yml\0`, /unapproved|path/i],
  ];
  for (const [raw, expected] of cases) {
    assert.throws(() => buildDiffEvidence({
      runner: gitRunner(raw), cwd: "/tmp/ide", baseSha: BASE, headSha: SHA,
      allowed: ["vendor/lunascripts"], expectedTreeSha: TREE, expectedPatchSha256: PATCH_DIGEST,
    }), expected);
  }
  assert.throws(() => buildDiffEvidence({
    runner: gitRunner(), cwd: "/tmp/ide", baseSha: BASE, headSha: SHA,
    allowed: ["vendor/lunascripts"], expectedTreeSha: "f".repeat(40), expectedPatchSha256: PATCH_DIGEST,
  }), /regenerated tree/i);
  assert.throws(() => buildDiffEvidence({
    runner: gitRunner(), cwd: "/tmp/ide", baseSha: BASE, headSha: SHA,
    allowed: ["vendor/lunascripts"], expectedTreeSha: TREE, expectedPatchSha256: `sha256:${"f".repeat(64)}`,
  }), /regenerated patch/i);
});

test("bound read-only audit keeps every sanitized finding and separate manual suggestions", () => {
  const report = {
    schemaVersion: 2, kind: "consumer-preparation",
    upstream: { repository: "cdotlock/lunascripts", pullRequest: "https://github.com/cdotlock/lunascripts/pull/2", baseBranch: "main", candidateHeadSha: SHA, pinSha: SHA },
    contractVersion: "2.0.0",
    consumers: {
      backend: { repository: "cdotlock/lunaverse-backend", pullRequest: "https://github.com/cdotlock/lunaverse-backend/pull/128", branch: "contract-rollout/v2.0.0-aaaaaaaa", headSha: SHA, diffEvidence: null },
      ide: { repository: "cdotlock/lunaverse-ide", pullRequest: "https://github.com/cdotlock/lunaverse-ide/pull/15", branch: "contract-rollout/v2.0.0-aaaaaaaa", headSha: SHA, diffEvidence: null },
    },
    audit: { status: "pending", blockers: [], repairRecommendations: [], findings: [] },
  };
  const raw = {
    ok: true, readOnly: true, episodeCount: 2, compatible: 0, blockers: 0, repairRecommended: 2,
    findings: [
      { novelId: "n1", episodeId: "e1", jsonUrl: "https://user:pass@example.test/a?token=secret", status: "legacy_repair_recommended", issues: [{ path: "ls_contract_version", message: "recompile and review" }] },
      { novelId: "n2", episodeId: "e2", status: "legacy_repair_recommended", issues: [{ path: "steps[0]", message: "manual review" }] },
    ],
  };
  const envelope = {
    schemaVersion: 1,
    provenance: { upstreamHeadSha: SHA, backendHeadSha: SHA, ideHeadSha: SHA, contractVersion: "2.0.0", source: { kind: "bootstrap", repository: "cdotlock/lunaverse-backend", revision: SHA, executable: "scripts/lunascripts-contract-audit.ts", sourceReportSha256: `sha256:${"1".repeat(64)}` } },
    payloadDigest: `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(raw))).digest("hex")}`,
    report: raw,
  };
  const audited = applyAuditReport(report, envelope);
  assert.equal(audited.audit.findings.length, 2);
  assert.equal(audited.audit.blockers.length, 0);
  assert.equal(audited.audit.repairRecommendations.length, 2);
  assert.equal(JSON.stringify(audited).includes("user:pass"), false);
  assert.equal(JSON.stringify(audited).includes("secret"), false);
  assert.match(audited.audit.findingsDigest, /^sha256:[0-9a-f]{64}$/);
  assert.doesNotThrow(() => validatePreparationReport(audited));
});
