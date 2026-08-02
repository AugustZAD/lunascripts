import assert from "node:assert/strict";
import test from "node:test";

import { TEST_COMMAND_TIMEOUT_MS } from "./command.mjs";
import { changedFiles, CONSUMERS, executeConsumerUpdater, rolloutBranch } from "./preparation.mjs";

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
