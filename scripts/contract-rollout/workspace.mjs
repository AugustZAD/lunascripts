import { execFileSync } from "node:child_process";
import { lstatSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const PREFIX = "lunascripts-rollout-";
const CLEANUP_TIMEOUT_MS = 30_000;
const created = new Set();

export function createRolloutWorkspace() {
  const path = mkdtempSync(join(realpathSync(tmpdir()), PREFIX));
  created.add(path);
  return path;
}

function assertSafeWorkspace(path) {
  if (typeof path !== "string" || !path || !isAbsolute(path)) throw new Error("refusing unsafe rollout workspace path");
  const exact = resolve(path);
  if (exact !== path || !created.has(exact)) throw new Error("refusing unregistered rollout workspace path");
  const temp = realpathSync(tmpdir());
  if (dirname(exact) !== temp || realpathSync(dirname(exact)) !== temp || !basename(exact).startsWith(PREFIX)) {
    throw new Error("refusing rollout workspace outside the exact temporary parent");
  }
  if (lstatSync(exact).isSymbolicLink()) throw new Error("unsafe rollout workspace symbolic link");
  return exact;
}

function nativeExecute(command, args, options) {
  return execFileSync(command, args, options);
}

export function cleanupRolloutWorkspace(path, options = {}) {
  const exact = assertSafeWorkspace(path);
  const execute = options.execute ?? nativeExecute;
  try {
    execute("/bin/rm", ["-rf", "--", exact], {
      timeout: CLEANUP_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    created.delete(exact);
  } catch (error) {
    const detail = error?.code === "ETIMEDOUT"
      ? `cleanup timed out after ${CLEANUP_TIMEOUT_MS} ms`
      : `cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
    if (options.primaryError) {
      options.primaryError.cleanupDiagnostic = detail;
      throw options.primaryError;
    }
    throw new Error(detail, { cause: error });
  }
}
