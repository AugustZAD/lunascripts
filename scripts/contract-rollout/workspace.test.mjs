import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cleanupRolloutWorkspace, createRolloutWorkspace } from "./workspace.mjs";

test("bounded native cleanup deletes only its own registered rollout workspace", () => {
  const workspace = createRolloutWorkspace();
  mkdirSync(join(workspace, "nested"));
  writeFileSync(join(workspace, "nested", "file"), "x");
  cleanupRolloutWorkspace(workspace);
  assert.equal(existsSync(workspace), false);
});

test("cleanup rejects empty, root, home, workspace, prefix spoof, and symlink escape", () => {
  const workspace = createRolloutWorkspace();
  for (const unsafe of ["", "/", homedir(), process.cwd(), join(tmpdir(), "lunascripts-rollout-spoof")]) {
    assert.throws(() => cleanupRolloutWorkspace(unsafe), /refus|registered|unsafe/i);
  }
  cleanupRolloutWorkspace(workspace);

  const link = createRolloutWorkspace();
  const target = mkdtempSync(join(tmpdir(), "workspace-cleanup-target-"));
  rmSync(link, { recursive: true });
  symlinkSync(target, link);
  assert.throws(() => cleanupRolloutWorkspace(link), /symbolic link|unsafe/i);
  rmSync(link);
  rmSync(target, { recursive: true });
});

test("cleanup uses an explicit bounded native command", () => {
  const workspace = createRolloutWorkspace();
  const calls = [];
  cleanupRolloutWorkspace(workspace, {
    execute(command, args, options) {
      calls.push({ command, args, options });
      return "";
    },
  });
  assert.deepEqual(calls, [{
    command: "/bin/rm",
    args: ["-rf", "--", workspace],
    options: { timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] },
  }]);
  rmSync(workspace, { recursive: true });
});

test("cleanup failure preserves a primary error and fails a successful operation", () => {
  const primaryWorkspace = createRolloutWorkspace();
  const primary = new Error("updater failed first");
  assert.throws(() => cleanupRolloutWorkspace(primaryWorkspace, {
    primaryError: primary,
    execute() { throw new Error("cleanup timed out"); },
  }), (error) => error === primary && /cleanup timed out/.test(error.cleanupDiagnostic));
  rmSync(primaryWorkspace, { recursive: true });

  const successWorkspace = createRolloutWorkspace();
  assert.throws(() => cleanupRolloutWorkspace(successWorkspace, {
    execute() { throw Object.assign(new Error("slow"), { code: "ETIMEDOUT" }); },
  }), /cleanup.*timed out/i);
  rmSync(successWorkspace, { recursive: true });
});
