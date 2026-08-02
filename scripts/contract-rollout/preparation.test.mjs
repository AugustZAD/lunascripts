import assert from "node:assert/strict";
import test from "node:test";

import { TEST_COMMAND_TIMEOUT_MS } from "./command.mjs";
import { changedFiles, CONSUMERS, executeConsumerUpdater, publishConsumerBranch, rolloutBranch } from "./preparation.mjs";

const SHA = "a".repeat(40);

test("uses a deterministic consumer branch", () => {
  assert.equal(rolloutBranch("2.0.0", SHA), "contract-rollout/v2.0.0-aaaaaaaa");
});

test("IDE updater receives the real validation timeout and exact pin", () => {
  const calls = [];
  const runner = { capture: (...args) => { calls.push(args); return "{}"; } };
  const ide = CONSUMERS.find((consumer) => consumer.key === "ide");
  executeConsumerUpdater(runner, ide, "/tmp/ide", SHA);
  assert.deepEqual(calls, [["node", ["scripts/update-vendor.mjs", "lunascripts", "--ref", SHA, "--json"], {
    cwd: "/tmp/ide", timeoutMs: TEST_COMMAND_TIMEOUT_MS, stage: "update ide contract pin",
  }]]);
});

test("Backend preparation allowlist excludes production release workflow", () => {
  const backend = CONSUMERS.find((consumer) => consumer.key === "backend");
  assert.equal(backend.allowed.includes(".github/workflows/railway-shared-persistence-env-deploy.yml"), false);
});

test("changed files preserve NUL-safe rename source paths", () => {
  const runner = { capture: () => `R  new name\0old name\0 M plain\0` };
  assert.deepEqual(changedFiles(runner, "/tmp/repo"), ["new name", "old name", "plain"]);
});

function adoptedPullRequest(overrides = {}) {
  return {
    number: 128,
    state: "OPEN",
    baseBranch: "main",
    headBranch: "codex/lunascripts-authority",
    headSha: "a".repeat(40),
    ...overrides,
  };
}

test("an unchanged adopted consumer verifies its exact remote head and performs zero push", () => {
  const calls = [];
  const existing = adoptedPullRequest();
  const github = { getPullRequest: () => existing };
  const runner = {
    authorizePushBranch: (...args) => calls.push(["authorize", ...args]),
    capture: (...args) => calls.push(["capture", ...args]),
  };
  publishConsumerBranch({
    runner, github, consumer: { repository: "cdotlock/lunaverse-backend" }, existing,
    branch: existing.headBranch, cwd: "/tmp/backend", startingHeadSha: existing.headSha,
    headSha: existing.headSha, changed: false,
  });
  assert.deepEqual(calls, []);
});

test("a changed adopted consumer authorizes only its verified exact branch and head before push", () => {
  const calls = [];
  const existing = adoptedPullRequest();
  const github = { getPullRequest: () => existing };
  const runner = {
    authorizePushBranch: (value) => calls.push(["authorize", value]),
    capture: (...args) => calls.push(["capture", ...args]),
  };
  const headSha = "b".repeat(40);
  publishConsumerBranch({
    runner, github, consumer: { repository: "cdotlock/lunaverse-backend" }, existing,
    branch: existing.headBranch, cwd: "/tmp/backend", startingHeadSha: existing.headSha,
    headSha, changed: true,
  });
  assert.deepEqual(calls, [
    ["authorize", { cwd: "/tmp/backend", repository: "cdotlock/lunaverse-backend", branch: existing.headBranch, expectedRemoteHeadSha: existing.headSha, headSha }],
    ["capture", "git", ["push", "origin", existing.headBranch], { cwd: "/tmp/backend", stage: "push verified adopted consumer branch" }],
  ]);
});

test("an adopted-branch head race fails before authorization or push", () => {
  const calls = [];
  const existing = adoptedPullRequest();
  const github = { getPullRequest: () => adoptedPullRequest({ headSha: "c".repeat(40) }) };
  const runner = {
    authorizePushBranch: (...args) => calls.push(["authorize", ...args]),
    capture: (...args) => calls.push(["capture", ...args]),
  };
  assert.throws(() => publishConsumerBranch({
    runner, github, consumer: { repository: "cdotlock/lunaverse-backend" }, existing,
    branch: existing.headBranch, cwd: "/tmp/backend", startingHeadSha: existing.headSha,
    headSha: "b".repeat(40), changed: true,
  }), /changed before consumer branch publication/i);
  assert.deepEqual(calls, []);
});
