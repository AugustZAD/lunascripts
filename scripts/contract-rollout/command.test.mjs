import assert from "node:assert/strict";
import test from "node:test";

import * as commandModule from "./command.mjs";

const { assertCommandAllowed, createCommandRunner, parseJsonOutput, TEST_COMMAND_TIMEOUT_MS } = commandModule;

test("exports one explicit validation timeout for updater and test commands", () => {
  assert.equal(TEST_COMMAND_TIMEOUT_MS, 10 * 60_000);
});

test("denylist blocks merge, deploy, force, tag, and main pushes before execution", () => {
  for (const [command, args] of [
    ["gh", ["pr", "merge", "2", "--repo", "cdotlock/lunascripts"]],
    ["railway", ["up"]],
    ["gh", ["workflow", "run", "deploy-railway.yml", "--repo", "cdotlock/lunascripts"]],
    ["git", ["push", "--force-with-lease", "origin", "contract-rollout/v2.0.0-aaaaaaaa"]],
    ["git", ["push", "origin", "main"]],
    ["git", ["push", "origin", "refs/tags/v2.0.0"]],
    ["gh", ["api", "--method", "PUT", "repos/cdotlock/lunascripts/pulls/2/merge"]],
    ["gh", ["api", "--method", "POST", "repos/cdotlock/lunascripts/actions/workflows/deploy.yml/dispatches"]],
  ]) {
    assert.throws(() => assertCommandAllowed(command, args), /denied|forbidden|preparation-only/i);
  }
});

test("allowlist permits only fixed audit dispatch and consumer branch or PR writes", () => {
  assert.doesNotThrow(() => assertCommandAllowed("gh", [
    "workflow", "run", "lunascripts-contract-audit.yml", "--repo", "cdotlock/lunaverse-backend", "--ref", "contract-rollout/v2.0.0-aaaaaaaa",
  ]));
  assert.doesNotThrow(() => assertCommandAllowed("git", ["push", "origin", "contract-rollout/v2.0.0-aaaaaaaa"]));
  assert.doesNotThrow(() => assertCommandAllowed("gh", ["pr", "edit", "128", "--repo", "cdotlock/lunaverse-backend", "--body", "manual"]));
  assert.doesNotThrow(() => assertCommandAllowed("gh", ["api", "--method", "POST", "repos/cdotlock/lunaverse-backend/issues/128/comments", "-f", "body=report"]));
  assert.throws(() => assertCommandAllowed("gh", ["pr", "edit", "2", "--repo", "cdotlock/lunascripts", "--body", "bad"]), /denied|forbidden|preparation-only/i);
});

test("a dynamically authorized adopted branch is exact and all adjacent push forms remain denied", () => {
  const authorization = {
    repository: "cdotlock/lunaverse-backend",
    branch: "codex/lunascripts-authority",
    expectedRemoteHeadSha: "a".repeat(40),
    headSha: "b".repeat(40),
  };
  assert.doesNotThrow(() => assertCommandAllowed(
    "git",
    ["push", "origin", authorization.branch],
    { pushAuthorization: authorization },
  ));
  for (const args of [
    ["push", "origin", "codex/other"],
    ["push", "origin", "main"],
    ["push", "origin", "master"],
    ["push", "origin", "refs/tags/v2.0.0"],
    ["push", "origin", ":codex/lunascripts-authority"],
    ["push", "--delete", "origin", "codex/lunascripts-authority"],
    ["push", "--force", "origin", "codex/lunascripts-authority"],
  ]) assert.throws(() => assertCommandAllowed("git", args, { pushAuthorization: authorization }), /denied|forbidden/i);
});

test("redacts explicitly sensitive values from command failures", () => {
  const runner = createCommandRunner();
  const secret = "railway-secret-value";
  assert.throws(
    () => runner.capture(
      process.execPath,
      ["-e", `process.stderr.write(${JSON.stringify(secret)}); process.exit(1)`],
      { sensitiveValues: [secret] },
    ),
    (error) => {
      assert.equal(error.message.includes(secret), false);
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    },
  );
});

test("rejects invalid JSON with a bounded diagnostic", () => {
  assert.throws(() => parseJsonOutput("not-json", "fixture"), /fixture returned invalid JSON/);
});

test("capture can preserve leading status bytes and trailing NUL delimiters", () => {
  const runner = createCommandRunner();
  const output = runner.capture(
    process.execPath,
    ["-e", "process.stdout.write(' M file name\\0')"],
    { trim: false },
  );
  assert.equal(output, " M file name\0");
});

test("assigns bounded command policies by external operation class", () => {
  assert.equal(typeof commandModule.commandPolicy, "function");
  assert.deepEqual(commandModule.commandPolicy("gh", ["api", "user"]), {
    category: "github-api",
    timeoutMs: 60_000,
  });
  assert.deepEqual(commandModule.commandPolicy("git", ["clone", "https://github.com/example/repo.git", "/tmp/repo"]), {
    category: "git-transfer",
    timeoutMs: 10 * 60_000,
  });
  assert.deepEqual(commandModule.commandPolicy("git", ["checkout", "feature"]), {
    category: "git-transfer",
    timeoutMs: 10 * 60_000,
  });
  assert.deepEqual(commandModule.commandPolicy("git", ["status", "--short"]), {
    category: "git-command",
    timeoutMs: 2 * 60_000,
  });
  assert.deepEqual(commandModule.commandPolicy("pnpm", ["install", "--frozen-lockfile"]), {
    category: "dependency-install",
    timeoutMs: 15 * 60_000,
  });
  assert.deepEqual(commandModule.commandPolicy("pnpm", ["vitest", "run"]), {
    category: "test",
    timeoutMs: 10 * 60_000,
  });
  assert.deepEqual(commandModule.commandPolicy("go", ["test", "./..."]), {
    category: "test",
    timeoutMs: 10 * 60_000,
  });
  assert.deepEqual(commandModule.commandPolicy("gh", ["run", "watch", "123"]), {
    category: "workflow-watch",
    timeoutMs: 45 * 60_000,
  });
});

test("capture terminates a hung child at its override timeout without leaking secrets", () => {
  const runner = createCommandRunner();
  const secret = "timeout-secret-value";
  const started = Date.now();
  assert.throws(
    () => runner.capture(
      process.execPath,
      ["-e", "setTimeout(() => process.exit(0), 300)", secret],
      { timeoutMs: 25, stage: "poll Backend checks", sensitiveValues: [secret] },
    ),
    (error) => {
      assert.ok(Date.now() - started < 1_000);
      assert.match(error.message, /poll Backend checks/);
      assert.match(error.message, /timed out after 25 ms/i);
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
});

test("capture reports an explicit SIGTERM as a redacted failure, not a timeout", () => {
  const runner = createCommandRunner();
  const secret = "sigterm-secret-value";
  assert.throws(
    () => runner.capture(
      process.execPath,
      ["-e", `process.stderr.write(${JSON.stringify(secret)}); process.kill(process.pid, "SIGTERM")`],
      { sensitiveValues: [secret] },
    ),
    (error) => {
      assert.match(error.message, /failed/i);
      assert.doesNotMatch(error.message, /timed out/i);
      assert.match(error.message, /SIGTERM/);
      assert.match(error.message, /\[REDACTED\]/);
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
});
