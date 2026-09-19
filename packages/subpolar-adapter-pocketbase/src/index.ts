import { UnsupportedCapabilityError } from "../../subpolar-contracts/src/index.ts";
import type {
  AdapterCapability,
  AdapterCapabilities,
  AuditRecord,
  DomainEvent,
  JsonValue,
  SessionStore as CoreSessionStore,
  SessionTranscriptEntry,
} from "../../subpolar-contracts/src/index.ts";

export const POCKETBASE_ADAPTER_NAME = "pocketbase";

export type PocketBaseCapability =
  | "agent.persistence"
  | "project.persistence"
  | "session.persistence"
  | "durable-approvals"
  | "audit.persistence"
  | "event.publication"
  | "event.replay"
  | "transactions"
  | "idempotency"
  | "conditional-updates"
  | "approval.atomic-decision"
  | "multi-process-concurrency";

export interface PocketBaseAdapterCapabilities {
  adapter: typeof POCKETBASE_ADAPTER_NAME;
  durability: "pocketbase";
  supports: Readonly<Record<PocketBaseCapability, boolean>>;
}

function commonCapability(capability: PocketBaseCapability): AdapterCapability {
  if (capability === "session.persistence" || capability === "event.replay" || capability === "durable-approvals") {
    return capability;
  }
  return capability === "multi-process-concurrency" || capability === "transactions" || capability === "idempotency" || capability === "conditional-updates" || capability === "approval.atomic-decision"
    ? "multi-process-concurrency"
    : "session.persistence";
}

export class PocketBaseUnsupportedCapabilityError extends UnsupportedCapabilityError {
  readonly pocketBaseCapability: PocketBaseCapability;

  constructor(capability: PocketBaseCapability, message?: string) {
    super(commonCapability(capability), POCKETBASE_ADAPTER_NAME, message ?? `${POCKETBASE_ADAPTER_NAME} does not support ${capability}`);
    this.name = "PocketBaseUnsupportedCapabilityError";
    this.pocketBaseCapability = capability;
  }
}

export class PocketBaseOwnerScopeError extends Error {
  readonly code = "OWNER_SCOPE_DENIED";
  readonly ownerId: string;
  readonly recordId: string;

  constructor(ownerId: string, recordId: string) {
    super(`Owner ${ownerId} cannot access record ${recordId}`);
    this.name = "PocketBaseOwnerScopeError";
    this.ownerId = ownerId;
    this.recordId = recordId;
  }
}

export interface PocketBaseStoredRecord {
  id: string;
  [field: string]: unknown;
}

export interface PocketBaseCollectionPort<TRecord extends PocketBaseStoredRecord = PocketBaseStoredRecord> {
  list(): Promise<readonly TRecord[]>;
  get(id: string): Promise<TRecord | undefined>;
  create(data: Record<string, unknown>): Promise<TRecord>;
  update(id: string, data: Record<string, unknown>): Promise<TRecord | undefined>;
}

export interface PocketBaseClientPort {
  collection(name: string): PocketBaseCollectionPort;
}

