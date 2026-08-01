import { createHash } from "node:crypto";

const SHA_RE = /^[0-9a-f]{40}$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const PR_URL_RE = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/;

const CONTRACT_FILES = new Set([
  "LS-SPEC.md",
  "CHANGELOG.md",
  "cmd/lsc/main.go",
]);

const CONTRACT_PREFIXES = [
  "contract/",
  "internal/ast/",
  "internal/decompiler/",
  "internal/emitter/",
  "internal/lexer/",
  "internal/parser/",
  "internal/resolver/",
  "internal/token/",
  "internal/validator/",
  "skills/ls-scriptwriting/",
  "testdata/feature_parade/",
];

export const ROLLOUT_STATES = Object.freeze([
  "preparing",
  "needs_fix",
  "awaiting_approval",
  "executing",
  "production_verified",
  "complete",
  "rollout_blocked",
  "rolled_back",
]);

const TRANSITIONS = new Map([
  ["preparing:checks_passed", "awaiting_approval"],
  ["preparing:checks_failed", "needs_fix"],
  ["needs_fix:retry", "preparing"],
  ["awaiting_approval:approve", "executing"],
  ["executing:production_verified", "production_verified"],
  ["executing:pause", "rollout_blocked"],
  ["executing:traffic_failure", "rolled_back"],
  ["production_verified:ide_merged", "complete"],
  ["production_verified:pause", "rollout_blocked"],
  ["rollout_blocked:retry", "preparing"],
  ["rolled_back:retry", "preparing"],
]);

export function isContractImpactingPath(path) {
  const normalized = String(path).replace(/^\.\//, "");
  return CONTRACT_FILES.has(normalized) || CONTRACT_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function classifyContractChange(change = {}) {
  const any = (key) => Array.isArray(change[key]) && change[key].length > 0;
  if (
    change.semanticUncertainty === true ||
    any("removed") ||
    any("tightened") ||
    any("addedRequired") ||
    any("meaningChanged")
  ) {
    return "major";
  }
  if (any("addedOptional") || any("addedSyntax")) return "minor";
  return "patch";
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function approvalDigest(record) {
  const value = validateRolloutRecord(record);
  const material = {
    schemaVersion: value.schemaVersion,
    upstream: value.upstream,
    contractVersion: value.contractVersion,
    changeClass: value.changeClass,
    backend: value.backend,
    ide: value.ide,
    audit: value.audit,
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(material))).digest("hex")}`;
}

function assertSha(value, label) {
  if (!SHA_RE.test(value ?? "")) throw new Error(`${label} must be a 40-character lowercase Git SHA`);
}

function assertConsumer(value, label) {
  if (!value || typeof value !== "object") throw new Error(`${label} must be an object`);
  if (typeof value.repository !== "string" || !/^[^/]+\/[^/]+$/.test(value.repository)) {
    throw new Error(`${label}.repository must be owner/repository`);
  }
  if (!PR_URL_RE.test(value.pullRequest ?? "")) throw new Error(`${label}.pullRequest must be a GitHub PR URL`);
  assertSha(value.headSha, `${label}.headSha`);
}

export function validateRolloutRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("rollout record must be an object");
  if (record.schemaVersion !== 1) throw new Error("rollout schemaVersion must be 1");
  if (!ROLLOUT_STATES.includes(record.state)) throw new Error(`unknown rollout state: ${record.state}`);
  if (!SEMVER_RE.test(record.contractVersion ?? "")) throw new Error("contractVersion must be semver");
  if (!new Set(["patch", "minor", "major"]).has(record.changeClass)) {
    throw new Error("changeClass must be patch, minor, or major");
  }
  assertConsumer(record.upstream, "upstream");
  if (!/^sha256:[0-9a-f]{64}$/.test(record.upstream.treeDigest ?? "")) {
    throw new Error("upstream.treeDigest must be a sha256 digest");
  }
  assertConsumer(record.backend, "backend");
  assertConsumer(record.ide, "ide");
  if (!record.audit || typeof record.audit !== "object") throw new Error("audit must be an object");
  if (!new Set(["pending", "passed", "blocked", "unavailable"]).has(record.audit.status)) {
    throw new Error("audit.status is invalid");
  }
  for (const key of ["blockers", "repairRecommended"]) {
    if (!Number.isInteger(record.audit[key]) || record.audit[key] < 0) {
      throw new Error(`audit.${key} must be a non-negative integer`);
    }
  }
  return record;
}

export function nextRolloutState(current, event) {
  if (!ROLLOUT_STATES.includes(current)) throw new Error(`unknown rollout state: ${current}`);
  const next = TRANSITIONS.get(`${current}:${event}`);
  if (!next) throw new Error(`transition ${current} -> ${event} is not allowed`);
  return next;
}

export function compareSemverClass(previous, next) {
  if (!SEMVER_RE.test(previous) || !SEMVER_RE.test(next)) throw new Error("versions must be semver");
  const before = previous.split("-")[0].split(".").map(Number);
  const after = next.split("-")[0].split(".").map(Number);
  if (after[0] > before[0]) return "major";
  if (after[0] === before[0] && after[1] > before[1]) return "minor";
  if (after[0] === before[0] && after[1] === before[1] && after[2] > before[2]) return "patch";
  throw new Error(`contract version must increase: ${previous} -> ${next}`);
}
