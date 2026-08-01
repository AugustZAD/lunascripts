# Lunaverse Script Contract Rollout Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a resumable `contractctl rollout` chain that prepares and audits Lunaverse Scripts consumer PRs, asks the initiating Agent's operator once, and then safely sequences upstream merge, Backend deployment, smoke, and IDE merge.

**Architecture:** Lunaverse Scripts owns a standard-library Node.js orchestration CLI and state machine. Backend and IDE expose exact-ref update/audit adapters while GitHub remains the durable PR/check/deployment substrate; the upstream PR carries a reconstructable rollout record. Privileged continuation is confirmation-gated, exact-SHA bound, and never mutates stored content.

**Tech Stack:** Node.js 22 ESM and `node:test`, Git/GitHub CLI, Go contract tests, TypeScript/Vitest/Prisma for Backend read-only audit, GitHub Actions, existing Railway reviewed-app deployment workflow.

---

### Task 1: Stack the automation work on the approved v2 contract

**Files:**
- Move: `docs/superpowers/specs/2026-08-01-contract-rollout-automation-design.md`
- Create: `docs/superpowers/plans/2026-08-01-contract-rollout-automation.md`

- [ ] **Step 1: Rebase the local automation branch onto the v2 authority branch**

Run:

```bash
git rebase codex/contract-authority-v2
```

Expected: the design commit is replayed above the exact contract v2 implementation; no contract file is lost.

- [ ] **Step 2: Verify the stacked baseline**

Run:

```bash
go test ./...
git diff --check codex/contract-authority-v2...HEAD
```

Expected: all Go packages pass and the branch contains only the design/plan documents beyond v2.

- [ ] **Step 3: Commit this implementation plan**

```bash
git add docs/superpowers/plans/2026-08-01-contract-rollout-automation.md
git commit -m "docs: plan contract rollout automation"
```

### Task 2: Implement the upstream pure rollout contract

**Files:**
- Create: `scripts/contract-rollout/core.mjs`
- Create: `scripts/contract-rollout/core.test.mjs`
- Modify: `contract/contract.json`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Write failing trigger, version, digest, and state tests**

The tests must cover these exported interfaces:

```js
import {
  approvalDigest,
  classifyContractChange,
  isContractImpactingPath,
  nextRolloutState,
  validateRolloutRecord,
} from "./core.mjs";
```

Required assertions:

```js
assert.equal(isContractImpactingPath("internal/parser/parser.go"), true);
assert.equal(isContractImpactingPath("FASTAPI.md"), false);
assert.equal(classifyContractChange({ removed: ["signal"], addedOptional: [] }), "major");
assert.equal(classifyContractChange({ removed: [], addedOptional: ["bubble.color"] }), "minor");
assert.notEqual(approvalDigest(recordA), approvalDigest({ ...recordA, backendSha: OTHER_SHA }));
assert.equal(nextRolloutState("awaiting_approval", "approve"), "executing");
assert.throws(() => nextRolloutState("preparing", "deploy"));
```

- [ ] **Step 2: Run the tests and verify red**

Run:

```bash
node --test scripts/contract-rollout/core.test.mjs
```

Expected: FAIL because `core.mjs` does not exist.

- [ ] **Step 3: Implement deterministic pure functions**

`core.mjs` must:

- use a closed list of contract authority path prefixes;
- return a conservative semantic-version lower bound;
- canonicalize JSON object keys before SHA-256 digesting;
- validate 40-character SHAs, contract semver, PR URLs, and known states;
- expose only the allowed state transitions from the approved design;
- reject any transition that would cross `awaiting_approval` without `approve`.

- [ ] **Step 4: Add rollout metadata to the contract manifest**

Add machine-readable fields:

```json
{
  "change_class": "major",
  "rollout": {
    "consumer_repositories": [
      "cdotlock/lunaverse-backend",
      "cdotlock/lunaverse-ide"
    ],
    "stored_content_policy": "audit_only"
  }
}
```

Document that subsequent releases must update `change_class` and changelog evidence.

- [ ] **Step 5: Run green tests and commit**

Run:

