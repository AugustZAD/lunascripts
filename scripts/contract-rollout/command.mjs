import { execFileSync } from "node:child_process";

function redact(text, values = []) {
  let result = String(text ?? "");
  for (const value of values.filter(Boolean)) result = result.split(String(value)).join("[REDACTED]");
  return result;
}

export function createCommandRunner(defaults = {}) {
  const maxBuffer = defaults.maxBuffer ?? 16 * 1024 * 1024;
  return {
    capture(command, args, options = {}) {
      try {
        const output = execFileSync(command, args, {
          cwd: options.cwd,
          env: options.env ?? process.env,
          encoding: "utf8",
          maxBuffer,
          stdio: ["ignore", "pipe", "pipe"],
        });
        return options.trim === false ? output : output.trim();
      } catch (error) {
        const sensitive = options.sensitiveValues ?? [];
        const detail = redact(error?.stderr || error?.message || error, sensitive).trim();
        throw new Error(`${command} failed${detail ? `: ${detail}` : ""}`);
      }
    },
    run(command, args, options = {}) {
      try {
        execFileSync(command, args, {
          cwd: options.cwd,
          env: options.env ?? process.env,
          maxBuffer,
          stdio: options.stdio ?? "inherit",
        });
      } catch (error) {
        const sensitive = options.sensitiveValues ?? [];
        const detail = redact(error?.stderr || error?.message || error, sensitive).trim();
        throw new Error(`${command} failed${detail ? `: ${detail}` : ""}`);
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
