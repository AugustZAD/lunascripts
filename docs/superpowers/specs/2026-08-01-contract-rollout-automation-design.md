# Lunaverse Script Contract Rollout Automation Design

**Status:** proposed

**Date:** 2026-08-01

**Authority:** `cdotlock/lunascripts` remains the only LS syntax and Episode JSON contract authority. Backend and IDE are consumers.

## 1. Goal

Turn an LS contract change initiated by any contributor's Agent into one resumable cross-repository rollout:

1. detect contract-impacting changes;
2. prepare and audit Backend and IDE consumer PRs;
3. present one consolidated report to the Agent's current operator;
4. after one explicit approval, merge and deploy in compatibility-safe order;
5. stop safely on failures and leave enough durable state for another Agent to resume.

The operator interacts with their Agent. They do not need to visit GitHub to approve the rollout. GitHub remains the execution and audit substrate for PRs, CI, and deployment workflows.

## 2. Confirmed product decisions

- The Agent that initiates the change owns the rollout and asks its current operator for approval.
- This is not tied to one Codex task, account, or conversation. Any Agent can resume from repository state.
- There is exactly one routine human approval, after all preparation and audits pass and immediately before the first production-changing action.
- The rollout automatically merges IDE source after Backend production verification, but does not immediately publish macOS or Windows installers. The IDE change enters the next regular dual-platform release.
- Contract-impacting paths trigger the rollout automatically. Unrelated Lunaverse Scripts changes do not.
- Stored production content is read-only during this workflow. The audit may recommend repairs or draft a script, but must never mutate R2, manifests, hashes, Supabase pointers, or databases.
- Existing operator credentials and repository permissions are used. No new per-person production secrets or special approver list is introduced.
- If the operator lacks a required permission, the rollout pauses and emits a precise handoff command for an authorized operator.
- Failures that have not changed production pause for human discussion. If a newly deployed Backend revision is already serving traffic and fails health checks, the workflow immediately restores the pre-rollout revision, then pauses for discussion.

## 3. Architecture

### 3.1 Agent-facing CLI

Lunaverse Scripts owns a small, idempotent orchestration CLI:

```text
contractctl rollout prepare <upstream-pr-url>
contractctl rollout status <upstream-pr-url>
contractctl rollout continue <upstream-pr-url> --confirm APPROVE_CONTRACT_ROLLOUT
contractctl rollout resume <upstream-pr-url>
```

`prepare` is read-only toward production. It may create or update branches, PRs, checks, and the rollout record.

`continue` performs privileged GitHub and deployment actions only after the Agent has received explicit approval from its current operator. The confirmation phrase is an Agent safety interlock, not a replacement for GitHub authentication: every action still runs as the currently authenticated GitHub actor and through existing protected deployment workflows.

`status` reconstructs the rollout from GitHub on every call. It must not depend on a local cache or chat history.

`resume` is an alias for `status` followed by the next safe, non-production preparation step. It never crosses the approval boundary by itself.

### 3.2 Durable rollout record

The upstream PR contains one bot-managed comment identified by a stable hidden marker. It contains a human summary plus a machine-readable JSON block with:

- rollout schema version and state;
- candidate tree digest and declared contract version;
- compatibility classification and evidence;
- upstream, Backend, and IDE PR URLs and exact head SHAs;
- consumer contract pins;
- CI conclusions and check URLs;
- read-only stored-content audit summary and artifact URL;
- approval digest and authenticated GitHub actor, once execution begins;
- merge SHAs, deployment ID, pre-rollout deployment ID, smoke result, and rollback result;
- blocking reason and the exact safe resume/handoff command.

The comment is a projection, not trusted input. `contractctl` re-queries GitHub checks, refs, merge state, and deployment health before every transition. A forged or stale comment cannot authorize a merge or deployment.

### 3.3 Repository responsibilities

**Lunaverse Scripts**

- owns `contractctl`, change classification, the contract manifest, compatibility declaration, and rollout state machine;
- detects changes to the parser, validator, emitter, canonical specs, Episode Schema, fixtures, or contract metadata;
- blocks a contract-impacting upstream PR from being considered rollout-ready until consumer PRs and audits exist.

**Backend**