```bash
node --test scripts/contract-rollout/core.test.mjs
go test ./...
```

Commit:

```bash
git add scripts/contract-rollout contract/contract.json CHANGELOG.md
git commit -m "feat(rollout): define contract rollout state machine"
```

### Task 3: Implement GitHub-backed status and approval records

**Files:**
- Create: `scripts/contract-rollout/command.mjs`
- Create: `scripts/contract-rollout/github.mjs`
- Create: `scripts/contract-rollout/github.test.mjs`
- Create: `scripts/contractctl.mjs`
- Create: `scripts/contractctl.test.mjs`

- [ ] **Step 1: Write failing tests with a fake command runner**

Test dependency injection rather than invoking real GitHub. Cover:

- finding and updating exactly one `<!-- lunaverse-contract-rollout:v1 -->` PR comment;
- reconstructing PR head SHA, merge SHA, checks, and permissions from `gh ... --json` output;
- redacting command environment and never including secret values in returned errors;
- `status` succeeding without local state;
- `continue` refusing without `--confirm APPROVE_CONTRACT_ROLLOUT`;
- changed consumer SHA invalidating an existing approval digest.

- [ ] **Step 2: Run the tests and verify red**

Run:

```bash
node --test scripts/contract-rollout/github.test.mjs scripts/contractctl.test.mjs
```

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement the GitHub adapter**

`command.mjs` provides `run(command, args, options)` and `captureJson(...)` with explicit argument arrays and bounded output. `github.mjs` provides:

```js
getPullRequest(repo, number)
listPullRequestChecks(repo, number)
upsertRolloutComment(repo, number, record)
getAuthenticatedActor()
mergePullRequest(repo, number, expectedHeadSha, method)
dispatchWorkflow(repo, workflow, ref, inputs)
findWorkflowRun(repo, workflow, createdAfter, expectedHeadSha)
```

Every mutating call takes an expected SHA and uses a read-after-write verification.

- [ ] **Step 4: Implement `validate` and `status` commands**

CLI behavior:

```text
node scripts/contractctl.mjs rollout validate --base <sha> --head <sha>
node scripts/contractctl.mjs rollout status <upstream-pr-url> [--json]
```

`validate` checks trigger paths, version declaration, manifest structure, changelog entry, and fixtures. `status` queries all three PRs/checks and renders a plain-language next action plus JSON when requested.

- [ ] **Step 5: Implement the approval interlock without production actions**

`continue` first performs all preflight checks and prints a deterministic execution plan. In `--dry-run` it must not call any mutating adapter. Without the exact confirmation phrase it exits non-zero before any mutation.

- [ ] **Step 6: Run green tests and commit**

Run:

```bash
node --test scripts/contract-rollout/*.test.mjs scripts/contractctl.test.mjs
```

Commit:

```bash
git add scripts/contract-rollout scripts/contractctl.mjs scripts/contractctl.test.mjs
git commit -m "feat(rollout): persist resumable GitHub rollout status"
```

### Task 4: Add exact-ref Backend consumer update and read-only audit

**Files:**
- Create: `scripts/update-lunascripts-contract.mjs`
- Create: `scripts/update-lunascripts-contract.test.mjs`
- Create: `scripts/lunascripts-contract-audit.ts`
- Create: `scripts/lunascripts-contract-audit.test.ts`
- Create: `.github/workflows/lunascripts-contract-audit.yml`
- Modify: `package.json`
- Modify: `AGENTS.md`

- [ ] **Step 1: Write failing exact-ref updater tests**

Test that the updater:

- requires `--ref` and refuses `HEAD`;
- resolves a full 40-character commit;
- archives only upstream `contract/`;
- replaces `contracts/lunascripts` and updates `contracts/lunascripts.lock.json` atomically;
- leaves all files unchanged when fetch, validation, or fixture tests fail.

Use a temporary local Git repository via `--repository <path>`; never depend on GitHub in unit tests.

- [ ] **Step 2: Implement and verify the Backend updater**

Run:

```bash
node --test scripts/update-lunascripts-contract.test.mjs
node scripts/update-lunascripts-contract.mjs --ref <UPSTREAM_SHA>
pnpm contract:lunascripts:check -- --online
```

