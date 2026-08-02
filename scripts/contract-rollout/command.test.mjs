import assert from "node:assert/strict";
import test from "node:test";

import * as commandModule from "./command.mjs";

const { createCommandRunner, parseJsonOutput } = commandModule;

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
