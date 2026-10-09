/**
 * Owner-scoped PocketBase persistence for first-class automations.
 *
 * This adapter deliberately stores orchestration records only. Agent output and
 * transcripts remain in the canonical Subpolar run/session stores; an execution
 * references that canonical run by ID. Trigger delivery is at-least-once. A
 * deployment only gets cross-process-safe occurrence claiming when it injects
 * an atomic claim or conditional update implementation with that guarantee.
 */
import type {
  PocketBaseAtomicClaimPort,
  PocketBaseClientPort,
  PocketBaseCollectionPort,
  PocketBaseConditionalUpdatePort,
  PocketBaseStoredRecord,
} from "./index.ts";
import type {
  AutomationRepository,
  AutomationExecutionStore,
  ClaimedOccurrence,
  TriggerOccurrenceRepository,
} from "../../subpolar-automations/src/ports.ts";
import type {
  ActionDefinition,
  ActionExecution,
  ActionExecutionStatus,
  AutomationDefinition,
  AutomationExecution,
  AutomationInput,
  AutomationExecutionStatus,
  AutomationUpdate,
  TriggerInput,
  TriggerOccurrence,
} from "../../subpolar-automations/src/types.ts";

export type AutomationJson = null | boolean | number | string | AutomationJson[] | { [key: string]: AutomationJson };
export type AutomationStatus =
  | "pending"
  | "running"
  | "waiting_approval"
  | "processing_output"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "unknown";
export type OccurrenceStatus = "pending" | "claimed" | "completed" | "failed" | "cancelled" | "unknown";
export type ActionStatus = "pending" | "running" | "completed" | "failed" | "skipped" | "unknown";