export interface PocketBaseTransactionPort {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

export interface PocketBaseIdempotencyPort {
  execute<T>(key: string, operation: () => Promise<T>): Promise<T>;
}

export interface PocketBaseConditionalUpdatePort {
  update(
    collection: PocketBaseCollectionPort,
    id: string,
    expected: Readonly<Record<string, unknown>>,
    data: Record<string, unknown>,
  ): Promise<PocketBaseStoredRecord | undefined>;
}

export interface PocketBaseCollectionNames {
  agents?: string | null;
  projects?: string | null;
  sessions?: string | null;
  approvals?: string | null;
  audits?: string | null;
  events?: string | null;
}

export interface PocketBaseAdapterOptions {
  client: PocketBaseClientPort;
  collections?: PocketBaseCollectionNames;
  eventReplay?: boolean;
  transaction?: PocketBaseTransactionPort;
  idempotency?: PocketBaseIdempotencyPort;
  conditionalUpdate?: PocketBaseConditionalUpdatePort;
  now?: () => Date;
}

export interface AgentRecord {
  id: string;
  ownerId: string;
  name: string;
  description?: string;
  config?: JsonValue;
  createdAt: string;
  updatedAt: string;
}

export interface AgentCreateInput {
  name: string;
  description?: string;
  config?: JsonValue;
}

export interface AgentPatchInput {
  name?: string;
  description?: string;
  config?: JsonValue;
}

export interface ProjectRecord {
  id: string;
  ownerId: string;
  name: string;
  description?: string;
  metadata?: JsonValue;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectCreateInput {
  name: string;
  description?: string;
  metadata?: JsonValue;
}

export interface ProjectPatchInput {
  name?: string;
  description?: string;
  metadata?: JsonValue;
}

export interface SessionRecord {
  id: string;
  ownerId: string;
  sessionId: string;
  transcript: SessionTranscriptEntry[];
  updatedAt: string;
}

export interface ApprovalRecord {
  id: string;
  ownerId: string;
  approvalId: string;
  callId: string;
  toolId: string;
  status: "pending" | "approved" | "denied";
  request: JsonValue;
  decidedBy?: string;
  reason?: string;
  createdAt: string;
  decidedAt?: string;
}

export interface ApprovalCreateInput {
  approvalId: string;
  callId: string;
  toolId: string;
  request: JsonValue;
}

export type ApprovalDecisionInput =
  | { approved: true; decidedBy?: string }
  | { approved: false; reason?: string; decidedBy?: string };

export interface PublishedEvent<T extends JsonValue = JsonValue> {
  id: string;
  ownerId: string;
  event: DomainEvent<T>;
}

export interface EventReplayOptions {
  afterEventId?: string;
}

export interface AgentRepository {
  create(ownerId: string, input: AgentCreateInput): Promise<AgentRecord>;
  get(ownerId: string, id: string): Promise<AgentRecord | undefined>;
  list(ownerId: string): Promise<AgentRecord[]>;
  update(ownerId: string, id: string, patch: AgentPatchInput): Promise<AgentRecord>;
}

export interface ProjectRepository {
  create(ownerId: string, input: ProjectCreateInput): Promise<ProjectRecord>;
  get(ownerId: string, id: string): Promise<ProjectRecord | undefined>;
  list(ownerId: string): Promise<ProjectRecord[]>;
  update(ownerId: string, id: string, patch: ProjectPatchInput): Promise<ProjectRecord>;
}

export interface SessionRepository {
  load(ownerId: string, sessionId: string): Promise<SessionRecord | undefined>;
  append(ownerId: string, sessionId: string, entries: SessionTranscriptEntry[]): Promise<SessionRecord>;
}

export interface ApprovalRepository {
  create(ownerId: string, input: ApprovalCreateInput): Promise<ApprovalRecord>;
  get(ownerId: string, approvalId: string): Promise<ApprovalRecord | undefined>;
  list(ownerId: string): Promise<ApprovalRecord[]>;
  decide(ownerId: string, approvalId: string, decision: ApprovalDecisionInput): Promise<ApprovalRecord>;
}

export interface AuditRepository {
  append(ownerId: string, record: AuditRecord): Promise<AuditRecord>;
  list(ownerId: string): Promise<AuditRecord[]>;
}

export interface EventRepository {
  publish<T extends JsonValue>(ownerId: string, event: DomainEvent<T>): Promise<PublishedEvent<T>>;
  replay(ownerId: string, options?: EventReplayOptions): Promise<PublishedEvent[]>;
}

export interface TransactionBoundary {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

export interface IdempotencyBoundary {
  execute<T>(key: string, operation: () => Promise<T>): Promise<T>;
}

export interface PocketBaseAdapter {
  readonly capabilities: PocketBaseAdapterCapabilities;
  readonly agents: AgentRepository;
  readonly projects: ProjectRepository;
  readonly sessions: SessionRepository;
  readonly approvals: ApprovalRepository;
  readonly audits: AuditRepository;
  readonly events: EventRepository;
  readonly transactions: TransactionBoundary;
  readonly idempotency: IdempotencyBoundary;
}

function configuredCollectionName(
  configured: PocketBaseCollectionNames | undefined,
  key: keyof PocketBaseCollectionNames,
): string | undefined {
  if (!configured || !Object.prototype.hasOwnProperty.call(configured, key)) return undefined;
  const value = configured[key];
  return value === null ? undefined : value;
}

function requireText(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} is required`);
  return value;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

const sensitiveField = /(?:^|[_-])(api[_-]?key|authorization|cookie|credential|password|secret|token)(?:$|[_-])/i;

function redactJson(value: unknown, key?: string): JsonValue {
  if (key && sensitiveField.test(key)) return "[REDACTED]";
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redactJson(item));
  if (value && typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [field, item] of Object.entries(value)) result[field] = redactJson(item, field);
    return result;
  }
  return "[REDACTED]";
}

function redactText(value: string): string {
  const redacted = redactJson(value);
  return typeof redacted === "string" ? redacted : "[REDACTED]";
}

function asString(record: PocketBaseStoredRecord, field: string): string {
  const value = record[field];
  if (typeof value !== "string") throw new Error(`PocketBase record is missing ${field}`);
  return value;
}

function asOptionalString(record: PocketBaseStoredRecord, field: string): string | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`PocketBase record has an invalid ${field}`);
  return value;
}

function asJson(record: PocketBaseStoredRecord, field: string, fallback: JsonValue): JsonValue {
  const value = record[field];
  return value === undefined ? clone(fallback) : redactJson(value);
}

function requireCollection(
  collection: PocketBaseCollectionPort | undefined,
  capability: PocketBaseCapability,
): PocketBaseCollectionPort {
  if (!collection) throw new PocketBaseUnsupportedCapabilityError(capability);
  return collection;
}

function owner(ownerId: string): string {
  return requireText(ownerId, "ownerId");
}

async function ownedRecord(
  collection: PocketBaseCollectionPort,
  ownerId: string,
  recordId: string,
): Promise<PocketBaseStoredRecord | undefined> {
  const record = await collection.get(requireText(recordId, "recordId"));
  if (!record || record.ownerId !== ownerId) return undefined;
  return record;
}

async function ownedRecords(collection: PocketBaseCollectionPort, ownerId: string): Promise<PocketBaseStoredRecord[]> {
  const records = await collection.list();
  return records.filter((record) => record.ownerId === ownerId).map((record) => clone(record));
}

function requireOwnedRecord(
  record: PocketBaseStoredRecord | undefined,
  ownerId: string,
  recordId: string,
): PocketBaseStoredRecord {
  if (!record) throw new PocketBaseOwnerScopeError(ownerId, recordId);
  return record;
}

function assertSessionEntry(entry: SessionTranscriptEntry): SessionTranscriptEntry {
  if (!entry || !["user", "assistant", "tool"].includes(entry.role) || typeof entry.content !== "string") {
    throw new Error("Invalid transcript entry");
  }
  if (typeof entry.occurredAt !== "string" || Number.isNaN(Date.parse(entry.occurredAt))) {
    throw new Error("Invalid transcript timestamp");
  }
  return { ...entry };
}

function mapAgent(record: PocketBaseStoredRecord): AgentRecord {
  return {
    id: record.id,
    ownerId: asString(record, "ownerId"),
    name: asString(record, "name"),
    description: asOptionalString(record, "description"),
    config: record.config === undefined ? undefined : asJson(record, "config", null),
    createdAt: asString(record, "createdAt"),
    updatedAt: asString(record, "updatedAt"),
  };
}

function mapProject(record: PocketBaseStoredRecord): ProjectRecord {
  return {
    id: record.id,
    ownerId: asString(record, "ownerId"),
    name: asString(record, "name"),
    description: asOptionalString(record, "description"),
    metadata: record.metadata === undefined ? undefined : asJson(record, "metadata", null),
    createdAt: asString(record, "createdAt"),
    updatedAt: asString(record, "updatedAt"),
  };
}

function mapSession(record: PocketBaseStoredRecord): SessionRecord {
  if (!Array.isArray(record.transcript)) throw new Error("PocketBase session has an invalid transcript");
  return {
    id: record.id,
    ownerId: asString(record, "ownerId"),
    sessionId: asString(record, "sessionId"),
    transcript: record.transcript.map((entry, index) => {
      try {
        return assertSessionEntry(entry as SessionTranscriptEntry);
      } catch {
        throw new Error(`Invalid transcript entry at index ${index}`);
      }
    }),
    updatedAt: asString(record, "updatedAt"),
  };
}

function mapApproval(record: PocketBaseStoredRecord): ApprovalRecord {
  const status = asString(record, "status");
  if (!["pending", "approved", "denied"].includes(status)) throw new Error("PocketBase approval has an invalid status");
  return {
    id: record.id,
    ownerId: asString(record, "ownerId"),
    approvalId: asString(record, "approvalId"),
    callId: asString(record, "callId"),
    toolId: asString(record, "toolId"),
    status: status as ApprovalRecord["status"],
    request: asJson(record, "request", null),
    decidedBy: asOptionalString(record, "decidedBy"),
    reason: asOptionalString(record, "reason"),
    createdAt: asString(record, "createdAt"),
    decidedAt: asOptionalString(record, "decidedAt"),
  };
}

function mapPublishedEvent(record: PocketBaseStoredRecord): PublishedEvent {
  return {
    id: record.id,
    ownerId: asString(record, "ownerId"),
    event: {
      eventId: asString(record, "eventId"),
      type: asString(record, "type"),
      occurredAt: asString(record, "occurredAt"),
      data: asJson(record, "data", null),
    },
  };
}

export function createPocketBaseAdapter(options: PocketBaseAdapterOptions): PocketBaseAdapter {
  const now = options.now ?? (() => new Date());
  const collection = (name: string | undefined): PocketBaseCollectionPort | undefined =>
    name ? options.client.collection(name) : undefined;
  const agentCollection = collection(configuredCollectionName(options.collections, "agents"));
  const projectCollection = collection(configuredCollectionName(options.collections, "projects"));
  const sessionCollection = collection(configuredCollectionName(options.collections, "sessions"));
  const approvalCollection = collection(configuredCollectionName(options.collections, "approvals"));
  const auditCollection = collection(configuredCollectionName(options.collections, "audits"));
  const eventCollection = collection(configuredCollectionName(options.collections, "events"));

  const supports: Record<PocketBaseCapability, boolean> = {
    "agent.persistence": Boolean(agentCollection),
    "project.persistence": Boolean(projectCollection),
    "session.persistence": Boolean(sessionCollection),
    "durable-approvals": Boolean(approvalCollection),
    "audit.persistence": Boolean(auditCollection),
    "event.publication": Boolean(eventCollection),
    "event.replay": Boolean(eventCollection) && options.eventReplay === true,
    transactions: Boolean(options.transaction),
    idempotency: Boolean(options.idempotency),
    "conditional-updates": Boolean(options.conditionalUpdate),
    "approval.atomic-decision": Boolean(approvalCollection && (options.transaction || options.idempotency || options.conditionalUpdate)),
    "multi-process-concurrency": false,
  };
  const capabilities: PocketBaseAdapterCapabilities = {
    adapter: POCKETBASE_ADAPTER_NAME,
    durability: "pocketbase",
    supports,
  };

  const agents: AgentRepository = {
    async create(ownerId, input) {
      const scopedOwner = owner(ownerId);
      requireText(input.name, "name");
      const timestamp = now().toISOString();
      const created = await requireCollection(agentCollection, "agent.persistence").create({
        ownerId: scopedOwner,
        name: input.name,
        description: input.description,
        config: input.config,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      return mapAgent(created);
    },
    async get(ownerId, id) {
      const record = await ownedRecord(requireCollection(agentCollection, "agent.persistence"), owner(ownerId), id);
      return record ? mapAgent(record) : undefined;
    },
    async list(ownerId) {
      const records = await ownedRecords(requireCollection(agentCollection, "agent.persistence"), owner(ownerId));
      return records.map(mapAgent);
    },
    async update(ownerId, id, patch) {
      const scopedOwner = owner(ownerId);
      const records = requireCollection(agentCollection, "agent.persistence");
      const current = requireOwnedRecord(await ownedRecord(records, scopedOwner, id), scopedOwner, id);
      const updated = await records.update(id, {
        ...(patch.name === undefined ? {} : { name: requireText(patch.name, "name") }),
        ...(patch.description === undefined ? {} : { description: patch.description }),
        ...(patch.config === undefined ? {} : { config: patch.config }),
        updatedAt: now().toISOString(),
      });
      return mapAgent(updated ?? current);
    },
  };

  const projects: ProjectRepository = {
    async create(ownerId, input) {
      const scopedOwner = owner(ownerId);
      requireText(input.name, "name");
      const timestamp = now().toISOString();
      const created = await requireCollection(projectCollection, "project.persistence").create({
        ownerId: scopedOwner,
        name: input.name,
        description: input.description,
        metadata: input.metadata,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      return mapProject(created);
    },
    async get(ownerId, id) {
      const record = await ownedRecord(requireCollection(projectCollection, "project.persistence"), owner(ownerId), id);
      return record ? mapProject(record) : undefined;
    },
    async list(ownerId) {
      const records = await ownedRecords(requireCollection(projectCollection, "project.persistence"), owner(ownerId));
      return records.map(mapProject);
    },
    async update(ownerId, id, patch) {
      const scopedOwner = owner(ownerId);
      const records = requireCollection(projectCollection, "project.persistence");
      const current = requireOwnedRecord(await ownedRecord(records, scopedOwner, id), scopedOwner, id);
      const updated = await records.update(id, {
        ...(patch.name === undefined ? {} : { name: requireText(patch.name, "name") }),
        ...(patch.description === undefined ? {} : { description: patch.description }),
        ...(patch.metadata === undefined ? {} : { metadata: patch.metadata }),
        updatedAt: now().toISOString(),
      });
      return mapProject(updated ?? current);
    },
  };

  const sessions: SessionRepository = {
    async load(ownerId, sessionId) {
      const scopedOwner = owner(ownerId);
      requireText(sessionId, "sessionId");
      const records = requireCollection(sessionCollection, "session.persistence");
      const stored = (await records.list()).find((record) => record.sessionId === sessionId && record.ownerId === scopedOwner);
      return stored ? mapSession(stored) : undefined;
    },
    async append(ownerId, sessionId, entries) {
      const scopedOwner = owner(ownerId);
      requireText(sessionId, "sessionId");
      if (!Array.isArray(entries)) throw new Error("Transcript entries must be an array");
      const validated = entries.map(assertSessionEntry);
      const records = requireCollection(sessionCollection, "session.persistence");
      const existing = (await records.list()).find((record) => record.sessionId === sessionId);
      if (existing && existing.ownerId !== scopedOwner) throw new PocketBaseOwnerScopeError(scopedOwner, sessionId);
      const timestamp = now().toISOString();
      const payload = existing
        ? { transcript: [...(existing.transcript as SessionTranscriptEntry[]), ...validated], updatedAt: timestamp }
        : { ownerId: scopedOwner, sessionId, transcript: validated, updatedAt: timestamp };
      const saved = existing ? await records.update(existing.id, payload) : await records.create(payload);
      return mapSession(saved ?? { ...existing, ...payload } as PocketBaseStoredRecord);
    },
  };

  const approvals: ApprovalRepository = {
    async create(ownerId, input) {
      const scopedOwner = owner(ownerId);
      requireText(input.approvalId, "approvalId");
      requireText(input.callId, "callId");
      requireText(input.toolId, "toolId");
      const created = await requireCollection(approvalCollection, "durable-approvals").create({
        ownerId: scopedOwner,
        approvalId: input.approvalId,
        callId: input.callId,
        toolId: input.toolId,
        status: "pending",
        request: redactJson(input.request),
        createdAt: now().toISOString(),
      });
      return mapApproval(created);
    },
    async get(ownerId, approvalId) {
      const records = requireCollection(approvalCollection, "durable-approvals");
      const stored = (await records.list()).find((record) => record.approvalId === approvalId && record.ownerId === owner(ownerId));
      return stored ? mapApproval(stored) : undefined;
    },
    async list(ownerId) {
      const records = await ownedRecords(requireCollection(approvalCollection, "durable-approvals"), owner(ownerId));
      return records.map(mapApproval);
    },
    async decide(ownerId, approvalId, decision) {
      const scopedOwner = owner(ownerId);
      const records = requireCollection(approvalCollection, "durable-approvals");
      if (typeof decision?.approved !== "boolean") throw new Error("Approval decision must specify approved");
      const decidedBy = decision.decidedBy === undefined ? undefined : requireText(decision.decidedBy, "decidedBy");
      const reason = decision.approved || decision.reason === undefined ? undefined : requireText(decision.reason, "reason");

      const decideAtomically = async (): Promise<ApprovalRecord> => {
        const current = (await records.list()).find((record) => record.approvalId === approvalId);
        if (!current || current.ownerId !== scopedOwner) throw new PocketBaseOwnerScopeError(scopedOwner, approvalId);
        if (current.status !== "pending") return mapApproval(current);

        const payload: Record<string, unknown> = {
          ownerId: scopedOwner,
          approvalId: current.approvalId,
          status: decision.approved ? "approved" : "denied",
          decidedAt: now().toISOString(),
        };
        if (decidedBy !== undefined) payload.decidedBy = redactText(decidedBy);
        if (reason !== undefined) payload.reason = redactText(reason);

        if (options.conditionalUpdate) {
          await options.conditionalUpdate.update(records, current.id, {
            ownerId: scopedOwner,
            approvalId: current.approvalId,
            status: "pending",
          }, payload);
        } else {
          await records.update(current.id, payload);
        }

        const verified = await records.get(current.id);
        if (!verified || verified.ownerId !== scopedOwner || verified.approvalId !== approvalId) {
          throw new PocketBaseOwnerScopeError(scopedOwner, approvalId);
        }
        const verifiedStatus = asString(verified, "status");
        if (verifiedStatus === "pending") throw new Error("PocketBase approval decision was not committed atomically");
        if (!["approved", "denied"].includes(verifiedStatus)) throw new Error("PocketBase approval has an invalid terminal state");
        return mapApproval(verified);
      };

      if (options.transaction) return options.transaction.run(decideAtomically);
      if (options.idempotency) return options.idempotency.execute(`approval-decision:${scopedOwner}:${approvalId}`, decideAtomically);
      if (options.conditionalUpdate) return decideAtomically();
      throw new PocketBaseUnsupportedCapabilityError("approval.atomic-decision");
    },
  };

  const audits: AuditRepository = {
    async append(ownerId, record) {
      const scopedOwner = owner(ownerId);
      if (!( ["deny", "approval_required", "allow", "not_evaluated"] as string[]).includes(record.decision)) {
        throw new Error("Invalid audit decision");
      }
      if (!( ["unknown_tool", "disabled", "validation_failed", "denied", "approval_required", "approval_denied", "executed", "failed"] as string[]).includes(record.status)) {
        throw new Error("Invalid audit status");
      }
      const trusted: AuditRecord = {
        auditId: requireText(record.auditId, "auditId"),
        callId: requireText(record.callId, "callId"),
        toolId: requireText(record.toolId, "toolId"),
        principalId: requireText(record.principalId, "principalId"),
        sessionId: record.sessionId === undefined ? undefined : requireText(record.sessionId, "sessionId"),
        requestId: requireText(record.requestId, "requestId"),
        decision: record.decision,
        status: record.status,
        input: redactJson(record.input),
        result: record.result === undefined ? undefined : redactJson(record.result),
        reason: record.reason === undefined ? undefined : redactText(record.reason),
        occurredAt: now().toISOString(),
      };
      const data: Record<string, unknown> = {
        ownerId: scopedOwner,
        auditId: trusted.auditId,
        callId: trusted.callId,
        toolId: trusted.toolId,
        principalId: trusted.principalId,
        requestId: trusted.requestId,
        decision: trusted.decision,
        status: trusted.status,
        input: trusted.input,
        occurredAt: trusted.occurredAt,
      };
      if (trusted.sessionId !== undefined) data.sessionId = trusted.sessionId;
      if (trusted.result !== undefined) data.result = trusted.result;
      if (trusted.reason !== undefined) data.reason = trusted.reason;
      await requireCollection(auditCollection, "audit.persistence").create(data);
      return clone(trusted);
    },
    async list(ownerId) {
      const records = await ownedRecords(requireCollection(auditCollection, "audit.persistence"), owner(ownerId));
      return records.map((record) => mapAudit(record));
    },
  };

  const events: EventRepository = {
    async publish(ownerId, event) {
      const scopedOwner = owner(ownerId);
      const trusted = {
        eventId: requireText(event.eventId, "eventId"),
        type: requireText(event.type, "event.type"),
        occurredAt: now().toISOString(),
        data: redactJson(event.data),
      };
      const created = await requireCollection(eventCollection, "event.publication").create({
        ownerId: scopedOwner,
        eventId: trusted.eventId,
        type: trusted.type,
        occurredAt: trusted.occurredAt,
        data: trusted.data,
      });
      return {
        id: created.id,
        ownerId: scopedOwner,
        event: trusted,
      } as PublishedEvent<typeof event.data>;
    },
    async replay(ownerId, replayOptions = {}) {
      if (!supports["event.replay"]) throw new PocketBaseUnsupportedCapabilityError("event.replay");
      const records = await ownedRecords(requireCollection(eventCollection, "event.replay"), owner(ownerId));
      const start = replayOptions.afterEventId === undefined ? -1 : records.findIndex((record) => record.eventId === replayOptions.afterEventId);
      return records.slice(start + 1).map(mapPublishedEvent);
    },
  };

  return {
    capabilities,
    agents,
    projects,
    sessions,
    approvals,
    audits,
    events,
    transactions: {
      run: async <T>(operation: () => Promise<T>) => {
        if (!options.transaction) throw new PocketBaseUnsupportedCapabilityError("transactions");
        return options.transaction.run(operation);
      },
    },
    idempotency: {
      execute: async <T>(key: string, operation: () => Promise<T>) => {
        if (!options.idempotency) throw new PocketBaseUnsupportedCapabilityError("idempotency");
        return options.idempotency.execute(requireText(key, "key"), operation);
      },
    },
  };
}

/**
 * Binds the repository's explicit owner scope to core's ownerless SessionStore
 * contract. The owner is selected at composition time, never from a session
 * method argument supplied by the run service.
 */
export function createPocketBaseSessionStore(
  adapter: Pick<PocketBaseAdapter, "capabilities" | "sessions">,
  ownerId: string,
): CoreSessionStore {
  const scopedOwner = owner(ownerId);
  const capabilities: AdapterCapabilities = {
    adapter: adapter.capabilities.adapter,
    // The common contract predates PocketBase and only has this compatibility value.
    durability: "json-file",
    supports: {
      "session.persistence": adapter.capabilities.supports["session.persistence"],
      "event.replay": adapter.capabilities.supports["event.replay"],
      "multi-process-concurrency": adapter.capabilities.supports["multi-process-concurrency"],
      "durable-approvals": adapter.capabilities.supports["durable-approvals"],
    },
  };
  return {
    capabilities,
    load: async (sessionId) => {
      const record = await adapter.sessions.load(scopedOwner, sessionId);
      return record ? { sessionId: record.sessionId, transcript: clone(record.transcript), updatedAt: record.updatedAt } : undefined;
    },
    append: async (sessionId, entries) => {
      const record = await adapter.sessions.append(scopedOwner, sessionId, entries);
      return { sessionId: record.sessionId, transcript: clone(record.transcript), updatedAt: record.updatedAt };
    },
  };
}

function mapAudit(record: PocketBaseStoredRecord): AuditRecord {
  const storedDecision = asString(record, "decision");
  const decision = storedDecision === "not_evaluated" ? "allow" : storedDecision;
  const status = asString(record, "status");
  if (!(["deny", "approval_required", "allow"] as string[]).includes(decision)) {
    throw new Error("PocketBase audit record has an invalid decision");
  }
  if (!( ["unknown_tool", "disabled", "validation_failed", "denied", "approval_required", "approval_denied", "executed", "failed"] as string[]).includes(status)) {
    throw new Error("PocketBase audit record has an invalid status");
  }
  if (typeof record.auditId !== "string" || typeof record.callId !== "string" || typeof record.toolId !== "string") {
    throw new Error("PocketBase audit record is invalid");
  }
  return {
    auditId: record.auditId,
    callId: record.callId,
    toolId: record.toolId,
    principalId: asString(record, "principalId"),
    sessionId: asOptionalString(record, "sessionId"),
    requestId: asString(record, "requestId"),
    decision: storedDecision as AuditRecord["decision"],
    status: status as AuditRecord["status"],
    input: asJson(record, "input", null),
    result: record.result === undefined ? undefined : asJson(record, "result", null),
    reason: asOptionalString(record, "reason"),
    occurredAt: asString(record, "occurredAt"),
  };
}
