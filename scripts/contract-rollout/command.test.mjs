import assert from "node:assert/strict";
import test from "node:test";

import { createCommandRunner, parseJsonOutput } from "./command.mjs";

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