/** Secret material must be represented by a reference, never a credential value. */
export interface AutomationDefinitionRecord {
  id: string;
  ownerId: string;
  name: string;
  description?: string;
  enabled: boolean;
  agentId: string;
  promptTemplate: string;
  projectId?: string;
  trigger: AutomationJson;
  actions: AutomationJson[];
  executionConfig: AutomationJson;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface TriggerOccurrenceRecord {
  id: string;
  ownerId: string;
  automationId: string;
  occurrenceKey: string;
  triggerType: string;
  trigger?: AutomationJson;
  payload?: AutomationJson;
  scheduledAt?: string;
  receivedAt: string;
  status: OccurrenceStatus;
  executionId?: string;
  claimedAt?: string;
  completedAt?: string;
  error?: AutomationJson;
}

export interface AutomationExecutionRecord {
  id: string;
  ownerId: string;
  automationId: string;
  agentId: string;
  projectId?: string;
  occurrenceId: string;
  occurrenceKey?: string;
  trigger?: AutomationJson;
  /** Reference to the canonical Subpolar run. Never duplicate its transcript here. */
  canonicalRunId?: string;
  resolvedInput: AutomationJson;
  status: AutomationStatus;
  output?: AutomationJson;
  error?: AutomationJson;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface ActionExecutionRecord {
  id: string;
  ownerId: string;
  executionId: string;
  actionId: string;
  actionType: string;
  ordinal: number;
  status: ActionStatus;
  input?: AutomationJson;
  result?: AutomationJson;
  error?: AutomationJson;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface AutomationScheduleState {
  ownerId: string;
  automationId: string;
  /** The next due instant/cursor is advisory; occurrence indexes remain the dedupe authority. */
  nextRunAt?: string;
  lastRunAt?: string;
  lastOccurrenceKey?: string;
  updatedAt: string;
}

export interface AutomationDefinitionInput extends Omit<AutomationDefinitionRecord, "deletedAt"> {}
export interface AutomationDefinitionPatch extends Partial<Pick<AutomationDefinitionRecord,
  "name" | "description" | "enabled" | "agentId" | "promptTemplate" | "projectId" | "trigger" | "actions" | "executionConfig" | "updatedAt"
>> {}
export interface AutomationExecutionPatch extends Partial<Pick<AutomationExecutionRecord,
  "canonicalRunId" | "resolvedInput" | "status" | "output" | "error" | "startedAt" | "completedAt"
>> {}
export interface OccurrencePatch extends Partial<Pick<TriggerOccurrenceRecord,
  "status" | "executionId" | "claimedAt" | "completedAt" | "error"
>> {}
export interface ActionExecutionPatch extends Partial<Pick<ActionExecutionRecord,
  "status" | "input" | "result" | "error" | "startedAt" | "completedAt"
>> {}

export interface OccurrenceClaimResult {
  claimed: boolean;
  occurrence: TriggerOccurrenceRecord;
  /** False means the adapter cannot promise exclusion across app processes. */
  multiProcessSafe: boolean;
}

export interface AutomationPersistencePort {
  definitions: {
    create(ownerId: string, input: AutomationDefinitionInput): Promise<AutomationDefinitionRecord>;
    get(ownerId: string, automationId: string): Promise<AutomationDefinitionRecord | undefined>;
    list(ownerId: string, options?: { includeDeleted?: boolean }): Promise<AutomationDefinitionRecord[]>;
    update(ownerId: string, automationId: string, patch: AutomationDefinitionPatch): Promise<AutomationDefinitionRecord | undefined>;
    remove(ownerId: string, automationId: string): Promise<AutomationDefinitionRecord | undefined>;
  };
  occurrences: {
    /** Insert or retrieve by stable (owner, automation, occurrenceKey). */
    getOrCreate(ownerId: string, input: Omit<TriggerOccurrenceRecord, "id" | "ownerId">): Promise<TriggerOccurrenceRecord>;
    get(ownerId: string, occurrenceId: string): Promise<TriggerOccurrenceRecord | undefined>;
    list(ownerId: string, automationId: string, limit?: number): Promise<TriggerOccurrenceRecord[]>;
    claim(ownerId: string, occurrenceId: string, claimedAt: string, executionId: string): Promise<OccurrenceClaimResult>;
    update(ownerId: string, occurrenceId: string, patch: OccurrencePatch): Promise<TriggerOccurrenceRecord | undefined>;
  };
  executions: {
    create(ownerId: string, input: Omit<AutomationExecutionRecord, "id" | "ownerId" | "createdAt" | "updatedAt"> & { id: string }): Promise<AutomationExecutionRecord>;
    get(ownerId: string, executionId: string): Promise<AutomationExecutionRecord | undefined>;
    list(ownerId: string, automationId: string, limit?: number): Promise<AutomationExecutionRecord[]>;
    update(ownerId: string, executionId: string, patch: AutomationExecutionPatch): Promise<AutomationExecutionRecord | undefined>;
  };
  actions: {
    create(ownerId: string, input: Omit<ActionExecutionRecord, "ownerId" | "createdAt" | "updatedAt">): Promise<ActionExecutionRecord>;
    get(ownerId: string, actionExecutionId: string): Promise<ActionExecutionRecord | undefined>;
    list(ownerId: string, executionId: string): Promise<ActionExecutionRecord[]>;
    update(ownerId: string, actionExecutionId: string, patch: ActionExecutionPatch): Promise<ActionExecutionRecord | undefined>;
  };
  schedules: {
    get(ownerId: string, automationId: string): Promise<AutomationScheduleState | undefined>;
    set(ownerId: string, state: Omit<AutomationScheduleState, "updatedAt">): Promise<AutomationScheduleState>;
  };
  capabilities: { atomicOccurrenceClaims: boolean; multiProcessSafe: boolean };
}

export interface PocketBaseAutomationCollections {
  definitions?: string | null;
  occurrences?: string | null;
  executions?: string | null;
  actions?: string | null;
  schedules?: string | null;
}

export interface PocketBaseAutomationPersistenceOptions {
  client: PocketBaseClientPort;
  collections?: PocketBaseAutomationCollections;
  now?: () => Date;
  atomicClaim?: PocketBaseAtomicClaimPort;
  conditionalUpdate?: PocketBaseConditionalUpdatePort;
}

export class AutomationAtomicClaimUnsupportedError extends Error {
  readonly code = "AUTOMATION_ATOMIC_CLAIM_UNSUPPORTED";
  constructor() {
    super("Atomic automation occurrence claims are unavailable; configure an atomic claim or conditional update adapter");
    this.name = "AutomationAtomicClaimUnsupportedError";
  }
}

const secretKey = /(access[_-]?token|api[_-]?key|authorization|bearer|client[_-]?secret|cookie|credential|password|private[_-]?key|secret|session[_-]?token|set-cookie|token)/i;
const statuses = new Set<AutomationStatus>(["pending", "running", "waiting_approval", "processing_output", "completed", "failed", "cancelled", "interrupted", "unknown"]);

function sanitize(value: unknown, key?: string): AutomationJson {
  if (key && secretKey.test(key) && !/(?:ref|reference)$/i.test(key)) return "[REDACTED]";
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === "object") {
    const result: Record<string, AutomationJson> = {};
    for (const [field, item] of Object.entries(value)) result[field] = sanitize(item, field);
    return result;
  }
  return `[${typeof value}]`;
}

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value;
}

function iso(value: unknown, field: string): string {
  const result = required(value, field);
  if (Number.isNaN(Date.parse(result))) throw new Error(`${field} must be an ISO timestamp`);
  return result;
}

function json(record: PocketBaseStoredRecord, field: string, fallback: unknown = null): AutomationJson {
  return sanitize(record[field] === undefined ? fallback : record[field]);
}

function optionalText(record: PocketBaseStoredRecord, field: string): string | undefined {
  return record[field] === undefined || record[field] === null || record[field] === "" ? undefined : required(record[field], field);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function mapDefinition(record: PocketBaseStoredRecord): AutomationDefinitionRecord {
  const actions = json(record, "actions", []);
  if (!Array.isArray(actions)) throw new Error("actions must be an array");
  return {
    id: required(record.automationId, "automationId"),
    ownerId: required(record.ownerId, "ownerId"),
    name: required(record.name, "name"),
    ...(optionalText(record, "description") === undefined ? {} : { description: optionalText(record, "description") }),
    enabled: record.enabled === true,
    agentId: required(record.agentId, "agentId"),
    promptTemplate: required(record.promptTemplate, "promptTemplate"),
    ...(optionalText(record, "projectId") === undefined ? {} : { projectId: optionalText(record, "projectId") }),
    trigger: json(record, "trigger"),
    actions,
    executionConfig: json(record, "executionConfig", {}),
    createdAt: iso(record.createdAt, "createdAt"),
    updatedAt: iso(record.updatedAt, "updatedAt"),
    ...(optionalText(record, "deletedAt") === undefined ? {} : { deletedAt: optionalText(record, "deletedAt") }),
  };
}

function mapOccurrence(record: PocketBaseStoredRecord): TriggerOccurrenceRecord {
  const status = required(record.status, "status");
  if (!["pending", "claimed", "completed", "failed", "cancelled", "unknown"].includes(status)) throw new Error("Invalid occurrence status");
  return {
    id: required(record.occurrenceId, "occurrenceId"),
    ownerId: required(record.ownerId, "ownerId"),
    automationId: required(record.automationId, "automationId"),
    occurrenceKey: required(record.occurrenceKey, "occurrenceKey"),
    triggerType: required(record.triggerType, "triggerType"),
    ...(record.trigger === undefined ? {} : { trigger: json(record, "trigger") }),
    ...(record.payload === undefined ? {} : { payload: json(record, "payload") }),
    ...(optionalText(record, "scheduledAt") === undefined ? {} : { scheduledAt: iso(record.scheduledAt, "scheduledAt") }),
    receivedAt: iso(record.receivedAt, "receivedAt"),
    status: status as OccurrenceStatus,
    ...(optionalText(record, "executionId") === undefined ? {} : { executionId: optionalText(record, "executionId") }),
    ...(optionalText(record, "claimedAt") === undefined ? {} : { claimedAt: iso(record.claimedAt, "claimedAt") }),
    ...(optionalText(record, "completedAt") === undefined ? {} : { completedAt: iso(record.completedAt, "completedAt") }),
    ...(record.error === undefined ? {} : { error: json(record, "error") }),
  };
}

function mapExecution(record: PocketBaseStoredRecord): AutomationExecutionRecord {
  const status = required(record.status, "status");
  if (!statuses.has(status as AutomationStatus)) throw new Error("Invalid automation execution status");
  return {
    id: required(record.executionId, "executionId"),
    ownerId: required(record.ownerId, "ownerId"),
    automationId: required(record.automationId, "automationId"),
    agentId: required(record.agentId, "agentId"),
    ...(optionalText(record, "projectId") === undefined ? {} : { projectId: optionalText(record, "projectId") }),
    occurrenceId: required(record.occurrenceId, "occurrenceId"),
    ...(optionalText(record, "occurrenceKey") === undefined ? {} : { occurrenceKey: optionalText(record, "occurrenceKey") }),
    ...(record.trigger === undefined ? {} : { trigger: json(record, "trigger") }),
    ...(optionalText(record, "canonicalRunId") === undefined ? {} : { canonicalRunId: optionalText(record, "canonicalRunId") }),
    resolvedInput: json(record, "resolvedInput"),
    status: status as AutomationStatus,
    ...(record.output === undefined ? {} : { output: json(record, "output") }),
    ...(record.error === undefined ? {} : { error: json(record, "error") }),
    createdAt: iso(record.createdAt, "createdAt"),
    updatedAt: iso(record.updatedAt, "updatedAt"),
    ...(optionalText(record, "startedAt") === undefined ? {} : { startedAt: iso(record.startedAt, "startedAt") }),
    ...(optionalText(record, "completedAt") === undefined ? {} : { completedAt: iso(record.completedAt, "completedAt") }),
  };
}

function mapAction(record: PocketBaseStoredRecord): ActionExecutionRecord {
  const status = required(record.status, "status");
  if (!["pending", "running", "completed", "failed", "skipped", "unknown"].includes(status)) throw new Error("Invalid action status");
  const ordinal = record.ordinal;
  if (typeof ordinal !== "number" || !Number.isSafeInteger(ordinal) || ordinal < 0) throw new Error("Invalid action ordinal");
  return {
    id: required(record.actionExecutionId, "actionExecutionId"),
    ownerId: required(record.ownerId, "ownerId"),
    executionId: required(record.executionId, "executionId"),
    actionId: required(record.actionId, "actionId"),
    actionType: required(record.actionType, "actionType"),
    ordinal,
    status: status as ActionStatus,
    ...(record.input === undefined ? {} : { input: json(record, "input") }),
    ...(record.result === undefined ? {} : { result: json(record, "result") }),
    ...(record.error === undefined ? {} : { error: json(record, "error") }),
    createdAt: iso(record.createdAt, "createdAt"),
    updatedAt: iso(record.updatedAt, "updatedAt"),
    ...(optionalText(record, "startedAt") === undefined ? {} : { startedAt: iso(record.startedAt, "startedAt") }),
    ...(optionalText(record, "completedAt") === undefined ? {} : { completedAt: iso(record.completedAt, "completedAt") }),
  };
}

function mapSchedule(record: PocketBaseStoredRecord): AutomationScheduleState {
  return {
    ownerId: required(record.ownerId, "ownerId"),
    automationId: required(record.automationId, "automationId"),
    ...(optionalText(record, "nextRunAt") === undefined ? {} : { nextRunAt: iso(record.nextRunAt, "nextRunAt") }),
    ...(optionalText(record, "lastRunAt") === undefined ? {} : { lastRunAt: iso(record.lastRunAt, "lastRunAt") }),
    ...(optionalText(record, "lastOccurrenceKey") === undefined ? {} : { lastOccurrenceKey: optionalText(record, "lastOccurrenceKey") }),
    updatedAt: iso(record.updatedAt, "updatedAt"),
  };
}

function ownerMatches(record: PocketBaseStoredRecord, ownerId: string): boolean {
  return record.ownerId === ownerId;
}

function isDeleted(record: PocketBaseStoredRecord): boolean {
  return record.deletedAt !== undefined && record.deletedAt !== null && record.deletedAt !== "";
}

function updateJson(source: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) result[key] = value && typeof value === "object" ? sanitize(value) : value;
  }
  return result;
}

