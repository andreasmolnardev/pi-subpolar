import type {
  AdapterCapabilities,
  AdapterCapability,
  ApprovalClaimRepository,
  ApprovalContinuationRecord,
  ApprovalContinuationRepository,
  CanonicalTranscriptRecord,
  CanonicalTranscriptRole,
  CanonicalTranscriptRepository,
  CallIdempotencyRepository,
  EventReplayPort,
  JsonValue,
  OwnerRunRecord,
  PolicyRules,
  RunEvent,
  RunEventRepository,
  RunOutcome,
  RunRepository,
  RunStore,
  ToolDefinition,
  ToolDefinitionRecord,
  ToolDefinitionRepository,
  ToolPolicyRecord,
  ToolPolicyRepository,
} from "../../subpolar-contracts/src/index.ts";
export type {
  ApprovalClaim,
  ApprovalClaimRepository,
  ApprovalContinuationRecord,
  ApprovalContinuationRepository,
  CanonicalTranscriptEntry,
  CanonicalTranscriptRecord,
  CanonicalTranscriptRepository,
  CanonicalTranscriptRole,
  CallIdempotencyRepository,
  OpaqueContinuation,
  OwnerRunRecord,
  RunEventRepository,
  RunRepository,
  ToolDefinitionPatch,
  ToolDefinitionRecord,
  ToolDefinitionRepository,
  ToolPolicyInput,
  ToolPolicyRecord,
  ToolPolicyRepository,
} from "../../subpolar-contracts/src/index.ts";

import type {
  PocketBaseAtomicClaimPort,
  PocketBaseCollectionPort,
  PocketBaseConditionalUpdatePort,
  PocketBaseStoredRecord,
  PocketBaseTransactionPort,
} from "./index.ts";

export class PocketBaseCallAlreadyClaimedError extends Error {
  readonly code = "CALL_ID_IN_PROGRESS";

  constructor(ownerId: string, callId: string) {
    super(`Call ${callId} is already claimed for owner ${ownerId}`);
    this.name = "PocketBaseCallAlreadyClaimedError";
  }
}

export class PocketBaseCallFailedError extends Error {
  readonly code = "CALL_ID_FAILED";

  constructor(ownerId: string, callId: string, message = "The idempotent call previously failed") {
    super(`Call ${callId} previously failed for owner ${ownerId}: ${message}`);
    this.name = "PocketBaseCallFailedError";
  }
}

interface TargetPersistenceOptions {
  client: { collection(name: string): PocketBaseCollectionPort };
  collections?: Partial<Record<
    | "transcripts"
    | "runs"
    | "runEvents"
    | "tools"
    | "policies"
    | "continuations"
    | "callClaims", string | null>>;
  now: () => Date;
  transaction?: PocketBaseTransactionPort;
  idempotency?: { execute<T>(key: string, operation: () => Promise<T>): Promise<T> };
  conditionalUpdate?: PocketBaseConditionalUpdatePort;
  atomicClaim?: PocketBaseAtomicClaimPort;
  unsupported: (capability: AdapterCapability | string) => Error;
}

interface TargetPersistence {
  transcripts: CanonicalTranscriptRepository;
  runs: RunRepository;
  runEvents: RunEventRepository;
  tools: ToolDefinitionRepository;
  policies: ToolPolicyRepository;
  continuations: ApprovalContinuationRepository;
  claims: ApprovalClaimRepository;
  callIds: CallIdempotencyRepository;
  runStore(ownerId: string): RunStore;
  eventReplay(ownerId: string): EventReplayPort;
}

