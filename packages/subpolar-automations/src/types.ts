export type AutomationId = string;
export type AutomationExecutionId = string;
export type ActionId = string;
export type TriggerOccurrenceKey = string;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ManualTrigger = { type: "manual" };
export type ScheduleTrigger = {
  type: "schedule";
  cron: string;
  timezone: string;
};
export type WebhookTrigger = {
  type: "webhook";
  /** A reference resolved by the host. Secret material never belongs in a definition. */
  credentialRef: string;
};
export type EventTrigger = {
  type: "event";
  eventType: string;
  /** Restricted condition syntax; evaluated by the domain condition evaluator. */
  where?: string;
};
export type TriggerDefinition = ManualTrigger | ScheduleTrigger | WebhookTrigger | EventTrigger;

export type StoreAction = { id: ActionId; type: "store"; when?: string };
export type NotificationAction = {
  id: ActionId;
  type: "notification";
  titleTemplate: string;
  bodyTemplate: string;
  when?: string;
};
export type WebhookAction = {
  id: ActionId;
  type: "webhook";
  url: string;
  method?: "POST" | "PUT";
  credentialRef?: string;
  bodyTemplate?: string;
  when?: string;
};
export type ToolAction = {
  id: ActionId;
  type: "tool";
  toolId: string;
  inputTemplate: string;
  when?: string;
};
export type ActionDefinition = StoreAction | NotificationAction | WebhookAction | ToolAction;

export interface AutomationDefinition {
  id: AutomationId;
  ownerId: string;
  name: string;
  description?: string;
  enabled: boolean;
  /** Required: an automation always delegates intelligence to an existing agent. */
  agentId: string;
  projectId?: string;
  promptTemplate: string;
  /** Operational limits only; agent permissions remain controlled by the agent. */
  executionConfig?: { timeoutMs?: number };
  trigger: TriggerDefinition;
  actions: ActionDefinition[];
  createdAt: string;
  updatedAt: string;
}

export type TriggerKind = TriggerDefinition["type"];
export type TriggerInput = {
  kind: TriggerKind;
  payload: JsonValue;
  occurredAt: string;
  causal?: {
    automationExecutionId?: string;
    parentAutomationExecutionId?: string;
    recursionDepth?: number;
  };
};

export type AutomationExecutionStatus =
  | "pending"
  | "running"
  | "waiting_approval"
  | "processing_output"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "unknown";

export interface AutomationExecution {
  id: AutomationExecutionId;
  automationId: AutomationId;
  ownerId: string;
  agentId: string;
  projectId?: string;
  occurrenceKey: TriggerOccurrenceKey;
  trigger: TriggerInput;
  resolvedInput: string;
  runId?: string;
  status: AutomationExecutionStatus;
  output?: JsonValue;
  error?: { code: string; message: string };
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export type ActionExecutionStatus = "pending" | "running" | "completed" | "failed" | "skipped" | "unknown";
export interface ActionExecution {
  id: string;
  executionId: AutomationExecutionId;
  actionId: ActionId;
  actionType: ActionDefinition["type"];
  status: ActionExecutionStatus;
  input?: JsonValue;
  result?: JsonValue;
  error?: { code: string; message: string };
  startedAt?: string;
  finishedAt?: string;
}

export interface AutomationInput {
  name: string;
  description?: string;
  enabled?: boolean;
  agentId: string;
  projectId?: string;
  promptTemplate: string;
  executionConfig?: { timeoutMs?: number };
  trigger: TriggerDefinition;
  actions?: ActionDefinition[];
}

export interface AutomationUpdate {
  name?: string;
  description?: string;
  enabled?: boolean;
  agentId?: string;
  projectId?: string;
  promptTemplate?: string;
  executionConfig?: { timeoutMs?: number };
  trigger?: TriggerDefinition;
  actions?: ActionDefinition[];
}

export interface AutomationContext {
  trigger: TriggerInput;
  execution: Pick<AutomationExecution, "id" | "automationId" | "ownerId" | "agentId" | "projectId" | "occurrenceKey">;
  agent: { id: string };
  output?: { text?: string; structured?: JsonValue };
  run?: { id?: string; status?: string };
}

export interface AgentExecutionResult {
  runId: string;
  status: "completed" | "failed" | "interrupted" | "unknown" | "approval_required";
  output?: { text?: string; structured?: JsonValue };
  error?: { code: string; message: string };
}

export type TriggerOccurrenceStatus = "claimed" | "completed" | "failed" | "cancelled" | "unknown";
export interface TriggerOccurrence {
  id: string;
  automationId: AutomationId;
  ownerId: string;
  occurrenceKey: TriggerOccurrenceKey;
  trigger: TriggerInput;
  status: TriggerOccurrenceStatus;
  executionId?: AutomationExecutionId;
  createdAt: string;
  finishedAt?: string;
}