function collection(client: PocketBaseClientPort, configured: string | null | undefined, fallback: string): PocketBaseCollectionPort {
  if (configured === null) throw new Error(`PocketBase automation collection ${fallback} is disabled`);
  return client.collection(configured ?? fallback);
}

function findBy(collection: PocketBaseCollectionPort, ownerId: string, field: string, value: string): Promise<PocketBaseStoredRecord | undefined> {
  return collection.list().then((records) => records.find((record) => ownerMatches(record, ownerId) && record[field] === value));
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined) return 100;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
  return Math.min(limit, 500);
}

export function createPocketBaseAutomationPersistence(options: PocketBaseAutomationPersistenceOptions): AutomationPersistencePort {
  const now = options.now ?? (() => new Date());
  const definitions = collection(options.client, options.collections?.definitions, "subpolar_automations");
  const occurrences = collection(options.client, options.collections?.occurrences, "subpolar_automation_occurrences");
  const executions = collection(options.client, options.collections?.executions, "subpolar_automation_executions");
  const actions = collection(options.client, options.collections?.actions, "subpolar_automation_action_executions");
  const schedules = collection(options.client, options.collections?.schedules, "subpolar_automation_schedules");

  async function owned(collectionPort: PocketBaseCollectionPort, ownerId: string, field: string, value: string) {
    const record = await findBy(collectionPort, ownerId, field, value);
    return record ? clone(record) : undefined;
  }

  async function updateOwned<T>(collectionPort: PocketBaseCollectionPort, ownerId: string, idField: string, id: string, patch: Record<string, unknown>, mapper: (record: PocketBaseStoredRecord) => T): Promise<T | undefined> {
    const current = await owned(collectionPort, ownerId, idField, id);
    if (!current) return undefined;
    const updated = await collectionPort.update(current.id, updateJson({ ...patch, updatedAt: now().toISOString() }));
    return updated && ownerMatches(updated, ownerId) ? mapper(updated) : undefined;
  }

  const multiProcessSafe = Boolean(options.atomicClaim?.multiProcessSafe || options.conditionalUpdate?.multiProcessSafe);
  const atomicAvailable = Boolean(options.atomicClaim || options.conditionalUpdate);

  return {
    capabilities: { atomicOccurrenceClaims: atomicAvailable, multiProcessSafe },
    definitions: {
      async create(ownerId, input) {
        required(ownerId, "ownerId");
        required(input.id, "id");
        required(input.agentId, "agentId");
        const timestamp = now().toISOString();
        const created = await definitions.create({
          automationId: input.id,
          ownerId,
          name: required(input.name, "name"),
          description: input.description,
          enabled: input.enabled,
          agentId: input.agentId,
          promptTemplate: required(input.promptTemplate, "promptTemplate"),
          projectId: input.projectId,
          trigger: sanitize(input.trigger),
          actions: sanitize(input.actions),
          executionConfig: sanitize(input.executionConfig),
          createdAt: input.createdAt ?? timestamp,
          updatedAt: input.updatedAt ?? timestamp,
        });
        return mapDefinition(created);
      },
      async get(ownerId, automationId) {
        const record = await owned(definitions, ownerId, "automationId", automationId);
        return record && !isDeleted(record) ? mapDefinition(record) : undefined;
      },
      async list(ownerId, opts) {
        const includeDeleted = opts?.includeDeleted === true;
        const records = await definitions.list();
        return records.filter((record) => ownerMatches(record, ownerId) && (includeDeleted || !isDeleted(record)))
          .map(mapDefinition).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      },
      async update(ownerId, automationId, patch) {
        const current = await owned(definitions, ownerId, "automationId", automationId);
        if (!current || isDeleted(current)) return undefined;
        const data = updateJson({
          ...patch,
          ...(patch.trigger === undefined ? {} : { trigger: sanitize(patch.trigger) }),
          ...(patch.actions === undefined ? {} : { actions: sanitize(patch.actions) }),
          ...(patch.executionConfig === undefined ? {} : { executionConfig: sanitize(patch.executionConfig) }),
          updatedAt: patch.updatedAt ?? now().toISOString(),
        });
        const updated = await definitions.update(current.id, data);
        return updated && ownerMatches(updated, ownerId) ? mapDefinition(updated) : undefined;
      },
      async remove(ownerId, automationId) {
        const current = await owned(definitions, ownerId, "automationId", automationId);
        if (!current || current.deletedAt != null) return undefined;
        const removed = await definitions.update(current.id, { deletedAt: now().toISOString(), enabled: false, updatedAt: now().toISOString() });
        return removed && ownerMatches(removed, ownerId) ? mapDefinition(removed) : undefined;
      },
    },
    occurrences: {
      async getOrCreate(ownerId, input) {
        required(ownerId, "ownerId");
        required(input.automationId, "automationId");
        required(input.occurrenceKey, "occurrenceKey");
        const findOccurrence = () => occurrences.list().then((records) => records.find((record) => ownerMatches(record, ownerId)
          && record.automationId === input.automationId && record.occurrenceKey === input.occurrenceKey));
        const existing = await findOccurrence();
        if (existing) {
          return mapOccurrence(existing);
        }
        const data = {
          occurrenceId: crypto.randomUUID(),
          ownerId,
          ...input,
          ...(input.trigger === undefined ? {} : { trigger: sanitize(input.trigger) }),
          ...(input.payload === undefined ? {} : { payload: sanitize(input.payload) }),
          ...(input.error === undefined ? {} : { error: sanitize(input.error) }),
        };
        try {
          return mapOccurrence(await occurrences.create(data));
        } catch (error) {
          // A unique index resolves concurrent deliveries; re-read the winning row.
          const winner = await findOccurrence();
          if (winner) return mapOccurrence(winner);
          throw error;
        }
      },
      async get(ownerId, occurrenceId) {
        const record = await owned(occurrences, ownerId, "occurrenceId", occurrenceId);
        return record ? mapOccurrence(record) : undefined;
      },
      async list(ownerId, automationId, limit) {
        const max = boundedLimit(limit);
        return (await occurrences.list()).filter((record) => ownerMatches(record, ownerId) && record.automationId === automationId)
          .map(mapOccurrence).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, max);
      },
      async claim(ownerId, occurrenceId, claimedAt, executionId) {
        const current = await owned(occurrences, ownerId, "occurrenceId", occurrenceId);
        if (!current) throw new Error("Trigger occurrence not found");
        const mapped = mapOccurrence(current);
        if (mapped.status !== "pending") return { claimed: false, occurrence: mapped, multiProcessSafe };
        const patch = { status: "claimed", claimedAt: iso(claimedAt, "claimedAt"), executionId };
        let updated: PocketBaseStoredRecord | undefined;
        if (options.atomicClaim) {
          updated = await options.atomicClaim.claim(occurrences, current.id, {
            ownerId,
            occurrenceId,
            status: "pending",
          }, patch);
        } else if (options.conditionalUpdate) {
          updated = await options.conditionalUpdate.update(occurrences, current.id, {
            ownerId,
            occurrenceId,
            status: "pending",
          }, patch);
        } else {
          throw new AutomationAtomicClaimUnsupportedError();
        }
        if (!updated) {
          const latest = await owned(occurrences, ownerId, "occurrenceId", occurrenceId);
          if (!latest) throw new Error("Trigger occurrence disappeared during claim");
          return { claimed: false, occurrence: mapOccurrence(latest), multiProcessSafe };
        }
        return { claimed: true, occurrence: mapOccurrence(updated), multiProcessSafe };
      },
      async update(ownerId, occurrenceId, patch) {
        return updateOwned(occurrences, ownerId, "occurrenceId", occurrenceId, updateJson(patch), mapOccurrence);
      },
    },
    executions: {
      async create(ownerId, input) {
        const timestamp = now().toISOString();
        const status = input.status;
        if (!statuses.has(status)) throw new Error("Invalid automation execution status");
        const created = await executions.create({
          executionId: required(input.id, "executionId"),
          ownerId,
          automationId: required(input.automationId, "automationId"),
          agentId: required(input.agentId, "agentId"),
          projectId: input.projectId,
          occurrenceId: required(input.occurrenceId, "occurrenceId"),
          occurrenceKey: input.occurrenceKey,
          trigger: input.trigger === undefined ? undefined : sanitize(input.trigger),
          canonicalRunId: input.canonicalRunId,
          resolvedInput: sanitize(input.resolvedInput),
          status,
          output: input.output === undefined ? undefined : sanitize(input.output),
          error: input.error === undefined ? undefined : sanitize(input.error),
          startedAt: input.startedAt,
          completedAt: input.completedAt,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        return mapExecution(created);
      },
      async get(ownerId, executionId) {
        const record = await owned(executions, ownerId, "executionId", executionId);
        return record ? mapExecution(record) : undefined;
      },
      async list(ownerId, automationId, limit) {
        const max = boundedLimit(limit);
        return (await executions.list()).filter((record) => ownerMatches(record, ownerId) && record.automationId === automationId)
          .map(mapExecution).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, max);
      },
      update(ownerId, executionId, patch) {
        return updateOwned(executions, ownerId, "executionId", executionId, updateJson({
          ...patch,
          ...(patch.output === undefined ? {} : { output: sanitize(patch.output) }),
          ...(patch.error === undefined ? {} : { error: sanitize(patch.error) }),
        }), mapExecution);
      },
    },
    actions: {
      async create(ownerId, input) {
        const timestamp = now().toISOString();
        const created = await actions.create({
          executionId: input.executionId,
          actionId: input.actionId,
          actionType: input.actionType,
          ordinal: input.ordinal,
          status: input.status,
          actionExecutionId: required(input.id, "actionExecutionId"),
          ownerId,
          input: input.input === undefined ? undefined : sanitize(input.input),
          result: input.result === undefined ? undefined : sanitize(input.result),
          error: input.error === undefined ? undefined : sanitize(input.error),
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        return mapAction(created);
      },
      async get(ownerId, actionExecutionId) {
        const record = await owned(actions, ownerId, "actionExecutionId", actionExecutionId);
        return record ? mapAction(record) : undefined;
      },
      async list(ownerId, executionId) {
        return (await actions.list()).filter((record) => ownerMatches(record, ownerId) && record.executionId === executionId)
          .map(mapAction).sort((a, b) => a.ordinal - b.ordinal);
      },
      update(ownerId, actionExecutionId, patch) {
        return updateOwned(actions, ownerId, "actionExecutionId", actionExecutionId, updateJson({
          ...patch,
          ...(patch.input === undefined ? {} : { input: sanitize(patch.input) }),
          ...(patch.result === undefined ? {} : { result: sanitize(patch.result) }),
          ...(patch.error === undefined ? {} : { error: sanitize(patch.error) }),
        }), mapAction);
      },
    },
    schedules: {
      async get(ownerId, automationId) {
        const record = await findBy(schedules, ownerId, "automationId", automationId);
        return record ? mapSchedule(record) : undefined;
      },
      async set(ownerId, state) {
        const current = await findBy(schedules, ownerId, "automationId", state.automationId);
        const timestamp = now().toISOString();
        const data = updateJson({
          ownerId,
          automationId: required(state.automationId, "automationId"),
          nextRunAt: state.nextRunAt === undefined ? undefined : iso(state.nextRunAt, "nextRunAt"),
          lastRunAt: state.lastRunAt === undefined ? undefined : iso(state.lastRunAt, "lastRunAt"),
          lastOccurrenceKey: state.lastOccurrenceKey,
          updatedAt: timestamp,
        });
        const record = current
          ? await schedules.update(current.id, data)
          : await schedules.create(data);
        if (!record || !ownerMatches(record, ownerId)) throw new Error("Could not persist automation schedule state");
        return mapSchedule(record);
      },
    },
  };
}

export interface PocketBaseAutomationRepositories extends AutomationPersistencePort {
  repository: AutomationRepository;
  executionStore: AutomationExecutionStore;
  occurrenceRepository: TriggerOccurrenceRepository;
}

/** Compose the first-class domain repository ports over this package's PocketBase records. */
export function createPocketBaseAutomationRepositories(options: PocketBaseAutomationPersistenceOptions): PocketBaseAutomationRepositories {
  const store = createPocketBaseAutomationPersistence(options);
  const occurrenceCollection = collection(options.client, options.collections?.occurrences, "subpolar_automation_occurrences");
  const executionCollection = collection(options.client, options.collections?.executions, "subpolar_automation_executions");
  const actionCollection = collection(options.client, options.collections?.actions, "subpolar_automation_action_executions");
  const requireOwner = (ownerId: string) => required(ownerId, "ownerId");
  const definitionAsDomain = (value: AutomationDefinitionRecord): AutomationDefinition => ({
    id: value.id,
    ownerId: value.ownerId,
    name: value.name,
    ...(value.description === undefined ? {} : { description: value.description }),
    enabled: value.enabled,
    agentId: value.agentId,
    ...(value.projectId === undefined ? {} : { projectId: value.projectId }),
    promptTemplate: value.promptTemplate,
    ...(value.executionConfig && typeof value.executionConfig === "object" && !Array.isArray(value.executionConfig)
      ? { executionConfig: value.executionConfig as unknown as AutomationDefinition["executionConfig"] } : {}),
    trigger: value.trigger as unknown as AutomationDefinition["trigger"],
    actions: value.actions as unknown as ActionDefinition[],
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  });
  const occurrenceAsDomain = (value: TriggerOccurrenceRecord): TriggerOccurrence => ({
    id: value.id,
    ownerId: value.ownerId,
    automationId: value.automationId,
    occurrenceKey: value.occurrenceKey,
    trigger: value.trigger as unknown as TriggerInput,
    // `pending` is an internal pre-claim staging state; domain callers only see claimed or terminal rows.
    status: (value.status === "pending" ? "claimed" : value.status) as TriggerOccurrence["status"],
    ...(value.executionId === undefined ? {} : { executionId: value.executionId }),
    createdAt: value.receivedAt,
    ...(value.completedAt === undefined ? {} : { finishedAt: value.completedAt }),
  });
  const executionAsDomain = (value: AutomationExecutionRecord): AutomationExecution => ({
    id: value.id,
    ownerId: value.ownerId,
    automationId: value.automationId,
    agentId: value.agentId,
    ...(value.projectId === undefined ? {} : { projectId: value.projectId }),
    occurrenceKey: value.occurrenceKey ?? value.occurrenceId,
    trigger: value.trigger as unknown as TriggerInput,
    resolvedInput: typeof value.resolvedInput === "string" ? value.resolvedInput : JSON.stringify(value.resolvedInput),
    ...(value.canonicalRunId === undefined ? {} : { runId: value.canonicalRunId }),
    status: value.status as AutomationExecutionStatus,
    ...(value.output === undefined ? {} : { output: value.output as import("../../subpolar-automations/src/types.ts").JsonValue }),
    ...(value.error && typeof value.error === "object" && !Array.isArray(value.error)
      ? { error: value.error as unknown as AutomationExecution["error"] } : {}),
    createdAt: value.createdAt,
    ...(value.startedAt === undefined ? {} : { startedAt: value.startedAt }),
    ...(value.completedAt === undefined ? {} : { finishedAt: value.completedAt }),
  });
  const actionAsDomain = (value: ActionExecutionRecord): ActionExecution => ({
    id: value.id,
    executionId: value.executionId,
    actionId: value.actionId,
    actionType: value.actionType as ActionDefinition["type"],
    status: value.status as ActionExecutionStatus,
    ...(value.input === undefined ? {} : { input: value.input as import("../../subpolar-automations/src/types.ts").JsonValue }),
    ...(value.result === undefined ? {} : { result: value.result as import("../../subpolar-automations/src/types.ts").JsonValue }),
    ...(value.error && typeof value.error === "object" && !Array.isArray(value.error)
      ? { error: value.error as unknown as ActionExecution["error"] } : {}),
    ...(value.startedAt === undefined ? {} : { startedAt: value.startedAt }),
    ...(value.completedAt === undefined ? {} : { finishedAt: value.completedAt }),
  });
  const occurrenceExecutionId = (occurrenceId: string) => `automation-execution:${occurrenceId}`;
  const repository: AutomationRepository = {
    async get(ownerId, automationId) {
      const value = await store.definitions.get(requireOwner(ownerId), automationId);
      return value ? definitionAsDomain(value) : undefined;
    },
    async list(ownerId) {
      return (await store.definitions.list(requireOwner(ownerId))).map(definitionAsDomain);
    },
    async create(ownerId, input: AutomationInput, timestamp) {
      const created = await store.definitions.create(requireOwner(ownerId), {
        id: crypto.randomUUID(),
        ownerId,
        name: input.name,
        ...(input.description === undefined ? {} : { description: input.description }),
        enabled: input.enabled ?? true,
        agentId: input.agentId,
        promptTemplate: input.promptTemplate,
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        trigger: input.trigger as unknown as AutomationJson,
        actions: (input.actions ?? []) as unknown as AutomationJson[],
        executionConfig: (input.executionConfig ?? {}) as unknown as AutomationJson,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      return definitionAsDomain(created);
    },
    async update(ownerId, automationId, update: AutomationUpdate, timestamp) {
      const current = await store.definitions.get(requireOwner(ownerId), automationId);
      if (!current) return undefined;
      const updated = await store.definitions.update(ownerId, automationId, {
        ...update,
        ...(update.trigger === undefined ? {} : { trigger: update.trigger as unknown as AutomationJson }),
        ...(update.actions === undefined ? {} : { actions: update.actions as unknown as AutomationJson[] }),
        ...(update.executionConfig === undefined ? {} : { executionConfig: update.executionConfig as unknown as AutomationJson }),
      });
      if (!updated) return undefined;
      // Preserve domain-provided timestamp exactly.
      const raw = await store.definitions.update(ownerId, automationId, { updatedAt: timestamp });
      return definitionAsDomain(raw ?? updated);
    },
    async delete(ownerId, automationId) {
      return Boolean(await store.definitions.remove(requireOwner(ownerId), automationId));
    },
  };

  const executionStore: AutomationExecutionStore = {
    async claimOccurrence(input): Promise<ClaimedOccurrence> {
      requireOwner(input.ownerId);
      const occurrence = await store.occurrences.getOrCreate(input.ownerId, {
        automationId: input.automation.id,
        occurrenceKey: input.occurrenceKey,
        triggerType: input.trigger.kind,
        trigger: input.trigger as unknown as AutomationJson,
        payload: input.trigger.payload as AutomationJson,
        receivedAt: input.trigger.occurredAt,
        status: "pending",
      });
      const executionId = occurrence.executionId ?? occurrenceExecutionId(occurrence.id);
      const claim = occurrence.status === "pending"
        ? await store.occurrences.claim(input.ownerId, occurrence.id, input.now, executionId)
        : { claimed: false, occurrence, multiProcessSafe: store.capabilities.multiProcessSafe };
      let execution = await store.executions.get(input.ownerId, executionId);
      if (!execution) {
        execution = await store.executions.create(input.ownerId, {
          id: executionId,
          automationId: input.automation.id,
          agentId: input.automation.agentId,
          projectId: input.automation.projectId,
          occurrenceId: occurrence.id,
          occurrenceKey: input.occurrenceKey,
          trigger: input.trigger as unknown as AutomationJson,
          resolvedInput: input.resolvedInput,
          status: "pending",
        });
      }
      return {
        occurrence: occurrenceAsDomain(claim.occurrence),
        execution: executionAsDomain(execution),
        newlyClaimed: claim.claimed,
      };
    },
    async finishOccurrence(input) {
      const rawOccurrence = (await occurrenceCollection.list()).find((record) => ownerMatches(record, input.ownerId)
        && record.automationId === input.automationId && record.occurrenceKey === input.occurrenceKey
        && record.executionId === input.executionId);
      const occurrence = rawOccurrence ? mapOccurrence(rawOccurrence) : undefined;
      if (!occurrence) return undefined;
      const updated = await store.occurrences.update(input.ownerId, occurrence.id, {
        status: input.status,
        completedAt: input.now,
      });
      return updated ? occurrenceAsDomain(updated) : undefined;
    },
    async getExecution(ownerId, executionId) {
      const value = await store.executions.get(requireOwner(ownerId), executionId);
      return value ? executionAsDomain(value) : undefined;
    },
    async listExecutions(ownerId, automationId, limit) {
      return (await store.executions.list(requireOwner(ownerId), automationId, limit)).map(executionAsDomain);
    },
    async transitionExecution(input) {
      const current = await store.executions.get(requireOwner(input.ownerId), input.executionId);
      if (!current || !input.from.includes(current.status as AutomationExecutionStatus)) return undefined;
      const data: AutomationExecutionPatch = {
        status: input.to,
        ...(input.runId === undefined ? {} : { canonicalRunId: input.runId }),
        ...(input.output === undefined ? {} : { output: input.output as AutomationJson }),
        ...(input.error === undefined ? {} : { error: input.error as unknown as AutomationJson }),
        ...(input.to === "running" ? { startedAt: input.now } : {}),
        ...(TERMINAL_EXECUTION_STATES.has(input.to) ? { completedAt: input.now } : {}),
      };
      const records = await executionCollection.list();
      const raw = records.find((record) => ownerMatches(record, input.ownerId) && record.executionId === input.executionId);
      if (!raw) return undefined;
      let updated: PocketBaseStoredRecord | undefined;
      if (options.atomicClaim) {
        updated = await options.atomicClaim.claim(executionCollection, raw.id, { ownerId: input.ownerId, executionId: input.executionId, status: current.status }, updateJson(data));
      } else if (options.conditionalUpdate) {
        updated = await options.conditionalUpdate.update(executionCollection, raw.id, { ownerId: input.ownerId, executionId: input.executionId, status: current.status }, updateJson(data));
      } else {
        throw new AutomationAtomicClaimUnsupportedError();
      }
      return updated ? executionAsDomain(mapExecution(updated)) : undefined;
    },
    async claimAction(input) {
      requireOwner(input.ownerId);
      const actionExecutionId = `${input.executionId}:${input.action.id}`;
      let action = await store.actions.get(input.ownerId, actionExecutionId);
      if (!action) {
        try {
          action = await store.actions.create(input.ownerId, {
            id: actionExecutionId,
            executionId: input.executionId,
            actionId: input.action.id,
            actionType: input.action.type,
            ordinal: input.ordinal ?? 0,
            status: "pending",
          });
        } catch {
          action = await store.actions.get(input.ownerId, actionExecutionId);
          if (!action) throw new Error("Unable to create automation action execution record");
        }
      }
      if (action.status !== "pending") return { action: actionAsDomain(action), claimed: false };
      const records = await actionCollection.list();
      const raw = records.find((record) => ownerMatches(record, input.ownerId) && record.actionExecutionId === actionExecutionId);
      if (!raw) return { action: actionAsDomain(action), claimed: false };
      let updated: PocketBaseStoredRecord | undefined;
      if (options.atomicClaim) {
        updated = await options.atomicClaim.claim(actionCollection, raw.id, { ownerId: input.ownerId, actionExecutionId, status: "pending" }, { status: "running", startedAt: input.now, updatedAt: input.now });
      } else if (options.conditionalUpdate) {
        updated = await options.conditionalUpdate.update(actionCollection, raw.id, { ownerId: input.ownerId, actionExecutionId, status: "pending" }, { status: "running", startedAt: input.now, updatedAt: input.now });
      } else {
        throw new AutomationAtomicClaimUnsupportedError();
      }
      return updated ? { action: actionAsDomain(mapAction(updated)), claimed: true } : { action: actionAsDomain((await store.actions.get(input.ownerId, actionExecutionId)) ?? action), claimed: false };
    },
    async finishAction(input) {
      const actionExecutionId = `${input.executionId}:${input.actionId}`;
      const updated = await store.actions.update(input.ownerId, actionExecutionId, {
        status: input.status,
        ...(input.input === undefined ? {} : { input: input.input as AutomationJson }),
        ...(input.result === undefined ? {} : { result: input.result as AutomationJson }),
        ...(input.error === undefined ? {} : { error: input.error as unknown as AutomationJson }),
        completedAt: input.now,
      });
      return updated ? actionAsDomain(updated) : undefined;
    },
    async listActions(ownerId, executionId) {
      return (await store.actions.list(requireOwner(ownerId), executionId)).map(actionAsDomain);
    },
  };

  const occurrenceRepository: TriggerOccurrenceRepository = {
    async get(ownerId, automationId, occurrenceKey) {
      const raw = (await occurrenceCollection.list()).find((record) => ownerMatches(record, requireOwner(ownerId))
        && record.automationId === automationId && record.occurrenceKey === occurrenceKey);
      return raw ? occurrenceAsDomain(mapOccurrence(raw)) : undefined;
    },
    async list(ownerId, automationId, limit) {
      return (await store.occurrences.list(requireOwner(ownerId), automationId, limit)).map(occurrenceAsDomain);
    },
  };
  return Object.assign(store, { repository, executionStore, occurrenceRepository });
}

const TERMINAL_EXECUTION_STATES = new Set<AutomationExecutionStatus>(["completed", "failed", "cancelled", "interrupted", "unknown"]);
