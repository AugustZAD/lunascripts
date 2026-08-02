import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("controller exposes preparation only and has no execution state machine", () => {
  for (const file of ["./execution.mjs", "./execution.test.mjs", "./runtime.mjs", "./runtime.test.mjs", "./deploy-workflow.test.mjs"]) {
    assert.equal(existsSync(new URL(file, import.meta.url)), false, `${file} must be removed`);
  }
  const cli = read("../contractctl.mjs");
  for (const forbidden of ["continue", "resume", "approval", "confirm", "dry-run", "no-wait-audit"]) {
    assert.doesNotMatch(cli, new RegExp(`\\b${forbidden.replace("-", "[-]")}\\b`, "i"));
  }
  assert.match(cli, /consumers\s+<prepare\|sync>/);
});

test("GitHub client cannot merge pull requests or dispatch production workflows", () => {
  const source = read("./github.mjs");
  assert.doesNotMatch(source, /mergePullRequest|\[\s*["']pr["']\s*,\s*["']merge["']/);
  assert.doesNotMatch(source, /dispatchWorkflow|watchWorkflowRun|deploy|smoke/i);
});

test("post-merge workflow only synchronizes existing consumer pull requests", () => {
  const workflow = read("../../.github/workflows/contract-rollout.yml");
  assert.match(workflow, /consumers sync/);
  assert.doesNotMatch(workflow, /continue|resume|confirm|deploy|smoke|rollback/i);
});

test("manual upstream deploy workflow is disconnected from contract automation", () => {
  const workflow = read("../../.github/workflows/deploy-railway.yml");
  assert.match(workflow, /MANUAL ONLY/);
  assert.doesNotMatch(workflow, /contractctl|controller|rollback|recovery|push:/i);
});
