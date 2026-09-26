import { UnsupportedCapabilityError } from "../../subpolar-contracts/src/index.ts";
import type {
  AdapterCapability,
  AdapterCapabilities,
  ApprovalClaimPort,
  ApprovalContinuationPort,
  ApprovalDecision,
  ApprovalRecord as CoreApprovalRecord,
  ApprovalRequest,
  ApprovalStore,
  AuditPort,
  AuditRecord,
  DomainEvent,
  IdempotencyPort,
  JsonValue,
  SessionStore as CoreSessionStore,
  SessionTranscriptEntry,
  MemoryRecord,
  MemoryScope,
  Skill,
  SkillRepository,
  EffectiveSkill,
  EventReplayPort,
  RunEvent,
  RunOutcome,
  RunStore,
} from "../../subpolar-contracts/src/index.ts";
import { SkillConflictError, SkillNotFoundError, SkillValidationError, createSkill, updateSkill, listSkills, resolveEffectiveSkills, assertValidSkill } from "../../subpolar-contracts/src/index.ts";
import { createPocketBaseTargetPersistence } from "./durable.ts";
import type {
  ApprovalClaim,
  ApprovalContinuationRepository,
  ApprovalClaimRepository,
  CanonicalTranscriptRepository,
  CallIdempotencyRepository,
  OpaqueContinuation,
  RunEventRepository,
  RunRepository,
  ToolDefinitionRepository,
  ToolPolicyRepository,
} from "./durable.ts";
export type * from "./durable.ts";

export const POCKETBASE_ADAPTER_NAME = "pocketbase";

export type PocketBaseCapability =
  | "agent.persistence"
  | "project.persistence"
  | "session.persistence"
  | "durable-approvals"
  | "audit.persistence"
  | "event.publication"
  | "event.replay"
  | "run-event.persistence"
  | "transactions"
  | "idempotency"
  | "conditional-updates"
  | "approval.atomic-decision"
  | "multi-process-concurrency"
  | "memory.persistence"
  | "skill.persistence"
  | "transcript.persistence"
  | "run.persistence"
  | "tool.persistence"
  | "policy.persistence"
  | "approval.continuation"
  | "approval.atomic-claim"
  | "call-id.idempotency";

export interface PocketBaseAdapterCapabilities {
  adapter: typeof POCKETBASE_ADAPTER_NAME;
  durability: "pocketbase";
  supports: Readonly<Record<PocketBaseCapability, boolean>>;
}

function commonCapability(capability: PocketBaseCapability): AdapterCapability {
  if (capability === "event.replay" || capability === "memory.persistence") return capability;
  if (capability === "run-event.persistence") return "event.replay";
  if (capability === "durable-approvals" || capability === "approval.continuation") return "durable-approvals";
  if (capability === "run.persistence") return "run.outcome.persistence";
  if (capability === "multi-process-concurrency" || capability === "transactions" || capability === "idempotency" || capability === "conditional-updates" || capability === "approval.atomic-decision" || capability === "approval.atomic-claim" || capability === "call-id.idempotency") return "multi-process-concurrency";
  return "session.persistence";
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
  /** True only when the injected transaction is atomic across adapter processes. */
  readonly multiProcessSafe?: boolean;
}

export interface PocketBaseAtomicClaimPort {
  /** Atomically creates or conditionally updates a claim. */
  claim(
    collection: PocketBaseCollectionPort,
    id: string,
    expected: Readonly<Record<string, unknown>>,
    data: Record<string, unknown>,
  ): Promise<PocketBaseStoredRecord | undefined>;
  /** Whether the claim is guaranteed across processes/instances. */
  readonly multiProcessSafe?: boolean;
}

export interface PocketBaseIdempotencyPort {
  execute<T>(key: string, operation: () => Promise<T>): Promise<T>;
  readonly multiProcessSafe?: boolean;
}