- owns dual-read/backward-compatibility adapters, production content audit, release-health checks, exact-revision production deployment, smoke, and rollback;
- continues to consume one immutable canonical Lunaverse Scripts main commit;
- exposes a protected, read-only audit workflow and a protected exact-revision deployment workflow. Secrets remain in GitHub/Railway configuration and are never returned to the Agent.

**IDE**

- owns the exact complete upstream vendor pin, Agent guidance mirrors, compiler integration, and IDE-side tests;
- cannot merge the prepared consumer PR until Backend production health is verified for the same contract;
- does not trigger installer publication as part of contract rollout.

## 4. Trigger and classification

### 4.1 Trigger paths

The upstream PR workflow computes impact from the merge base. Changes to these classes are contract-impacting:

- canonical LS specifications and directive tables;
- lexer, parser, resolver, validator, emitter, decompiler, or public compiler entrypoints;
- `contract/**`, compatibility notes, and valid/invalid fixtures;
- scriptwriting Skill material that defines LS syntax or output semantics.

Deployment-only configuration, internal implementation files proven not to affect compiler behavior, and unrelated documentation do not trigger consumer rollout.

If static path classification is uncertain, it chooses the safe result and requires rollout. A repository test locks the trigger list to the actual authority files so a new syntax location cannot silently escape detection.

### 4.2 Semantic version classification

Every change declares `patch`, `minor`, or `major` in the contract changelog/manifest:

- `patch`: no accepted source, emitted JSON, or runtime meaning changes;
- `minor`: additive behavior that old consumers can safely ignore or continue to process;
- `major`: removal, rename, meaning change, new required data, validation tightening, or any change old consumers cannot safely process.

Automation calculates a lower bound from JSON Schema diff, fixture behavior, compiler golden output, and accepted/rejected source samples. It rejects a declaration below that lower bound. Parser or semantic changes that cannot be proven mechanically require an Agent-written compatibility explanation and reviewer fixtures; uncertainty is never silently classified as `patch`.

## 5. Preparation and audit

`prepare` operates against the exact upstream PR head tree and is repeatable.

1. Validate contract version, changelog, compatibility declaration, Schema, fixtures, and compiler tests.
2. Create or update one Backend consumer branch/PR and one IDE consumer branch/PR. Re-running updates the existing PRs instead of creating duplicates.
3. Pin both consumers to the same upstream candidate SHA for pre-merge testing.
4. Run the cross-version matrix:
   - old content on new Backend;
   - new content on new Backend;
   - old IDE output on new Backend;
   - new IDE output on new Backend;
   - canonical upstream compiler fixture on Backend runtime validation.
5. Verify the IDE's entire vendored upstream tree and active specification mirrors.
6. Run the Backend read-only production audit against R2 episode JSON, release manifests, content hashes, and Supabase pointers.
7. Publish one consolidated result in the upstream rollout comment.

The stored-content report lists affected novels/episodes, exact JSON paths, severity, recommended repair, and a reviewable repair-script draft when deterministic. The script is evidence only and is never executed by this workflow.

Affected legacy content is not automatically a blocker when the prepared Backend proves dual-read compatibility. It is a blocker when the proposed Backend would make currently readable production content unreadable or would change its meaning.

## 6. Approval contract

The Agent asks its current operator only when all preparation checks are green. The prompt must include:

- plain-language syntax/semantic change;
- declared and calculated version class;
- Backend and IDE PR summaries;
- stored-content impact counts and repair recommendation;
- exact production component to be deployed;
- rollback target availability;
- the immutable approval digest.

Approval applies to that digest, which covers all three candidate trees and the audit result. Any material change invalidates approval and returns to preparation. Mechanical replacement of the temporary upstream PR SHA with the canonical merged-main SHA does not require a second approval only when the Git tree digest is identical and all checks rerun successfully.

The Agent records the authenticated GitHub actor that performs the continuation. It does not copy conversation contents into GitHub.

## 7. Execution order

After approval, `continue` performs these transitions serially under a global single-rollout lock:

1. Revalidate approval digest, check conclusions, branch heads, mergeability, credentials, and rollback readiness.
2. Merge the upstream PR.
3. Resolve the canonical upstream `main` commit. Update Backend and IDE pins from the temporary PR head to that canonical commit, verify identical Git tree content, and rerun authority/consumer checks.
4. Wait for the existing Lunaverse Scripts Railway deployment and its health check. Stop before consumer merges if it fails.
5. Merge the Backend PR and resolve the exact Backend `main` commit.
6. Dispatch the protected Backend contract rollout deployment for that exact commit. Contract rollout refuses Backend PRs that also contain database migrations or unrelated infrastructure changes; those require the normal reviewed production path.
7. Capture the prior production deployment ID, wait for the new revision-bound deployment, and run public and direct-origin smoke checks covering health, an old unversioned episode, and a v2 contract episode.
8. If healthy, merge the IDE PR after one final pin/parity check.
9. Mark the rollout complete. The IDE source change waits for the next normal macOS/Windows release.

The Backend deployment adapter must resolve the current production target from the authoritative deployment topology at execution time. It must not hard-code a historical Railway environment or service ID in `contractctl`.

## 8. Failure and recovery

### 8.1 Before production traffic changes

Conflicts, failed tests, missing credentials, upstream deployment failure, Backend build failure, or a rejected deployment submission pause the rollout. The Agent explains the failure to its operator and waits. No automatic rollback or speculative repair is performed because the previous production revision remains active.

### 8.2 After the new Backend serves traffic

If revision identity, health, compatibility smoke, error rate, or public routing checks fail after traffic has reached the new Backend:

1. immediately restore the captured pre-rollout deployment through the existing immutable rollback mechanism;
2. verify production health and revision identity after rollback;
3. leave the IDE PR unmerged;
4. mark the rollout `rollout-blocked` with deployment and rollback evidence;
5. return to the Agent/operator for diagnosis.

No automatic Git revert is created. Source correction remains a reviewed follow-up.

### 8.3 Resume and handoff

All transitions are idempotent. A new Agent runs `contractctl rollout status <PR>` and receives the next allowed command. If its GitHub identity lacks an action, the status names the missing permission and produces a handoff command containing only PR identifiers and immutable SHAs, never credentials.

## 9. Concurrency and integrity

- Only one contract rollout may cross the approval boundary at a time. New candidate rollouts may prepare in parallel but queue before execution.
- Backend and IDE PR changes after approval invalidate the digest.
- Consumer PR CI always compares against immutable upstream content, not a branch name or latest tag.
- Privileged workflows check out only exact commits already reachable from their repository's protected `main` after merge.
- Pull-request workflows are read-only and receive no production secrets.
- Deployment workflow logs record actor, source rollout, exact revision, environment/service identity, deployment ID, and rollback ID without printing secrets.

## 10. User-visible states

The Agent reports one of these stable states in plain language:

- `preparing`: consumer PRs or audits still running;
- `needs_fix`: a non-production check failed;
- `awaiting_approval`: all checks green and the single operator decision is required;
- `executing`: approved merge/deploy sequence in progress;
- `production_verified`: Backend is healthy; IDE merge is pending;
- `complete`: Backend verified and IDE merged;
- `rollout_blocked`: execution stopped and needs discussion;
- `rolled_back`: production was restored and verified after a failed new deployment.

## 11. Tests and acceptance criteria

Implementation is acceptable only when automated tests prove:

- contract path detection includes all current syntax authority surfaces;
- patch/minor/major lower-bound classification catches required-field additions, removals, pattern tightening, and behavior fixture changes;
- `prepare`, `status`, `continue`, and resume are idempotent;
- duplicate consumer PRs are not created;
- changed SHAs invalidate approval;
- upstream squash/merge canonical SHA replacement preserves and verifies the approved tree digest;
- consumer pin mismatch blocks execution;
- old/new compatibility matrix gates Backend merge;
- stored audit is read-only under tests and production credentials;
- missing permissions stop with a resumable handoff;
- no production action occurs before confirmation;
- pre-traffic failure does not roll back a healthy old deployment;
- post-traffic smoke failure restores the captured deployment and prevents IDE merge;
- successful Backend verification permits IDE merge but does not dispatch IDE installer releases.

One end-to-end dry run must use test repositories or fixtures and a non-production Backend target. The first real rollout remains a deliberately observed production run even though only the single normal approval is required.

## 12. Out of scope

- Automatic mutation of stored scripts, R2 objects, hashes, manifests, pointers, or databases.
- Automatic macOS/Windows IDE publication.
- Bypassing repository, GitHub, Railway, or environment permissions.
- Combining unrelated Backend database or infrastructure rollout with a language-contract rollout.
- Automatically removing Backend legacy readers; removal requires a later audit showing no dependent stored content.
