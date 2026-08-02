import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  ROLLOUT_STATES,
  approvalDigest,
  classifyContractChange,
  isContractImpactingPath,
  nextRolloutState,
  validateRolloutRecord,
} from "./core.mjs";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function diffEvidence(headSha, files) {
  const sorted = [...files].sort();
  const material = JSON.stringify({ baseBranch: "main", headSha, files: sorted });
  return { baseBranch: "main", files: sorted, digest: `sha256:${createHash("sha256").update(material).digest("hex")}` };
}

function record(overrides = {}) {
  return {
    schemaVersion: 1,
    state: "awaiting_approval",
    upstream: {
      repository: "cdotlock/lunascripts",
      pullRequest: "https://github.com/cdotlock/lunascripts/pull/2",
      baseBranch: "main",
      headSha: SHA_A,
      treeDigest: "sha256:" + "1".repeat(64),
    },
    contractVersion: "2.0.0",
    changeClass: "major",
    backend: {
      repository: "cdotlock/lunaverse-backend",
      pullRequest: "https://github.com/cdotlock/lunaverse-backend/pull/128",
      headSha: SHA_A,
      diffEvidence: diffEvidence(SHA_A, ["contracts/lunascripts.lock.json"]),
    },
    ide: {
      repository: "cdotlock/lunaverse-ide",
      pullRequest: "https://github.com/cdotlock/lunaverse-ide/pull/15",
      headSha: SHA_A,
      diffEvidence: diffEvidence(SHA_A, ["vendor/lunascripts/contract/contract.json"]),
    },
    audit: {
      status: "passed",
      blockers: 0,
      repairRecommended: 34,
      remediation: "manual_review_only",
      reportDigest: `sha256:${"2".repeat(64)}`,
      provenance: {
        upstreamHeadSha: SHA_A,
        backendHeadSha: SHA_A,
        ideHeadSha: SHA_A,
        contractVersion: "2.0.0",
        source: {
          kind: "bootstrap",
          repository: "cdotlock/lunaverse-backend",
          revision: SHA_A,
          executable: "scripts/lunascripts-contract-audit.ts",
          sourceReportSha256: `sha256:${"3".repeat(64)}`,
        },
      },
    },
    ...overrides,
  };
}

test("detects every current syntax authority surface conservatively", () => {
  for (const path of [
    "LS-SPEC.md",
    "contract/episode.schema.json",
    "internal/parser/parser.go",
    "internal/validator/validator.go",
    "internal/emitter/emitter.go",
    "skills/ls-scriptwriting/SKILL.md",
  ]) {
    assert.equal(isContractImpactingPath(path), true, path);
  }
  assert.equal(isContractImpactingPath("FASTAPI.md"), false);
  assert.equal(isContractImpactingPath(".github/workflows/deploy-railway.yml"), false);
});

test("calculates a conservative semantic-version lower bound", () => {
  assert.equal(classifyContractChange({ removed: ["signal"], addedOptional: [] }), "major");
  assert.equal(classifyContractChange({ tightened: ["signal.name.pattern"] }), "major");
  assert.equal(classifyContractChange({ addedRequired: ["episode.locale"] }), "major");
  assert.equal(classifyContractChange({ addedOptional: ["bubble.color"] }), "minor");
  assert.equal(classifyContractChange({ documentationOnly: true }), "patch");
  assert.equal(classifyContractChange({ semanticUncertainty: true }), "major");
});

test("approval digest is stable across key order but changes with material heads", () => {
  const first = record();
  const reordered = {
    ide: first.ide,
    audit: first.audit,
    backend: first.backend,
    changeClass: first.changeClass,
    contractVersion: first.contractVersion,
    upstream: first.upstream,
    state: first.state,
    schemaVersion: first.schemaVersion,
  };
  assert.equal(approvalDigest(first), approvalDigest(reordered));
  const changedAudit = {
    ...first.audit,
    provenance: {
      ...first.audit.provenance,
      backendHeadSha: SHA_B,
      source: { ...first.audit.provenance.source, revision: SHA_B },
    },
  };
  const changedBackend = {
    ...first.backend,
    headSha: SHA_B,
    diffEvidence: diffEvidence(SHA_B, first.backend.diffEvidence.files),
  };
  assert.notEqual(
    approvalDigest(first),
    approvalDigest({ ...first, backend: changedBackend, audit: changedAudit }),
  );
});

test("validates durable rollout records", () => {
  assert.deepEqual(validateRolloutRecord(record()), record());
  assert.throws(() => validateRolloutRecord({ ...record(), contractVersion: "v2" }), /semver/);
  assert.throws(
    () => validateRolloutRecord({ ...record(), backend: { ...record().backend, headSha: "main" } }),
    /40-character/,
  );
  assert.throws(() => validateRolloutRecord({ ...record(), state: "surprise" }), /state/);
  assert.throws(
    () => validateRolloutRecord({ ...record(), backend: { ...record().backend, diffEvidence: undefined } }),
    /diff evidence/,
  );
  assert.throws(
    () => validateRolloutRecord({ ...record(), audit: { status: "passed", blockers: 0, repairRecommended: 0 } }),
    /bound provenance/,
  );
});

test("rollout records bind upstream authority to the canonical main pull request", () => {
  assert.throws(
    () => validateRolloutRecord({ ...record(), upstream: { ...record().upstream, repository: "attacker/lunascripts" } }),
    /canonical upstream repository/,
  );
  assert.throws(
    () => validateRolloutRecord({ ...record(), upstream: { ...record().upstream, pullRequest: "https://github.com/attacker/lunascripts/pull/2" } }),
    /canonical upstream pull request URL/,
  );
  assert.throws(
    () => validateRolloutRecord({ ...record(), upstream: { ...record().upstream, baseBranch: "release" } }),
    /base.*main/i,
  );
});

test("allows only explicit state transitions", () => {
  assert.equal(nextRolloutState("preparing", "checks_passed"), "awaiting_approval");
  assert.equal(nextRolloutState("awaiting_approval", "approve"), "executing");
  assert.equal(nextRolloutState("executing", "production_verified"), "production_verified");
  assert.equal(nextRolloutState("production_verified", "ide_merged"), "complete");
  assert.equal(nextRolloutState("executing", "traffic_failure"), "rolled_back");
  assert.throws(() => nextRolloutState("preparing", "deploy"), /not allowed/);
  assert.throws(() => nextRolloutState("awaiting_approval", "deploy"), /not allowed/);
  assert.deepEqual(
    ROLLOUT_STATES,
    [
      "preparing",
      "needs_fix",
      "awaiting_approval",
      "executing",
      "production_verified",
      "complete",
      "rollout_blocked",
      "rolled_back",
    ],
  );
});