export interface PocketBaseConditionalUpdatePort {
  update(
    collection: PocketBaseCollectionPort,
    id: string,
    expected: Readonly<Record<string, unknown>>,
    data: Record<string, unknown>,
  ): Promise<PocketBaseStoredRecord | undefined>;
  readonly multiProcessSafe?: boolean;
}

export interface PocketBaseCollectionNames {
  agents?: string | null;
  projects?: string | null;
  sessions?: string | null;
  approvals?: string | null;
  audits?: string | null;
  events?: string | null;
  memories?: string | null;
  skills?: string | null;
  skillVersions?: string | null;
  transcripts?: string | null;
  runs?: string | null;
  runEvents?: string | null;
  tools?: string | null;
  policies?: string | null;
  continuations?: string | null;
  callClaims?: string | null;
}

export interface PocketBaseAdapterOptions {
  client: PocketBaseClientPort;
  collections?: PocketBaseCollectionNames;
  eventReplay?: boolean;
  transaction?: PocketBaseTransactionPort;
  idempotency?: PocketBaseIdempotencyPort;
  conditionalUpdate?: PocketBaseConditionalUpdatePort;
  atomicClaim?: PocketBaseAtomicClaimPort;
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
  /** Encrypted/opaque continuation material. The adapter never decrypts or logs it. */
  continuation?: OpaqueContinuation;
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
  claim(ownerId: string, approvalId: string, callId: string): Promise<ApprovalClaim>;
}

export interface AuditRepository {
  append(ownerId: string, record: AuditRecord): Promise<AuditRecord>;
  list(ownerId: string): Promise<AuditRecord[]>;
}

export interface EventRepository {
  publish<T extends JsonValue>(ownerId: string, event: DomainEvent<T>): Promise<PublishedEvent<T>>;
  replay(ownerId: string, options?: EventReplayOptions): Promise<PublishedEvent[]>;
}

