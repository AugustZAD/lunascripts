import { execFileSync } from "node:child_process";

function redact(text, values = []) {
  let result = String(text ?? "");
  for (const value of values.filter(Boolean)) result = result.split(String(value)).join("[REDACTED]");
  return result;
}

export function commandPolicy(command, args = []) {
  const executable = String(command).split("/").at(-1);
  if (executable === "gh" && args[0] === "run" && args[1] === "watch") {
    return { category: "workflow-watch", timeoutMs: 45 * 60_000 };
  }
  if (executable === "gh") return { category: "github-api", timeoutMs: 60_000 };
  if (executable === "git" && new Set(["clone", "fetch", "checkout"]).has(args[0])) {
    return { category: "git-transfer", timeoutMs: 10 * 60_000 };
  }
  if (executable === "git") return { category: "git-command", timeoutMs: 2 * 60_000 };
  if (executable === "pnpm" && args[0] === "install") {
    return { category: "dependency-install", timeoutMs: 15 * 60_000 };
  }
  if (
    (executable === "pnpm" && args[0] === "vitest")
    || (executable === "go" && args[0] === "test")
    || (executable === "node" && args[0] === "--test")
  ) {
    return { category: "test", timeoutMs: 10 * 60_000 };
  }
  return { category: "external-command", timeoutMs: 2 * 60_000 };
}

function failure(command, error, { category, timeoutMs, stage, sensitiveValues = [] }) {
  const operation = stage ? `${stage} [${category}]` : category;
  const timedOut = error?.code === "ETIMEDOUT" || (error?.status === null && error?.signal);
  const detail = redact(error?.stderr || error?.message || error, sensitiveValues).trim();
  const reason = timedOut ? `timed out after ${timeoutMs} ms` : "failed";
  return new Error(`${operation} ${command} ${reason}${detail ? `: ${detail}` : ""}`);
}

export function createCommandRunner(defaults = {}) {
  const maxBuffer = defaults.maxBuffer ?? 16 * 1024 * 1024;
  return {
    capture(command, args, options = {}) {
      const policy = commandPolicy(command, args);
      const timeoutMs = options.timeoutMs ?? policy.timeoutMs;
      try {
        const output = execFileSync(command, args, {
          cwd: options.cwd,
          env: options.env ?? process.env,
          encoding: "utf8",
          maxBuffer,
          timeout: timeoutMs,
          stdio: ["ignore", "pipe", "pipe"],
        });
        return options.trim === false ? output : output.trim();
      } catch (error) {
        throw failure(command, error, {
          category: policy.category,
          timeoutMs,
          stage: options.stage,
          sensitiveValues: options.sensitiveValues,
        });
      }
    },
    run(command, args, options = {}) {
      const policy = commandPolicy(command, args);
      const timeoutMs = options.timeoutMs ?? policy.timeoutMs;
      try {
        execFileSync(command, args, {
          cwd: options.cwd,
          env: options.env ?? process.env,
          maxBuffer,
          timeout: timeoutMs,
          stdio: options.stdio ?? "inherit",
        });
      } catch (error) {
        throw failure(command, error, {
          category: policy.category,
          timeoutMs,
          stage: options.stage,
          sensitiveValues: options.sensitiveValues,
        });
      }
    },
  };
}

export function parseJsonOutput(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`);
  }
}