- [ ] **Step 3: Write failing audit classifier tests**

Extract a pure classifier that returns:

```ts
type ContractAuditFinding = {
  novelId: string;
  episodeId: string;
  jsonUrl: string;
  contractVersion: string | null;
  status: "compatible" | "legacy_repair_recommended" | "blocking";
  issues: Array<{ path: string; message: string }>;
};
```

Tests prove v2 uppercase is compatible, unversioned lowercase is repair-recommended but readable, and malformed/unreadable content is blocking. Tests also freeze database dependencies to reads only.

- [ ] **Step 4: Implement the read-only audit command**

The command queries episode/release identity and URLs, downloads JSON without writing, validates with Backend dual-read plus v2 authority schemas, prints aggregate JSON to stdout, and optionally writes a report file for Actions artifact upload. It must not import any storage put/delete, Prisma mutation, or repair module.

- [ ] **Step 5: Add the protected audit workflow**

`lunascripts-contract-audit.yml` accepts exact upstream SHA, Backend PR SHA, and upstream PR URL; checks out the exact Backend SHA, installs dependencies/generates Prisma, runs tests, runs the read-only audit with existing protected read credentials, uploads the JSON report, and exposes no secret values. Pull-request workflows do not receive production credentials.

- [ ] **Step 6: Update Backend Agent rules and scripts**

Add:

```json
{
  "contract:lunascripts:update": "node scripts/update-lunascripts-contract.mjs",
  "contract:lunascripts:audit": "tsx scripts/lunascripts-contract-audit.ts"
}
```

Document that any Agent changing local LS rules must stop and run the upstream rollout; local rule edits without an exact upstream contract pin are forbidden.

- [ ] **Step 7: Verify and commit Backend**

Run:

```bash
pnpm vitest run scripts/update-lunascripts-contract.test.mjs scripts/lunascripts-contract-audit.test.ts scripts/check-lunascripts-authority.test.ts __tests__/core/schema-signal-int.test.ts app/services/release-content-health-service.test.ts
pnpm tsc --noEmit
pnpm contract:lunascripts:check -- --online
git diff --check
```

Commit:

```bash
git add scripts .github/workflows/lunascripts-contract-audit.yml package.json AGENTS.md contracts/lunascripts.lock.json contracts/lunascripts
git commit -m "feat(ls): add rollout update and read-only audit adapters"
```

### Task 5: Add IDE consumer preparation rules

**Files:**
- Modify: `scripts/update-vendor.mjs`
- Modify: `test/lunascripts-authority.test.mjs`
- Modify: `.github/workflows/lunascripts-authority.yml`
- Modify: `AGENTS.md`

- [ ] **Step 1: Extend failing updater contract tests**

Require `--repository` for local integration fixtures, atomic replacement on failure, machine-readable final output containing full SHA/version/tree digest, and refusal of mutable `HEAD`.

- [ ] **Step 2: Implement atomic exact-ref synchronization**

Archive into a temporary sibling directory, run vendored Go tests and mirror checks there, then rename into place only after all verification passes. Preserve existing CLI output for humans and add `--json` for `contractctl`.

- [ ] **Step 3: Add Agent ownership instructions**

Document:

- never edit vendored LS syntax/compiler/spec locally;
- when an Agent owns an upstream contract change, it must run `contractctl rollout prepare` and remain responsible through approval or produce a handoff command;
- Backend production and IDE installer release boundaries remain unchanged.

- [ ] **Step 4: Verify and commit IDE**

Run:

```bash
node --test test/lunascripts-authority.test.mjs test/agent-guidance-contract.test.mjs
pnpm contract:lunascripts:check -- --online
(cd vendor/lunascripts && go test ./...)
git diff --check
```

Commit:

```bash
git add scripts/update-vendor.mjs test/lunascripts-authority.test.mjs .github/workflows/lunascripts-authority.yml AGENTS.md
git commit -m "feat(ls): support agent-owned contract rollouts"
```

### Task 6: Implement consumer PR preparation