export interface MemoryRepository {
  list(ownerId: string, limit?: number): Promise<MemoryRecord[]>;
  save(ownerId: string, record: Omit<MemoryRecord, "ownerId">): Promise<MemoryRecord>;
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
  readonly transcripts: CanonicalTranscriptRepository;
  readonly runs: RunRepository;
  readonly runEvents: RunEventRepository;
  readonly tools: ToolDefinitionRepository;
  readonly policies: ToolPolicyRepository;
  readonly approvals: ApprovalRepository;
  readonly continuations: ApprovalContinuationRepository;
  readonly claims: ApprovalClaimRepository;
  readonly callIds: CallIdempotencyRepository;
  readonly audits: AuditRepository;
  readonly events: EventRepository;
  readonly memories: MemoryRepository;
  readonly skills: SkillRepository;
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

function skillKey(skill: Pick<Skill, "id" | "scope" | "agentId" | "projectId">): string {
  return JSON.stringify([skill.id, skill.scope, skill.agentId ?? null, skill.projectId ?? null]);
}

function mapSkill(record: PocketBaseStoredRecord, trustedOwner?: string): Skill {
  const skill = {
    id: asString(record, "skillId"),
    ownerId: trustedOwner ?? asString(record, "ownerId"),
    name: asString(record, "name"),
    scope: asString(record, "scope"),
    mode: asString(record, "mode"),
    version: record.version,
    metadata: asJson(record, "metadata", {}) as Record<string, string>,
    body: asString(record, "body"),
    reference: asOptionalString(record, "reference"),
    ...(record.agentId === undefined ? {} : { agentId: asString(record, "agentId") }),
    ...(record.projectId === undefined ? {} : { projectId: asString(record, "projectId") }),
  } as Skill;
  try { return clone(assertValidSkill(skill)); } catch (error) { throw new Error(`Invalid PocketBase skill: ${(error as Error).message}`); }
}

function skillData(skill: Skill, ownerId: string): Record<string, unknown> {
  return {
    ownerId,
    skillId: skill.id,
    name: skill.name,
    scope: skill.scope,
    mode: skill.mode,
    version: skill.version,
    metadata: clone(skill.metadata),
    body: skill.body,
    ...(skill.reference === undefined ? {} : { reference: skill.reference }),
    ...(skill.agentId === undefined ? {} : { agentId: skill.agentId }),
    ...(skill.projectId === undefined ? {} : { projectId: skill.projectId }),
  };
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

function memoryScope(value: unknown): MemoryScope {
  if (value === "user" || value === "agent" || value === "project") return value;
  throw new Error("PocketBase memory has an invalid scope");
}

function mapMemory(record: PocketBaseStoredRecord, trustedOwner: string): MemoryRecord {
  const scope = memoryScope(record.scope);
  const tombstone = record.tombstone;
  if (typeof tombstone !== "boolean") throw new Error("PocketBase memory has an invalid tombstone");
  const version = record.version;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) throw new Error("PocketBase memory has an invalid version");
  return {
    id: requireText(record.id, "recordId"),
    ownerId: trustedOwner,
    scope,
    ...(scope === "agent" ? { agentId: requireText(record.agentId as string, "agentId") } : {}),
    ...(scope === "project" ? { projectId: requireText(record.projectId as string, "projectId") } : {}),
    content: asString(record, "content"),
    metadata: asJson(record, "metadata", null),
    createdAt: asString(record, "createdAt"),
    updatedAt: asString(record, "updatedAt"),
    version,
    tombstone,
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
  const memoryCollection = collection(configuredCollectionName(options.collections, "memories"));
  const skillCollection = collection(configuredCollectionName(options.collections, "skills"));
  const skillVersionCollection = collection(configuredCollectionName(options.collections, "skillVersions"));
  const target = createPocketBaseTargetPersistence({
    client: options.client,
    collections: options.collections,
    now,
    transaction: options.transaction,
    idempotency: options.idempotency,
    conditionalUpdate: options.conditionalUpdate,
    atomicClaim: options.atomicClaim,
    unsupported: (capability) => {
      const aliases: Record<string, PocketBaseCapability> = {
        "transcripts.persistence": "transcript.persistence",
        "runs.persistence": "run.persistence",
        "runEvents.persistence": "run-event.persistence",
        "tools.persistence": "tool.persistence",
        "policies.persistence": "policy.persistence",
        "continuations.persistence": "approval.continuation",
        "callClaims.persistence": "call-id.idempotency",
      };
      return new PocketBaseUnsupportedCapabilityError(aliases[capability] ?? capability as PocketBaseCapability);
    },
  });

  const supports: Record<PocketBaseCapability, boolean> = {
    "agent.persistence": Boolean(agentCollection),
    "project.persistence": Boolean(projectCollection),
    "session.persistence": Boolean(sessionCollection),
    "durable-approvals": Boolean(approvalCollection),
    "audit.persistence": Boolean(auditCollection),
    "event.publication": Boolean(eventCollection),
    // Adapter-level replay refers to the published domain-event repository.
    "event.replay": Boolean(eventCollection) && options.eventReplay === true,
    "run-event.persistence": Boolean(configuredCollectionName(options.collections, "runEvents")),
    transactions: Boolean(options.transaction),
    idempotency: Boolean(options.idempotency),
    "conditional-updates": Boolean(options.conditionalUpdate),
    "approval.atomic-decision": Boolean(approvalCollection && (options.transaction || options.idempotency || options.conditionalUpdate)),
    "multi-process-concurrency": Boolean(options.atomicClaim?.multiProcessSafe || options.transaction?.multiProcessSafe || options.conditionalUpdate?.multiProcessSafe || options.idempotency?.multiProcessSafe),
    "memory.persistence": Boolean(memoryCollection),
    "skill.persistence": Boolean(skillCollection && skillVersionCollection),
    "transcript.persistence": Boolean(configuredCollectionName(options.collections, "transcripts")),
    "run.persistence": Boolean(configuredCollectionName(options.collections, "runs")),
    "tool.persistence": Boolean(configuredCollectionName(options.collections, "tools")),
    "policy.persistence": Boolean(configuredCollectionName(options.collections, "policies")),
    "approval.continuation": Boolean(configuredCollectionName(options.collections, "continuations")),
    "approval.atomic-claim": Boolean(configuredCollectionName(options.collections, "continuations") && (options.atomicClaim || options.conditionalUpdate || options.transaction)),
    "call-id.idempotency": Boolean(configuredCollectionName(options.collections, "callClaims") || options.idempotency),
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
      if (input.continuation !== undefined) {
        await target.continuations.put(scopedOwner, input.approvalId, input.callId, input.continuation);
      }
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
    async claim(ownerId, approvalId, callId) {
      return target.claims.claim(owner(ownerId), requireText(approvalId, "approvalId"), requireText(callId, "callId"));
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

  const memories: MemoryRepository = {
    async list(ownerId, limit = 50) {
      const scopedOwner = owner(ownerId);
      const records = await ownedRecords(requireCollection(memoryCollection, "memory.persistence"), scopedOwner);
      return records.filter((item) => mapMemory(item, scopedOwner).tombstone === false).slice(0, Math.min(Math.max(Math.trunc(limit), 1), 50)).map((item) => mapMemory(item, scopedOwner));
    },
    async save(ownerId, input) {
      const scopedOwner = owner(ownerId); const collection = requireCollection(memoryCollection, "memory.persistence");
      const scope = memoryScope(input.scope);
      requireText(input.content, "content");
      if (!Number.isSafeInteger(input.version) || input.version < 1) throw new Error("Invalid memory version");
      if (typeof input.tombstone !== "boolean") throw new Error("Invalid memory tombstone");
      const data: Record<string, unknown> = {
        ownerId: scopedOwner,
        scope,
        content: input.content,
        metadata: redactJson(input.metadata),
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
        version: input.version,
        tombstone: input.tombstone,
      };
      if (scope === "agent") data.agentId = requireText(input.agentId as string, "agentId");
      if (scope === "project") data.projectId = requireText(input.projectId as string, "projectId");
      const created = await collection.create(data);
      return { ...input, ownerId: scopedOwner, id: requireText(created.id, "recordId"), scope };
    },
  };

  const skills: SkillRepository = {
    async list(ownerId, input = {}) {
      const scopedOwner = owner(ownerId);
      const records = await ownedRecords(requireCollection(skillCollection, "skill.persistence"), scopedOwner);
      return listSkills(records.map((record) => mapSkill(record, scopedOwner)), input).map(clone);
    },
    async get(ownerId, id, input = {}) {
      const scopedOwner = owner(ownerId);
      requireText(id, "id");
      const heads = await ownedRecords(requireCollection(skillCollection, "skill.persistence"), scopedOwner);
      const matches = heads.filter((record) => record.skillId === id &&
        (input.scope === undefined || record.scope === input.scope) && (input.agentId === undefined || record.agentId === input.agentId) && (input.projectId === undefined || record.projectId === input.projectId));
      const scoped = input.scope === undefined && input.agentId === undefined && input.projectId === undefined ? matches.filter((record) => record.scope === "global") : matches;
      if (input.version === undefined) {
        if (!scoped[0]) throw new SkillNotFoundError(`skill ${id} was not found for owner ${scopedOwner}`);
        return mapSkill(scoped[0], scopedOwner);
      }
      const versions = await ownedRecords(requireCollection(skillVersionCollection, "skill.persistence"), scopedOwner);
      const version = versions.find((record) => record.skillId === id && record.version === input.version &&
        (input.scope === undefined || record.scope === input.scope) && (input.agentId === undefined || record.agentId === input.agentId) && (input.projectId === undefined || record.projectId === input.projectId));
      if (!version) throw new SkillNotFoundError(`skill ${id} version ${input.version} was not found for owner ${scopedOwner}`);
      return mapSkill(version, scopedOwner);
    },
    async create(ownerId, input) {
      const scopedOwner = owner(ownerId);
      const skill = createSkill({ ...input, ownerId: input.ownerId ?? scopedOwner });
      if (skill.ownerId !== scopedOwner) throw new SkillValidationError(["ownerId is immutable"]);
      const skills = requireCollection(skillCollection, "skill.persistence");
      const versions = requireCollection(skillVersionCollection, "skill.persistence");
      const existing = (await skills.list()).find((record) => record.ownerId === scopedOwner && record.identityKey === skillKey(skill));
      if (existing) throw new SkillConflictError(`skill ${skill.id} already exists for this scope`);
      const data = skillData(skill, scopedOwner);
      const created = await skills.create({ ...data, identityKey: skillKey(skill) });
      await versions.create({ ...data, skillHeadId: created.id });
      return mapSkill(created, scopedOwner);
    },
    async update(ownerId, input) {
      const scopedOwner = owner(ownerId);
      const skills = requireCollection(skillCollection, "skill.persistence");
      const versions = requireCollection(skillVersionCollection, "skill.persistence");
      const heads = await skills.list();
      const candidates = heads.filter((record) => record.ownerId === scopedOwner && record.skillId === input.id &&
        (input.scope === undefined || record.scope === input.scope) && (input.agentId === undefined || record.agentId === input.agentId) && (input.projectId === undefined || record.projectId === input.projectId));
      const currentRecord = candidates.at(-1) ?? heads.filter((record) => record.ownerId === scopedOwner && record.skillId === input.id).at(-1);
      if (!currentRecord) throw new SkillNotFoundError(`skill ${input.id} was not found for owner ${scopedOwner}`);
      const current = mapSkill(currentRecord, scopedOwner);
      if (input.version !== current.version + 1) throw new SkillConflictError("version must be exactly the next version");
      const next = updateSkill(current, input);
      const payload = { ...skillData(next, scopedOwner), identityKey: skillKey(next) };
      const updated = options.conditionalUpdate
        ? await options.conditionalUpdate.update(skills, currentRecord.id, { ownerId: scopedOwner, skillId: current.id, version: current.version }, payload)
        : await skills.update(currentRecord.id, payload);
      if (!updated) throw new SkillConflictError("skill has a stale version");
      await versions.create({ ...skillData(next, scopedOwner), skillHeadId: currentRecord.id });
      return mapSkill(updated, scopedOwner);
    },
    async resolve(ownerId, input): Promise<readonly EffectiveSkill[]> {
      return resolveEffectiveSkills({ ...input, skills: await this.list(ownerId, { includeDisabled: true }) });
    },
  };

  return {
    capabilities,
    agents,
    projects,
    sessions,
    transcripts: target.transcripts,
    runs: target.runs,
    runEvents: target.runEvents,
    tools: target.tools,
    policies: target.policies,
    approvals,
    continuations: target.continuations,
    claims: target.claims,
    callIds: target.callIds,
    audits,
    events,
    memories,
    skills,
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
export function createPocketBaseRunStore(
  adapter: Pick<PocketBaseAdapter, "capabilities" | "runs">,
  ownerId: string,
): RunStore {
  const scopedOwner = owner(ownerId);
  return {
    capabilities: {
      adapter: adapter.capabilities.adapter,
      durability: "remote",
      supports: { "run.outcome.persistence": adapter.capabilities.supports["run.persistence"] },
    },
    load: (runId) => adapter.runs.load(scopedOwner, runId),
    save: async (outcome: RunOutcome) => { await adapter.runs.save(scopedOwner, outcome); },
  };
}

export function createPocketBaseEventReplayPort(
  adapter: Pick<PocketBaseAdapter, "capabilities" | "runEvents">,
  ownerId: string,
): EventReplayPort {
  const scopedOwner = owner(ownerId);
  return {
    capabilities: {
      adapter: adapter.capabilities.adapter,
      durability: "remote",
      supports: { "event.replay": adapter.capabilities.supports["run-event.persistence"] === true },
    },
    append: async (event: RunEvent) => { await adapter.runEvents.append(scopedOwner, event); },
    replay: (runId) => adapter.runEvents.replay(scopedOwner, runId),
  };
}

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

/** Bind owner-scoped PocketBase approval records to the ownerless core port. */
export function createPocketBaseApprovalStore(
  adapter: Pick<PocketBaseAdapter, "approvals">,
  ownerId: string,
): ApprovalStore {
  const scopedOwner = owner(ownerId);
  const map = (record: ApprovalRecord): CoreApprovalRecord => ({
    approvalId: record.approvalId,
    callId: record.callId,
    toolId: record.toolId,
    request: clone(record.request),
    status: record.status,
    ...(record.decidedBy === undefined ? {} : { decidedBy: record.decidedBy }),
    ...(record.reason === undefined ? {} : { reason: record.reason }),
    createdAt: record.createdAt,
    ...(record.decidedAt === undefined ? {} : { decidedAt: record.decidedAt }),
  });
  return {
    load: async (approvalId) => {
      const record = await adapter.approvals.get(scopedOwner, approvalId);
      return record ? map(record) : undefined;
    },
    create: async (request: ApprovalRequest) => map(await adapter.approvals.create(scopedOwner, {
      approvalId: request.approvalId,
      callId: request.call.callId,
      toolId: request.definition.id,
      request: redactJson(request),
    })),
    decide: async (approvalId: string, decision: ApprovalDecision) => map(await adapter.approvals.decide(scopedOwner, approvalId, decision)),
  };
}

export function createPocketBaseApprovalContinuationPort(
  adapter: Pick<PocketBaseAdapter, "continuations">,
  ownerId: string,
): ApprovalContinuationPort {
  const scopedOwner = owner(ownerId);
  return {
    put: (approvalId, callId, continuation) => adapter.continuations.put(scopedOwner, approvalId, callId, continuation),
    load: (approvalId) => adapter.continuations.get(scopedOwner, approvalId),
  };
}

export function createPocketBaseApprovalClaimPort(
  adapter: Pick<PocketBaseAdapter, "claims">,
  ownerId: string,
): ApprovalClaimPort {
  const scopedOwner = owner(ownerId);
  return { claim: (approvalId, callId) => adapter.claims.claim(scopedOwner, approvalId, callId) };
}

export function createPocketBaseIdempotencyPort(
  adapter: Pick<PocketBaseAdapter, "callIds">,
  ownerId: string,
): IdempotencyPort {
  const scopedOwner = owner(ownerId);
  return { execute: (key, operation) => adapter.callIds.execute(scopedOwner, key, operation) };
}

export function createPocketBaseAuditPort(
  adapter: Pick<PocketBaseAdapter, "audits">,
  ownerId: string,
): AuditPort {
  const scopedOwner = owner(ownerId);
  return { append: async (event) => { await adapter.audits.append(scopedOwner, event.data); } };
}

/**
 * Compose all durable gateway ports with one authenticated owner. The core
 * remains independent of PocketBase; callers spread these ports into the core
 * gateway options and supply only definitions, policy rules, and an executor.
 */
export function createPocketBaseGatewayPorts(
  adapter: Pick<PocketBaseAdapter, "approvals" | "continuations" | "claims" | "callIds" | "audits">,
  ownerId: string,
) {
  const approvalStore = createPocketBaseApprovalStore(adapter, ownerId);
  const continuationPort = createPocketBaseApprovalContinuationPort(adapter, ownerId);
  const approvalClaimPort = createPocketBaseApprovalClaimPort(adapter, ownerId);
  const idempotency = createPocketBaseIdempotencyPort(adapter, ownerId);
  const auditPort = createPocketBaseAuditPort(adapter, ownerId);
  return { approvalStore, continuationPort, approvalClaimPort, idempotency, auditPort };
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