const sensitiveField = /(?:^|[_-])(access[_-]?token|api[_-]?key|authorization|bearer|client[_-]?secret|cookie|credential|password|private[_-]?key|secret|session[_-]?token|set-cookie|token)(?:$|[_-])/i;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} is required`);
  return value;
}

function safeJson(value: unknown, key?: string): JsonValue {
  if (key && sensitiveField.test(key)) return "[REDACTED]";
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => safeJson(item));
  if (value && typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [field, item] of Object.entries(value)) result[field] = safeJson(item, field);
    return result;
  }
  return `[${typeof value}]`;
}

function collection(options: TargetPersistenceOptions, name: keyof NonNullable<TargetPersistenceOptions["collections"]>): PocketBaseCollectionPort {
  const configured = options.collections?.[name];
  if (!configured) throw options.unsupported(`${name}.persistence`);
  return options.client.collection(configured);
}

function recordsFor(collection: PocketBaseCollectionPort, ownerId: string): Promise<PocketBaseStoredRecord[]> {
  return collection.list().then((records) => records.filter((record) => record.ownerId === ownerId).map(clone));
}

function optionalString(record: PocketBaseStoredRecord, field: string): string | undefined {
  const value = record[field];
  if (value === undefined || value === null) return undefined;
  return text(value, field);
}

function json(record: PocketBaseStoredRecord, field: string, fallback: JsonValue = null): JsonValue {
  return record[field] === undefined ? clone(fallback) : safeJson(record[field]);
}

function timestamp(value: unknown, field: string): string {
  const result = text(value, field);
  if (Number.isNaN(Date.parse(result))) throw new Error(`${field} must be an ISO timestamp`);
  return result;
}

function mapTranscript(record: PocketBaseStoredRecord): CanonicalTranscriptRecord {
  const role = text(record.role, "role");
  if (!["system", "user", "assistant", "tool"].includes(role)) throw new Error("Invalid canonical transcript role");
  const sequence = record.sequence;
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0) throw new Error("Invalid canonical transcript sequence");
  return {
    id: text(record.id, "recordId"),
    ownerId: text(record.ownerId, "ownerId"),
    sessionId: text(record.sessionId, "sessionId"),
    ...(optionalString(record, "messageId") === undefined ? {} : { messageId: optionalString(record, "messageId") }),
    ...(optionalString(record, "runId") === undefined ? {} : { runId: optionalString(record, "runId") }),
    sequence,
    role: role as CanonicalTranscriptRole,
    ...(record.content === undefined ? {} : { content: text(record.content, "content") }),
    ...(record.toolCall === undefined ? {} : { toolCall: json(record, "toolCall") }),
    ...(record.toolResult === undefined ? {} : { toolResult: json(record, "toolResult") }),
    ...(record.error === undefined ? {} : { error: json(record, "error") }),
    ...(record.usage === undefined ? {} : { usage: json(record, "usage") }),
    ...(record.metadata === undefined ? {} : { metadata: json(record, "metadata") }),
    occurredAt: timestamp(record.occurredAt, "occurredAt"),
  };
}

function mapRun(record: PocketBaseStoredRecord): OwnerRunRecord {
  const state = text(record.state, "state");
  if (!["completed", "failed", "interrupted", "unknown"].includes(state)) throw new Error("Invalid run state");
  return {
    id: text(record.id, "recordId"),
    ownerId: text(record.ownerId, "ownerId"),
    runId: text(record.runId, "runId"),
    requestId: text(record.requestId, "requestId"),
    ...(optionalString(record, "sessionId") === undefined ? {} : { sessionId: optionalString(record, "sessionId") }),
    state: state as RunOutcome["state"],
    ...(record.output === undefined ? {} : { output: json(record, "output") }),
    ...(record.error === undefined ? {} : { error: json(record, "error") as unknown as OwnerRunRecord["error"] }),
    recoverable: record.recoverable === true,
    occurredAt: timestamp(record.occurredAt, "occurredAt"),
  };
}

function mapTool(record: PocketBaseStoredRecord): ToolDefinitionRecord {
  const risk = text(record.risk, "risk");
  if (!["low", "medium", "high"].includes(risk)) throw new Error("Invalid tool risk");
  return {
    id: text(record.toolId, "toolId"),
    ownerId: text(record.ownerId, "ownerId"),
    namespace: text(record.namespace, "namespace"),
    description: text(record.description, "description"),
    inputSchema: json(record, "inputSchema"),
    enabled: record.enabled === true,
    risk: risk as ToolDefinition["risk"],
    ...(record.metadata === undefined ? {} : { metadata: json(record, "metadata", {}) as Record<string, string> }),
    createdAt: timestamp(record.createdAt, "createdAt"),
    updatedAt: timestamp(record.updatedAt, "updatedAt"),
  };
}

function mapPolicy(record: PocketBaseStoredRecord): ToolPolicyRecord {
  const version = record.version;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) throw new Error("Invalid tool policy version");
  return {
    id: text(record.policyId ?? record.id, "policyId"),
    ownerId: text(record.ownerId, "ownerId"),
    toolId: text(record.toolId, "toolId"),
    ...(optionalString(record, "agentId") === undefined ? {} : { agentId: optionalString(record, "agentId") }),
    ...(optionalString(record, "projectId") === undefined ? {} : { projectId: optionalString(record, "projectId") }),
    rules: json(record, "rules", {}) as PolicyRules,
    version,
    createdAt: timestamp(record.createdAt, "createdAt"),
    updatedAt: timestamp(record.updatedAt, "updatedAt"),
  };
}

function mapContinuation(record: PocketBaseStoredRecord): ApprovalContinuationRecord {
  return {
    id: text(record.id, "recordId"),
    ownerId: text(record.ownerId, "ownerId"),
    approvalId: text(record.approvalId, "approvalId"),
    callId: text(record.callId, "callId"),
    payload: text(record.opaquePayload, "opaquePayload"),
    ...(optionalString(record, "keyId") === undefined ? {} : { keyId: optionalString(record, "keyId") }),
    requestHash: text(record.requestHash, "requestHash"),
    expiresAt: timestamp(record.expiresAt, "expiresAt"),
    ...(optionalString(record, "claimedAt") === undefined ? {} : { claimedAt: optionalString(record, "claimedAt") }),
    ...(optionalString(record, "claimToken") === undefined ? {} : { claimToken: optionalString(record, "claimToken") }),
  };
}

export function createPocketBaseTargetPersistence(options: TargetPersistenceOptions): TargetPersistence {
  const transcriptCollection = () => collection(options, "transcripts");
  const runCollection = () => collection(options, "runs");
  const runEventCollection = () => collection(options, "runEvents");
  const toolCollection = () => collection(options, "tools");
  const policyCollection = () => collection(options, "policies");
  const continuationCollection = () => collection(options, "continuations");
  const callCollection = () => collection(options, "callClaims");

  const transcripts: CanonicalTranscriptRepository = {
    async append(ownerId, sessionId, entries, runId) {
      text(ownerId, "ownerId");
      text(sessionId, "sessionId");
      if (!Array.isArray(entries)) throw new Error("Canonical transcript entries must be an array");
      const records = await recordsFor(transcriptCollection(), ownerId);
      let sequence = records.filter((record) => record.sessionId === sessionId).reduce((max, record) => Math.max(max, typeof record.sequence === "number" ? record.sequence : -1), -1) + 1;
      const saved: CanonicalTranscriptRecord[] = [];
      for (const entry of entries) {
        if (!entry || !["system", "user", "assistant", "tool"].includes(entry.role)) throw new Error("Invalid canonical transcript role");
        timestamp(entry.occurredAt, "occurredAt");
        const data: Record<string, unknown> = {
          ownerId,
          sessionId,
          sequence: sequence++,
          role: entry.role,
          occurredAt: entry.occurredAt,
        };
        if (entry.messageId !== undefined) data.messageId = text(entry.messageId, "messageId");
        if (runId !== undefined) data.runId = text(runId, "runId");
        if (entry.content !== undefined) data.content = entry.content;
        if (entry.toolCall !== undefined) data.toolCall = safeJson(entry.toolCall);
        if (entry.toolResult !== undefined) data.toolResult = safeJson(entry.toolResult);
        if (entry.error !== undefined) data.error = safeJson(entry.error);
        if (entry.usage !== undefined) data.usage = safeJson(entry.usage);
        if (entry.metadata !== undefined) data.metadata = safeJson(entry.metadata);
        saved.push(mapTranscript(await transcriptCollection().create(data)));
      }
      return saved;
    },
    async list(ownerId, sessionId) {
      const records = (await recordsFor(transcriptCollection(), text(ownerId, "ownerId")))
        .filter((record) => record.sessionId === text(sessionId, "sessionId"))
        .map(mapTranscript)
        .sort((a, b) => a.sequence - b.sequence);
      return records;
    },
    async get(ownerId, sessionId, messageId) {
      return (await this.list(ownerId, sessionId)).find((record) => record.messageId === text(messageId, "messageId"));
    },
  };

  const runs: RunRepository = {
    async load(ownerId, runId) {
      const record = (await recordsFor(runCollection(), text(ownerId, "ownerId"))).find((item) => item.runId === text(runId, "runId"));
      return record ? mapRun(record) : undefined;
    },
    async list(ownerId) {
      return (await recordsFor(runCollection(), text(ownerId, "ownerId"))).map(mapRun);
    },
    async save(ownerId, outcome) {
      const scopedOwner = text(ownerId, "ownerId");
      const runId = text(outcome.runId, "runId");
      const records = runCollection();
      const existing = (await recordsFor(records, scopedOwner)).find((record) => record.runId === runId);
      const data: Record<string, unknown> = {
        ownerId: scopedOwner,
        runId,
        requestId: text(outcome.requestId, "requestId"),
        state: outcome.state,
        recoverable: outcome.recoverable === true,
        occurredAt: timestamp(outcome.occurredAt, "occurredAt"),
      };
      if (outcome.sessionId !== undefined) data.sessionId = text(outcome.sessionId, "sessionId");
      if (outcome.output !== undefined) data.output = safeJson(outcome.output);
      if (outcome.error !== undefined) data.error = safeJson(outcome.error);
      return mapRun(existing ? (await records.update(existing.id, data)) ?? { ...existing, ...data } as PocketBaseStoredRecord : await records.create(data));
    },
  };

  const runEvents: RunEventRepository = {
    async append(ownerId, event) {
      const data: Record<string, unknown> = {
        ownerId: text(ownerId, "ownerId"),
        eventId: text(event.eventId, "eventId"),
        runId: text(event.runId, "runId"),
        requestId: text(event.requestId, "requestId"),
        type: text(event.type, "type"),
        state: text(event.state, "state"),
        occurredAt: timestamp(event.occurredAt, "occurredAt"),
        data: safeJson(event.data),
      };
      if (event.sessionId !== undefined) data.sessionId = text(event.sessionId, "sessionId");
      await runEventCollection().create(data);
      return clone(event);
    },
    async replay(ownerId, runId) {
      return (await recordsFor(runEventCollection(), text(ownerId, "ownerId")))
        .filter((record) => record.runId === text(runId, "runId"))
        .sort((a, b) => String(a.occurredAt).localeCompare(String(b.occurredAt)))
        .map((record) => ({
          eventId: text(record.eventId, "eventId"),
          type: text(record.type, "type") as RunEvent["type"],
          occurredAt: timestamp(record.occurredAt, "occurredAt"),
          runId: text(record.runId, "runId"),
          requestId: text(record.requestId, "requestId"),
          ...(optionalString(record, "sessionId") === undefined ? {} : { sessionId: optionalString(record, "sessionId") }),
          state: text(record.state, "state") as RunEvent["state"],
          data: json(record, "data"),
        }));
    },
  };

  const tools: ToolDefinitionRepository = {
    async create(ownerId, definition) {
      const scopedOwner = text(ownerId, "ownerId");
      const id = text(definition.id, "toolId");
      const timestampValue = options.now().toISOString();
      const created = await toolCollection().create({
        ownerId: scopedOwner,
        toolId: id,
        namespace: text(definition.namespace, "namespace"),
        description: text(definition.description, "description"),
        inputSchema: safeJson(definition.inputSchema),
        enabled: definition.enabled === true,
        risk: definition.risk,
        ...(definition.metadata === undefined ? {} : { metadata: safeJson(definition.metadata) }),
        createdAt: timestampValue,
        updatedAt: timestampValue,
      });
      return mapTool(created);
    },
    async get(ownerId, toolId) {
      const record = (await recordsFor(toolCollection(), text(ownerId, "ownerId"))).find((item) => item.toolId === text(toolId, "toolId"));
      return record ? mapTool(record) : undefined;
    },
    async list(ownerId) {
      return (await recordsFor(toolCollection(), text(ownerId, "ownerId"))).map(mapTool);
    },
    async update(ownerId, toolId, patch) {
      const scopedOwner = text(ownerId, "ownerId");
      const id = text(toolId, "toolId");
      const records = toolCollection();
      const existing = (await recordsFor(records, scopedOwner)).find((item) => item.toolId === id);
      if (!existing) throw new Error(`Tool ${id} was not found for owner ${scopedOwner}`);
      const data: Record<string, unknown> = {
        updatedAt: options.now().toISOString(),
        ...(patch.namespace === undefined ? {} : { namespace: text(patch.namespace, "namespace") }),
        ...(patch.description === undefined ? {} : { description: text(patch.description, "description") }),
        ...(patch.inputSchema === undefined ? {} : { inputSchema: safeJson(patch.inputSchema) }),
        ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
        ...(patch.risk === undefined ? {} : { risk: patch.risk }),
        ...(patch.metadata === undefined ? {} : { metadata: safeJson(patch.metadata) }),
      };
      return mapTool((await records.update(existing.id, data)) ?? { ...existing, ...data });
    },
  };

  const policies: ToolPolicyRepository = {
    async save(ownerId, input) {
      const scopedOwner = text(ownerId, "ownerId");
      const policyId = input.id === undefined ? `policy-${text(input.toolId, "toolId")}-${input.agentId ?? input.projectId ?? "default"}` : text(input.id, "policyId");
      const records = policyCollection();
      const existing = (await recordsFor(records, scopedOwner)).find((record) => record.policyId === policyId);
      const now = options.now().toISOString();
      const data: Record<string, unknown> = {
        ownerId: scopedOwner,
        policyId,
        toolId: text(input.toolId, "toolId"),
        rules: safeJson(input.rules),
        version: input.version ?? (typeof existing?.version === "number" ? existing.version + 1 : 1),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      if (input.agentId !== undefined) data.agentId = text(input.agentId, "agentId");
      if (input.projectId !== undefined) data.projectId = text(input.projectId, "projectId");
      return mapPolicy(existing ? (await records.update(existing.id, data)) ?? { ...existing, ...data } : await records.create(data));
    },
    async get(ownerId, id) {
      const record = (await recordsFor(policyCollection(), text(ownerId, "ownerId"))).find((item) => (item.policyId ?? item.id) === text(id, "policyId"));
      return record ? mapPolicy(record) : undefined;
    },
    async list(ownerId, filter = {}) {
      return (await recordsFor(policyCollection(), text(ownerId, "ownerId")))
        .filter((record) => filter.toolId === undefined || record.toolId === filter.toolId)
        .filter((record) => filter.agentId === undefined || record.agentId === filter.agentId)
        .filter((record) => filter.projectId === undefined || record.projectId === filter.projectId)
        .map(mapPolicy);
    },
  };

  const continuations: ApprovalContinuationRepository = {
    async put(ownerId, approvalId, callId, input) {
      const scopedOwner = text(ownerId, "ownerId");
      const data: Record<string, unknown> = {
        ownerId: scopedOwner,
        approvalId: text(approvalId, "approvalId"),
        callId: text(callId, "callId"),
        opaquePayload: text(input.payload, "opaquePayload"),
        requestHash: text(input.requestHash, "requestHash"),
        expiresAt: timestamp(input.expiresAt, "expiresAt"),
      };
      if (input.keyId !== undefined) data.keyId = text(input.keyId, "keyId");
      const records = continuationCollection();
      const existing = (await recordsFor(records, scopedOwner)).find((record) => record.approvalId === approvalId);
      const saved = existing ? (await records.update(existing.id, data)) ?? { ...existing, ...data } as PocketBaseStoredRecord : await records.create(data);
      return mapContinuation(saved);
    },
    async get(ownerId, approvalId) {
      const record = (await recordsFor(continuationCollection(), text(ownerId, "ownerId"))).find((item) => item.approvalId === text(approvalId, "approvalId"));
      return record ? mapContinuation(record) : undefined;
    },
  };

  const claims: ApprovalClaimRepository = {
    async claim(ownerId, approvalId, callId) {
      const scopedOwner = text(ownerId, "ownerId");
      const approval = text(approvalId, "approvalId");
      const call = text(callId, "callId");
      const records = continuationCollection();
      const current = (await recordsFor(records, scopedOwner)).find((record) => record.approvalId === approval);
      if (!current || current.callId !== call) throw new Error(`Approval ${approval} is not available for this call`);
      const existingClaim = optionalString(current, "claimToken");
      if (existingClaim) {
        return { ownerId: scopedOwner, approvalId: approval, callId: call, claimed: false, claimedAt: text(current.claimedAt, "claimedAt"), claimToken: existingClaim };
      }
      const claimedAt = options.now().toISOString();
      const claimToken = `claim-${approval}-${claimedAt}`;
      const data = { claimedAt, claimToken };
      let claimed: PocketBaseStoredRecord | undefined;
      if (options.atomicClaim) {
        claimed = await options.atomicClaim.claim(records, current.id, { ownerId: scopedOwner, approvalId: approval, callId: call, claimToken: undefined }, data);
      } else if (options.conditionalUpdate) {
        claimed = await options.conditionalUpdate.update(records, current.id, { ownerId: scopedOwner, approvalId: approval, callId: call, claimToken: undefined }, data);
      } else if (options.transaction) {
        claimed = await options.transaction.run(async () => {
          const latest = await records.get(current.id);
          if (!latest || latest.claimToken !== undefined) return latest;
          return records.update(current.id, data);
        });
      } else {
        throw options.unsupported("approval.atomic-claim");
      }
      if (claimed?.claimToken === claimToken) return { ownerId: scopedOwner, approvalId: approval, callId: call, claimed: true, claimedAt, claimToken };
      const winner = await records.get(current.id);
      if (!winner || winner.ownerId !== scopedOwner || winner.callId !== call) throw new Error(`Approval ${approval} is no longer available`);
      return { ownerId: scopedOwner, approvalId: approval, callId: call, claimed: false, claimedAt: text(winner.claimedAt, "claimedAt"), claimToken: text(winner.claimToken, "claimToken") };
    },
  };

  const localLocks = new Map<string, Promise<unknown>>();
  const callIds: CallIdempotencyRepository = {
    async execute<T>(ownerId: string, callId: string, operation: () => Promise<T> | T): Promise<T> {
      const scopedOwner = text(ownerId, "ownerId");
      const call = text(callId, "callId");
      const key = `${scopedOwner}:${call}`;
      if (!options.collections?.callClaims && options.idempotency) {
        return options.idempotency.execute(key, async () => operation());
      }
      const active = localLocks.get(key);
      if (active) return active as Promise<T>;
      const records = callCollection();
      const work = (async () => {
        const existing = (await recordsFor(records, scopedOwner)).find((record) => record.callId === call);
        if (existing?.state === "completed") return clone(existing.result) as T;
        if (existing?.state === "failed") {
          const error = existing.error && typeof existing.error === "object" && typeof (existing.error as { message?: unknown }).message === "string"
            ? String((existing.error as { message: string }).message)
            : undefined;
          throw new PocketBaseCallFailedError(scopedOwner, call, error);
        }
        if (existing?.state === "pending") throw new PocketBaseCallAlreadyClaimedError(scopedOwner, call);
        const claimed = options.atomicClaim
          ? await options.atomicClaim.claim(records, `call:${key}`, { ownerId: scopedOwner, callId: call }, { ownerId: scopedOwner, callId: call, state: "pending", claimedAt: options.now().toISOString() })
          : await records.create({ ownerId: scopedOwner, callId: call, state: "pending", claimedAt: options.now().toISOString() });
        if (!claimed) throw new PocketBaseCallAlreadyClaimedError(scopedOwner, call);
        try {
          const result = await operation();
          await records.update(claimed.id, { state: "completed", result: safeJson(result), completedAt: options.now().toISOString() });
          return result;
        } catch (error) {
          await records.update(claimed.id, { state: "failed", error: safeJson(error), completedAt: options.now().toISOString() });
          throw error;
        }
      })();
      localLocks.set(key, work);
      try { return await work; } finally { localLocks.delete(key); }
    },
  };

  function runStore(ownerId: string): RunStore {
    const capabilities: AdapterCapabilities = {
      adapter: "pocketbase",
      durability: "remote",
      supports: { "run.outcome.persistence": Boolean(options.collections?.runs) },
    };
    return {
      capabilities,
      load: (runId) => runs.load(ownerId, runId),
      save: async (outcome) => { await runs.save(ownerId, outcome); },
    };
  }

  function eventReplay(ownerId: string): EventReplayPort {
    const capabilities: AdapterCapabilities = {
      adapter: "pocketbase",
      durability: "remote",
      supports: { "event.replay": Boolean(options.collections?.runEvents) },
    };
    return {
      capabilities,
      append: async (event) => { await runEvents.append(ownerId, event); },
      replay: (runId) => runEvents.replay(ownerId, runId),
    };
  }

  return { transcripts, runs, runEvents, tools, policies, continuations, claims, callIds, runStore, eventReplay };
}