**Files:**
- Modify: `scripts/contract-rollout/github.mjs`
- Modify: `scripts/contractctl.mjs`
- Modify: `scripts/contractctl.test.mjs`

- [ ] **Step 1: Write failing prepare tests**

With fake GitHub/Git runners, prove `prepare`:

- creates deterministic branch names `contract-rollout/v<version>-<short-sha>`;
- updates existing matching PRs instead of duplicating them;
- calls the Backend and IDE exact-ref update scripts;
- records precise consumer SHAs and check URLs;
- stops with a non-secret handoff command when push/PR permission is missing;
- performs no production mutation.

- [ ] **Step 2: Implement temporary consumer workspaces**

Clone each consumer into a unique temporary directory. For a new rollout branch, start at `origin/main`; for an existing rollout PR, check out its current remote head and require a fast-forward relationship. Run its updater with the candidate SHA, run local contract tests, commit only owned files, and use a normal fast-forward push. Divergence or concurrent edits stop for discussion. The rollout never force-pushes any branch.

- [ ] **Step 3: Create/update consumer PRs and rollout comment**

PR descriptions include dependency order, exact upstream SHA/version, generated-file list, verification evidence, stored-audit state, and `do not merge manually` guidance. Re-query heads and checks after every update before writing the rollout record.

- [ ] **Step 4: Verify and commit upstream**

Run:

```bash
node --test scripts/contract-rollout/*.test.mjs scripts/contractctl.test.mjs
git diff --check
```

Commit:

```bash
git add scripts/contract-rollout scripts/contractctl.mjs scripts/contractctl.test.mjs
git commit -m "feat(rollout): prepare exact consumer pull requests"
```

### Task 7: Implement confirmed merge/deploy sequencing

**Files:**
- Create: `scripts/contract-rollout/execution.mjs`
- Create: `scripts/contract-rollout/execution.test.mjs`
- Modify: `scripts/contractctl.mjs`
- Modify: `.github/workflows/deploy-railway.yml`
- Modify in Backend: `.github/workflows/railway-shared-persistence-env-deploy.yml`
- Create in Backend: `scripts/lunascripts-rollout-workflow.test.ts`

- [ ] **Step 1: Write failing execution state-machine tests**

Fake every external action and prove exact order:

```text
revalidate -> merge upstream -> canonical pin refresh -> checks -> upstream health
-> merge Backend -> resolve stable ring -> dispatch exact revision -> watch -> smoke
-> merge IDE -> complete
```

Also prove:

- no action occurs without confirmation;
- material SHA/tree changes invalidate approval;
- pre-traffic failure pauses without rollback;
- post-traffic health failure invokes rollback before reporting blocked;
- IDE never merges when Backend production verification is absent;
- no IDE release workflow is dispatched.

- [ ] **Step 2: Make upstream deployment revision-verifiable**

Update the existing Lunaverse Scripts Railway workflow to capture the deployment ID, poll success, and check the deployed service health/revision. Do not change its existing main-push trigger or production target.

- [ ] **Step 3: Implement stable Backend ring resolution**

Read public production health revision, compare it with each reviewed ring's direct health response, and require exactly one matching healthy ring. Ambiguous or missing matches stop for operator discussion rather than guessing.

- [ ] **Step 4: Make the reviewed Backend deployment rollback-verifiable**

Before deployment, capture the exact active deployment ID and revision for the selected ring. Export both the prior and target deployment IDs in the workflow summary/artifact. On any health failure after the target deployment becomes active, redeploy that captured prior deployment with `usePreviousImageTag: true`, wait for success, and verify health/revision restoration. Add a source-level workflow contract test that fails if capture, target identity, or rollback verification is removed.

- [ ] **Step 5: Implement exact merge/deploy execution**

Use expected-head protected merges, canonical main SHAs, the hardened `railway-shared-persistence-env-deploy.yml` workflow with exact revision and resolved environment, run watching, public/direct health verification, and its captured prior-deployment rollback mechanism. `continue` refuses to dispatch unless the workflow contract test and preflight confirm a recoverable prior deployment.

- [ ] **Step 6: Verify and commit upstream and Backend workflow hardening**

Run:

