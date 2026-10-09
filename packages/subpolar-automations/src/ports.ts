import type {
  ActionDefinition,
  ActionExecution,
  ActionExecutionStatus,
  AgentExecutionResult,
  AutomationDefinition,
  AutomationExecution,
  AutomationExecutionStatus,
  AutomationInput,
  AutomationUpdate,
  JsonValue,
  TriggerOccurrence,
  TriggerInput,
} from "./types.ts";

export interface AutomationRepository {
  get(ownerId: string, automationId: string): Promise<AutomationDefinition | undefined>;
  list(ownerId: string): Promise<AutomationDefinition[]>;
  create(ownerId: string, input: AutomationInput, now: string): Promise<AutomationDefinition>;
  update(ownerId: string, automationId: string, update: AutomationUpdate, now: string): Promise<AutomationDefinition | undefined>;
  delete(ownerId: string, automationId: string): Promise<boolean>;
}

export interface ClaimedOccurrence {
  occurrence: TriggerOccurrence;
  execution: AutomationExecution;
  newlyClaimed: boolean;
}

/** Implementations must atomically deduplicate by (ownerId, automationId, occurrenceKey). */
export interface AutomationExecutionStore {
  claimOccurrence(input: {
    ownerId: string;
    automation: AutomationDefinition;
    occurrenceKey: string;
    trigger: TriggerInput;
    resolvedInput: string;
    now: string;
  }): Promise<ClaimedOccurrence>;
  finishOccurrence(input: {
    ownerId: string;
    automationId: string;
    occurrenceKey: string;
    executionId: string;
    status: Extract<TriggerOccurrence["status"], "completed" | "failed" | "cancelled" | "unknown">;
    now: string;
  }): Promise<TriggerOccurrence | undefined>;
  getExecution(ownerId: string, executionId: string): Promise<AutomationExecution | undefined>;
  listExecutions(ownerId: string, automationId: string, limit?: number): Promise<AutomationExecution[]>;
  transitionExecution(input: {
    ownerId: string;
    executionId: string;
    from: readonly AutomationExecutionStatus[];
    to: AutomationExecutionStatus;
    now: string;
    runId?: string;
    output?: JsonValue;
    error?: { code: string; message: string };
  }): Promise<AutomationExecution | undefined>;
  /** Use a stable action record id derived from (executionId, action.id). */
  claimAction(input: {
    ownerId: string;
    executionId: string;
    action: ActionDefinition;
    ordinal?: number;
    now: string;
  }): Promise<{ action: ActionExecution; claimed: boolean }>;
  finishAction(input: {
    ownerId: string;
    executionId: string;
    actionId: string;
    status: Extract<ActionExecutionStatus, "completed" | "failed" | "skipped" | "unknown">;
    now: string;
    input?: JsonValue;
    result?: JsonValue;
    error?: { code: string; message: string };
  }): Promise<ActionExecution | undefined>;
  listActions(ownerId: string, executionId: string): Promise<ActionExecution[]>;
}

/** Host adapter must resolve the configured agent in the owner's scope and use canonical Subpolar runs. */
export interface AgentExecutionPort {
  /** Optional deterministic canonical run ID, persisted before execution starts so cancel/recovery can find it. */
  canonicalRunId?(automationExecutionId: string): string;
  execute(input: {
    ownerId: string;
    agentId: string;
    prompt: string;
    automationExecutionId: string;
    idempotencyKey: string;
    projectId?: string;
    executionConfig?: { timeoutMs?: number };
    trigger: TriggerInput;
    signal?: AbortSignal;
  }): Promise<AgentExecutionResult>;
  cancel(ownerId: string, canonicalRunId: string): Promise<void>;
}

export interface AgentAccessPort {
  assertCanUse(ownerId: string, agentId: string): Promise<void>;
}

export interface ActionHandler<A extends ActionDefinition = ActionDefinition> {
  execute(input: {
    ownerId: string;
    execution: AutomationExecution;
    action: A;
    resolvedInput: JsonValue;
    context: import("./types.ts").AutomationContext;
    signal?: AbortSignal;
  }): Promise<unknown>;
}

export type ActionHandlerMap = Partial<Record<ActionDefinition["type"], ActionHandler<any>>>;

export interface IdGenerator {
  next(prefix: string): string;
}

export interface Clock {
  now(): Date;
}

export interface TriggerOccurrenceInput {
  ownerId: string;
  automationId: string;
  occurrenceKey: string;
  trigger: TriggerInput;
  signal?: AbortSignal;
  /** Claim and return promptly, processing the canonical run in the background. */
  background?: boolean;
}

export interface TriggerOccurrenceRepository {
  get(ownerId: string, automationId: string, occurrenceKey: string): Promise<TriggerOccurrence | undefined>;
  list(ownerId: string, automationId: string, limit?: number): Promise<TriggerOccurrence[]>;
}

export type TriggerDeliveryResult = {
  accepted: boolean;
  duplicate: boolean;
  execution?: AutomationExecution;
};

export interface TriggerDeliveryPort {
  deliver(input: TriggerOccurrenceInput): Promise<TriggerDeliveryResult>;
}

export type AutomationServicePorts = {
  repository: AutomationRepository;
  agentAccess: AgentAccessPort;
  clock: Clock;
};

export type AutomationExecutionPorts = {
  repository: AutomationRepository;
  executions: AutomationExecutionStore;
  agentAccess: AgentAccessPort;
  agentExecutor: AgentExecutionPort;
  actions: ActionHandlerMap;
  ids: IdGenerator;
  clock: Clock;
};

export type AutomationInputValidation = AutomationInput;
export type JsonRecord = Record<string, JsonValue>;
