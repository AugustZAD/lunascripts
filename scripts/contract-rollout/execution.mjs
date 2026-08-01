import { approvalDigest, validateRolloutRecord } from "./core.mjs";

const STAGES = Object.freeze([
  "approved",
  "upstream_merged",
  "consumers_repinned",
  "consumer_checks_green",
  "upstream_verified",
  "backend_merged",
  "stable_ring_resolved",
  "backend_deployed",
  "production_verified",
  "ide_merged",
]);

function stageIndex(stage) {
  const index = STAGES.indexOf(stage);
  if (index < 0) throw new Error(`unknown execution stage: ${stage}`);
  return index;
}

function atLeast(record, stage) {
  return record.execution && stageIndex(record.execution.stage) >= stageIndex(stage);
}

function withStage(record, stage, fields = {}) {
  return {
    ...record,
    execution: { ...record.execution, ...fields, stage, updatedAt: new Date().toISOString() },
  };
}

export function resolveStableRingFromHealth(publicHealth, ringHealth) {
  const revision = publicHealth?.data?.revision;
  if (!/^[0-9a-f]{40}$/.test(revision ?? "")) throw new Error("public production health has no exact revision");
  const matches = Object.entries(ringHealth).filter(([, health]) =>
    health?.data?.status === "healthy" &&
    health?.data?.queueConnectivity === "ok" &&
    health?.data?.revision === revision,
  );
  if (matches.length !== 1) throw new Error(`expected exactly one healthy reviewed ring for public revision ${revision}, found ${matches.length}`);
  return { environment: matches[0][0], revision };
}

export async function executeRollout({ record: input, confirmed, actions, persist = async () => {} }) {
  if (confirmed !== true) throw new Error("explicit operator confirmation is required");
  let record = validateRolloutRecord(structuredClone(input));
  if (!new Set(["awaiting_approval", "executing", "production_verified"]).has(record.state)) {
    throw new Error(`rollout cannot execute from ${record.state}`);
  }
  if (!record.execution) {
    record = {
      ...record,
      state: "executing",
      approval: { digest: approvalDigest(record), confirmedAt: new Date().toISOString() },
    };
    record = withStage(record, "approved");
    await persist(record);
  }

  const advance = async (stage, fields = {}) => {
    record = withStage(record, stage, fields);
    await persist(record);
  };

  try {
    if (!atLeast(record, "upstream_merged")) {
      const merged = await actions.mergeUpstream(record.upstream);
      await advance("upstream_merged", { upstreamMergeSha: merged.mergeSha });
    }
    if (!atLeast(record, "consumers_repinned")) {
      const consumers = await actions.refreshConsumerPins(record, record.execution.upstreamMergeSha);
      record = { ...record, backend: consumers.backend, ide: consumers.ide };
      await advance("consumers_repinned");
    }
    if (!atLeast(record, "consumer_checks_green")) {
      await actions.waitConsumerChecks(record.backend, record.ide);
      await advance("consumer_checks_green");
    }
    if (!atLeast(record, "upstream_verified")) {
      const upstreamDeployment = await actions.deployAndVerifyUpstream(record.execution.upstreamMergeSha);
      await advance("upstream_verified", { upstreamDeployment });
    }
    if (!atLeast(record, "backend_merged")) {
      const merged = await actions.mergeBackend(record.backend);
      await advance("backend_merged", { backendMergeSha: merged.mergeSha });
    }
    if (!atLeast(record, "stable_ring_resolved")) {
      const ring = await actions.resolveStableRing();
      await advance("stable_ring_resolved", { ring });
    }
    if (!atLeast(record, "backend_deployed")) {
      const deployment = await actions.deployBackend(record.execution.backendMergeSha, record.execution.ring);
      if (!deployment.ok) {
        const rolledBack = deployment.targetBecameActive && deployment.rollbackVerified;
        record = {
          ...withStage(record, "backend_deployed", { deployment }),
          state: rolledBack ? "rolled_back" : "rollout_blocked",
        };
        await persist(record);
        return record;
      }
      await advance("backend_deployed", { deployment });
    }
    if (!atLeast(record, "production_verified")) {
      await actions.verifyProduction(record.execution.backendMergeSha, record.execution.ring);
      record = { ...record, state: "production_verified" };
      await advance("production_verified");
    }
    if (!atLeast(record, "ide_merged")) {
      const merged = await actions.mergeIde(record.ide);
      record = { ...record, state: "complete" };
      await advance("ide_merged", { ideMergeSha: merged.mergeSha });
    }
    return record;
  } catch (error) {
    record = {
      ...record,
      state: "rollout_blocked",
      failure: { stage: record.execution?.stage ?? "approved", message: error instanceof Error ? error.message : String(error) },
    };
    await persist(record);
    return record;
  }
}