```bash
node --test scripts/contract-rollout/*.test.mjs scripts/contractctl.test.mjs
go test ./...
git diff --check
```

Commit:

```bash
git add scripts/contract-rollout scripts/contractctl.mjs .github/workflows/deploy-railway.yml
git commit -m "feat(rollout): sequence confirmed contract deployments"
```

In Backend:

```bash
pnpm vitest run scripts/lunascripts-rollout-workflow.test.ts
git add .github/workflows/railway-shared-persistence-env-deploy.yml scripts/lunascripts-rollout-workflow.test.ts
git commit -m "feat(deploy): make contract rollout rollback verifiable"
```

### Task 8: Add repository enforcement and integration dry-run

**Files:**
- Create: `AGENTS.md` (Lunaverse Scripts)
- Create: `.github/workflows/contract-rollout.yml`
- Create: `scripts/contract-rollout/integration.test.mjs`
- Modify: Backend `.github/workflows/lunascripts-authority.yml`
- Modify: IDE `.github/workflows/lunascripts-authority.yml`

- [ ] **Step 1: Add cross-repository Agent protocol**

All three `AGENTS.md` files state that contract-impacting changes must use the rollout, the initiating Agent owns communication, one explicit approval is required before production, stored content is audit-only, and permission failure produces a handoff rather than credential copying.

- [ ] **Step 2: Add always-on authority/rollout checks**

The upstream workflow runs core/CLI tests and validates contract-impacting PR metadata. Consumer authority workflows run updater/audit unit tests in addition to exact upstream comparison. Workflows use `permissions: contents: read` unless a separately dispatched, trusted operation explicitly requires more.

- [ ] **Step 3: Run an offline three-repository integration dry-run**

Create temporary bare Git repositories and a fake `gh` executable. Exercise prepare, status, approval refusal, confirmed dry-run, interrupted resume, missing permission handoff, SHA invalidation, and audit artifact ingestion. Assert no deployment or stored-write command is invoked.

- [ ] **Step 4: Run complete non-production verification**

Upstream:

```bash
node --test scripts/contract-rollout/*.test.mjs scripts/contractctl.test.mjs
go test ./...
```

Backend:

```bash
pnpm vitest run scripts/update-lunascripts-contract.test.mjs scripts/lunascripts-contract-audit.test.ts scripts/check-lunascripts-authority.test.ts __tests__/core/schema-signal-int.test.ts app/services/release-content-health-service.test.ts
pnpm tsc --noEmit
pnpm contract:lunascripts:check -- --online
```

IDE:

```bash
node --test test/lunascripts-authority.test.mjs test/agent-guidance-contract.test.mjs
pnpm contract:lunascripts:check -- --online
(cd vendor/lunascripts && go test ./...)
```

- [ ] **Step 5: Prove production boundary remains closed**

Run only:

```bash
node scripts/contractctl.mjs rollout continue <fixture-pr> --dry-run
```

Expected: a deterministic plan with zero mutating GitHub, Railway, R2, Supabase, or IDE release calls. Do not run a real confirmed `continue` in this implementation session.

### Task 9: Sync canonical commits, update PRs, and hand off the first observed rollout

**Files:**
- Update generated consumer pins and vendored trees to the final upstream automation commit.
- Update the three PR descriptions with exact verification and rollout-order evidence.

- [ ] **Step 1: Commit and push each implementation branch**

Push normal feature branches only. Do not force `main`, merge Backend, or deploy production.

- [ ] **Step 2: Update/create separate automation PRs or stack on the existing authority PRs**

Use the least-conflicting route based on current merge state. Preserve Backend #127 as an independent R2 URL PR. Record explicit dependencies and exact SHA relationships.

- [ ] **Step 3: Verify GitHub CI**

Wait for upstream, Backend, and IDE authority/rollout checks. Any failure is fixed on the feature branch and rerun; checks are not bypassed.

- [ ] **Step 4: Hand off the first real rollout**

Report the exact command that an initiating Agent will use for the first observed `prepare`. The first real `continue` remains stopped at `awaiting_approval` and requires the agreed single operator approval before Backend merge/deployment.
