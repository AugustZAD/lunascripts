import { execFileSync } from "node:child_process";

export const TEST_COMMAND_TIMEOUT_MS = 10 * 60_000;

const CONSUMER_REPOSITORIES = new Set(["cdotlock/lunaverse-backend", "cdotlock/lunaverse-ide"]);

function denied(message) {
  throw new Error(`preparation-only command denied: ${message}`);
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function assertCommandAllowed(command, args = []) {
  const executable = String(command).split("/").at(-1);
  if (executable === "railway") denied("Railway commands are manual only");
  if (executable === "gh" && args[0] === "pr" && args[1] === "merge") denied("pull request merge is outside preparation");
  if (executable === "gh" && args[0] === "workflow" && args[1] === "run") {
    if (args[2] !== "lunascripts-contract-audit.yml" || optionValue(args, "--repo") !== "cdotlock/lunaverse-backend") {
      denied("only the fixed read-only Backend audit workflow may be dispatched");
    }
  }
  if (executable === "gh" && args[0] === "pr" && new Set(["create", "edit", "ready"]).has(args[1])) {
    if (!CONSUMER_REPOSITORIES.has(optionValue(args, "--repo"))) denied("only Backend or IDE consumer PR metadata may be written");
  }
  if (executable === "gh" && args[0] === "api") {
    const method = String(optionValue(args, "--method") ?? optionValue(args, "-X") ?? "GET").toUpperCase();
    if (method !== "GET") {
      const endpoint = args.find((arg) => /^repos\//.test(String(arg))) ?? "";
      const repository = "(?:cdotlock/lunascripts|cdotlock/lunaverse-backend|cdotlock/lunaverse-ide)";
      const createComment = method === "POST" && new RegExp(`^repos/${repository}/issues/\\d+/comments$`).test(endpoint);
      const updateComment = method === "PATCH" && new RegExp(`^repos/${repository}/issues/comments/\\d+$`).test(endpoint);
      if (!createComment && !updateComment) denied("GitHub API writes are limited to preparation report comments");
    }
  }
  if (executable === "git" && args[0] === "push") {
    if (args.some((arg) => arg === "-f" || String(arg).startsWith("--force"))) denied("force push is forbidden");
    const positional = args.slice(1).filter((arg, index, values) => {
      if (arg === "--set-upstream" || arg === "-u") return false;
      if (index > 0 && new Set(["--repo", "--push-option"]).has(values[index - 1])) return false;
      return !String(arg).startsWith("-");
    });
    const [remote, ...refs] = positional;
    if (remote !== "origin" || refs.length !== 1 || !refs[0].startsWith("contract-rollout/")) {
      denied("git push must target one explicit contract-rollout consumer branch on origin");
    }
    if (refs[0] === "main" || refs[0].startsWith("refs/tags/")) denied("main and tag pushes are forbidden");
  }
}

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
    return { category: "test", timeoutMs: TEST_COMMAND_TIMEOUT_MS };
  }
  return { category: "external-command", timeoutMs: 2 * 60_000 };
}

function failure(command, error, { category, timeoutMs, stage, sensitiveValues = [] }) {
  const operation = stage ? `${stage} [${category}]` : category;
  const timedOut = error?.code === "ETIMEDOUT";
  const signal = error?.signal ? `signal ${redact(error.signal, sensitiveValues)}` : "";
  const detail = redact(error?.stderr || error?.message || error, sensitiveValues).trim();
  const context = [signal, detail].filter(Boolean).join("; ");
  const reason = timedOut ? `timed out after ${timeoutMs} ms` : "failed";
  return new Error(`${operation} ${command} ${reason}${context ? `: ${context}` : ""}`);
}

export function createCommandRunner(defaults = {}) {
  const maxBuffer = defaults.maxBuffer ?? 16 * 1024 * 1024;
  return {
    capture(command, args, options = {}) {
      assertCommandAllowed(command, args);
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
      assertCommandAllowed(command, args);
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
