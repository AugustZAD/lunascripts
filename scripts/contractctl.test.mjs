import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { main } from "./contractctl.mjs";

const SHA = "a".repeat(40);

function io() {
  const stdout = [];
  const stderr = [];
  return {
    stdout,
    stderr,
    out: (line) => stdout.push(String(line)),
    err: (line) => stderr.push(String(line)),
  };
}

test("continue dry-run is mutation-free and does not require approval", async () => {
  const output = io();
  const calls = [];
  const record = {
    schemaVersion: 1,
    state: "awaiting_approval",
    upstream: { repository: "cdotlock/lunascripts", pullRequest: "https://github.com/cdotlock/lunascripts/pull/2", headSha: SHA, treeDigest: "sha256:" + "1".repeat(64) },
    contractVersion: "2.0.0",
    changeClass: "major",
    backend: { repository: "cdotlock/lunaverse-backend", pullRequest: "https://github.com/cdotlock/lunaverse-backend/pull/128", headSha: SHA },
    ide: { repository: "cdotlock/lunaverse-ide", pullRequest: "https://github.com/cdotlock/lunaverse-ide/pull/15", headSha: SHA },
    audit: { status: "passed", blockers: 0, repairRecommended: 34 },
  };
  const github = {
    readRolloutRecord: () => record,
    getPullRequest: (repo) => {
      calls.push(["read", repo]);
      return { headSha: SHA, state: "OPEN", checks: [{ status: "completed", conclusion: "success" }] };
    },
    mergePullRequest: () => calls.push(["mutate"]),
  };
  const code = await main(
    ["rollout", "continue", record.upstream.pullRequest, "--dry-run"],
    { github, io: output },
  );
  assert.equal(code, 0);
  assert.equal(calls.some(([kind]) => kind === "mutate"), false);
  assert.match(output.stdout.join("\n"), /No changes were made/);
});

test("continue refuses real execution without exact confirmation", async () => {
  const output = io();
  const record = {
    schemaVersion: 1,
    state: "awaiting_approval",
    upstream: { repository: "cdotlock/lunascripts", pullRequest: "https://github.com/cdotlock/lunascripts/pull/2", headSha: SHA, treeDigest: "sha256:" + "1".repeat(64) },
    contractVersion: "2.0.0",
    changeClass: "major",
    backend: { repository: "cdotlock/lunaverse-backend", pullRequest: "https://github.com/cdotlock/lunaverse-backend/pull/128", headSha: SHA },
    ide: { repository: "cdotlock/lunaverse-ide", pullRequest: "https://github.com/cdotlock/lunaverse-ide/pull/15", headSha: SHA },
    audit: { status: "passed", blockers: 0, repairRecommended: 0 },
  };
  const code = await main(
    ["rollout", "continue", "https://github.com/cdotlock/lunascripts/pull/2"],
    {
      github: {
        readRolloutRecord: () => record,
        getPullRequest: () => ({ headSha: SHA, state: "OPEN", checks: [{ status: "completed", conclusion: "success" }] }),
      },
      io: output,
    },
  );
  assert.equal(code, 2);
  assert.match(output.stderr.join("\n"), /APPROVE_CONTRACT_ROLLOUT/);
});

test("validate detects contract paths and reads the manifest", async () => {
  const root = mkdtempSync(join(tmpdir(), "contractctl-validate-"));
  mkdirSync(join(root, "contract"));
  writeFileSync(join(root, "contract/contract.json"), JSON.stringify({
    contract_version: "2.0.0",
    change_class: "major",
    valid_fixtures: "fixtures/valid",
    invalid_fixtures: "fixtures/invalid",
    rollout: {
      consumer_repositories: ["cdotlock/lunaverse-backend", "cdotlock/lunaverse-ide"],
      stored_content_policy: "audit_only",
    },
  }));
  writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n\n## 2.0.0\n");
  const output = io();
  const runner = {
    capture(command, args) {
      assert.equal(command, "git");
      assert.deepEqual(args.slice(0, 3), ["diff", "--name-only", "base"]);
      return "internal/parser/parser.go\n";
    },
  };
  const code = await main(
    ["rollout", "validate", "--base", "base", "--head", "head"],
    { root, runner, io: output },
  );
  assert.equal(code, 0);
  assert.match(output.stdout.join("\n"), /contract-impacting/);
});

test("prepare can import a verified read-only bootstrap audit without dispatching a workflow", async () => {
  const root = mkdtempSync(join(tmpdir(), "contractctl-audit-import-"));
  const report = join(root, "audit.json");
  writeFileSync(report, JSON.stringify({ readOnly: true, blockers: 0, repairRecommended: 7 }));
  const output = io();
  const record = {
    schemaVersion: 1, state: "preparing",
    upstream: { repository: "cdotlock/lunascripts", pullRequest: "https://github.com/cdotlock/lunascripts/pull/2", headSha: SHA, treeDigest: "sha256:" + "1".repeat(64) },
    contractVersion: "2.0.0", changeClass: "major",
    backend: { repository: "cdotlock/lunaverse-backend", pullRequest: "https://github.com/cdotlock/lunaverse-backend/pull/128", headSha: SHA },
    ide: { repository: "cdotlock/lunaverse-ide", pullRequest: "https://github.com/cdotlock/lunaverse-ide/pull/15", headSha: SHA },
    audit: { status: "pending", blockers: 0, repairRecommended: 0 },
  };
  let saved;
  const code = await main(
    ["rollout", "prepare", record.upstream.pullRequest, "--audit-report", report],
    {
      root,
      io: output,
      runner: {},
      github: { upsertRolloutComment: (_repo, _number, value) => { saved = value; } },
      prepareRollout: () => ({ branches: { backend: "backend", ide: "ide" }, record }),
    },
  );
  assert.equal(code, 0);
  assert.equal(saved.state, "awaiting_approval");
  assert.deepEqual(saved.audit, { status: "passed", blockers: 0, repairRecommended: 7 });
});
