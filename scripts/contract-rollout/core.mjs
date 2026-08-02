import { createHash } from "node:crypto";

const SHA_RE = /^[0-9a-f]{40}$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
export const UPSTREAM_REPOSITORY = "cdotlock/lunascripts";

const CONTRACT_FILES = new Set(["LS-SPEC.md", "CHANGELOG.md", "cmd/lsc/main.go"]);
const CONTRACT_PREFIXES = [
  "contract/", "internal/ast/", "internal/decompiler/", "internal/emitter/", "internal/lexer/",
  "internal/parser/", "internal/resolver/", "internal/token/", "internal/validator/",
  "skills/ls-scriptwriting/", "testdata/feature_parade/",
];

export function isContractImpactingPath(path) {
  const normalized = String(path).replace(/^\.\//, "");
  return CONTRACT_FILES.has(normalized) || CONTRACT_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function classifyContractChange(change = {}) {
  const any = (key) => Array.isArray(change[key]) && change[key].length > 0;
  if (change.semanticUncertainty === true || any("removed") || any("tightened") || any("addedRequired") || any("meaningChanged")) return "major";
  if (any("addedOptional") || any("addedSyntax")) return "minor";
  return "patch";
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function contentDigest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex")}`;
}

export function assertSha(value, label) {
  if (!SHA_RE.test(value ?? "")) throw new Error(`${label} must be a full lowercase Git SHA`);
}

export function assertUpstreamPullRequest(value) {
  if (value?.repository !== UPSTREAM_REPOSITORY || value?.baseBranch !== "main" ||
      !/^https:\/\/github\.com\/cdotlock\/lunascripts\/pull\/\d+$/.test(value?.pullRequest ?? "")) {
    throw new Error("upstream must be a cdotlock/lunascripts pull request targeting main");
  }
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

export function validatePreparationReport(report) {
  if (report?.schemaVersion !== 2 || report?.kind !== "consumer-preparation") throw new Error("preparation report schema is invalid");
  assertUpstreamPullRequest(report.upstream);
  assertSha(report.upstream.candidateHeadSha, "upstream candidateHeadSha");
  assertSha(report.upstream.pinSha, "upstream pinSha");
  if (!SEMVER_RE.test(report.contractVersion ?? "")) throw new Error("contractVersion must be semver");
  for (const key of ["backend", "ide"]) {
    const consumer = report.consumers?.[key];
    if (!consumer || !/^https:\/\/github\.com\/.+\/pull\/\d+$/.test(consumer.pullRequest ?? "") ||
        !String(consumer.branch ?? "").startsWith("contract-rollout/")) throw new Error(`${key} consumer report is invalid`);
    assertSha(consumer.headSha, `${key} headSha`);
  }
  if (!new Set(["pending", "passed", "blocked"]).has(report.audit?.status)) throw new Error("audit status is invalid");
  for (const key of ["blockers", "repairRecommendations", "findings"]) {
    if (!Array.isArray(report.audit[key])) throw new Error(`audit ${key} must be an array`);
  }
  if (report.audit.status !== "pending") {
    if (report.audit.readOnly !== true || report.audit.remediation !== "manual_review_only") throw new Error("completed audit must remain read-only and manual-only");
    if (!/^sha256:[0-9a-f]{64}$/.test(report.audit.findingsDigest ?? "")) throw new Error("completed audit findings digest is invalid");
  }
  return report;
}
