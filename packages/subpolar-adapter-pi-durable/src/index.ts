import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  type Conversation,
  type AgentEvent,
  watchEvents,
  type AgentEventStream,
  type EntryRecord,
  type Registry,
  type Submission,
  type ToolExecutionApi,
  type Tx,
} from "@earendil-works/pi-durable";
import type { Models, TSchema } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { defineDoc, type Storage } from "@earendil-works/pi-durable";
import type { SqliteOptions } from "./sqlite.ts";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
  JsonValue,
  RuntimeExecution,
  StatelessExecutor,
  ToolCall,
  ToolDefinition,
  RuntimeToolInvoker,
} from "@subpolar/contracts";

const ConversationMap = defineDoc<{ conversations: Record<string, number> }>({
  kind: "subpolar.pi-durable.conversations",
  version: 1,
  scope: "session",
  initial: () => ({ conversations: {} }),
});

export interface PiDurableAgentConfig {
  readonly model: { readonly provider: string; readonly modelId: string };
  readonly instructions?: string;
  readonly cwd?: string;
}

export type PiDurableModels = Models | ModelRuntime;

export interface PiDurableEngineOptions {
  readonly storage: Storage;
  readonly models: PiDurableModels;
  readonly tools: readonly ToolDefinition[];
  readonly registry?: Registry;
  readonly context?: Context;
}

export interface PiDurableEngineInitOptions {
  readonly databasePath: string;
  readonly models: PiDurableModels;
  readonly tools: readonly ToolDefinition[];
  readonly registry?: Registry;
  readonly sqlite?: SqliteOptions;
  readonly context?: Context;
}

export interface PiDurableRequest {
  readonly ownerId: string;
  readonly sessionId: string;
  readonly requestId: string;
  readonly runId: string;
  readonly prompt: string;
  readonly signal?: AbortSignal;
}

export interface PiDurableWaitResult {
  readonly requestId: string;
  readonly conversationId: number;
  readonly submissionId: number;
  readonly status: "done" | "unanswered";
  readonly output?: string;
  readonly reason?: string;
}

export interface PiDurableTranscriptEntry {
  readonly id: EntryRecord["id"];
  readonly kind: EntryRecord["kind"];
  readonly messages: NonNullable<EntryRecord["model"]>;
}

/** Minimal execution-engine boundary used by this adapter. */
export interface AgentEngine {
  initialize(context?: Context): Promise<void>;
  configure(ownerId: string, sessionId: string, config: PiDurableAgentConfig, context?: Context): Promise<number>;
  submit(request: PiDurableRequest, execution: RuntimeExecution, context?: Context): Promise<number>;
  wait(ownerId: string, sessionId: string, requestId: string, context?: Context): Promise<PiDurableWaitResult>;
  abort(ownerId: string, sessionId: string, context?: Context): Promise<void>;
  recover(ownerId: string, sessionId: string, requestId: string, context?: Context): Promise<number | undefined>;
  readTranscript(ownerId: string, sessionId: string, context?: Context): Promise<readonly PiDurableTranscriptEntry[]>;
  close(context?: Context): Promise<void>;
}

function ownerSessionKey(ownerId: string, sessionId: string): string {
  return JSON.stringify([ownerId, sessionId]);
}

function jsonResult(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return "[tool result could not be serialized]";
  }
}

function assistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string") {
      return [part.text];
    }
    return [];
  }).join("");
}

function schemaObject(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Gateway tool inputSchema must be a JSON Schema object");
  }
  return value;
}

function toTypeBoxSchema(value: JsonValue): TSchema {
  const schema = schemaObject(value);
  const options = Object.fromEntries(Object.entries(schema).filter(([key]) =>
    ["description", "title", "default", "examples", "minLength", "maxLength", "pattern", "format", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minItems", "maxItems", "uniqueItems"].includes(key),
  ));
  if (Array.isArray(schema.enum)) {
    const literals = schema.enum.map((entry) => {
      if (entry === null) return Type.Null();
      if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") return Type.Literal(entry);
      throw new Error("Gateway tool inputSchema enum values must be JSON primitives");
    });
    if (literals.length === 0) throw new Error("Gateway tool inputSchema enum cannot be empty");
    return (literals.length === 1 ? literals[0] : Type.Union(literals)) as TSchema;
  }
  switch (schema.type) {
    case "object": {
      const properties = schema.properties === undefined ? {} : schemaObject(schema.properties);
      const required = Array.isArray(schema.required) ? new Set(schema.required.filter((item): item is string => typeof item === "string")) : new Set<string>();
      const fields = Object.fromEntries(Object.entries(properties).map(([key, property]) => {
        const converted = toTypeBoxSchema(property);
        return [key, required.has(key) ? converted : Type.Optional(converted)];
      }));
      return Type.Object(fields, { ...options, ...(schema.additionalProperties === false ? { additionalProperties: false } : {}) }) as TSchema;
    }
    case "array":
      return Type.Array(schema.items === undefined ? Type.Any() : toTypeBoxSchema(schema.items), options) as TSchema;
    case "string": return Type.String(options) as TSchema;
    case "number": return Type.Number(options) as TSchema;
    case "integer": return Type.Integer(options) as TSchema;
    case "boolean": return Type.Boolean(options) as TSchema;
    case "null": return Type.Null() as TSchema;
    case undefined: throw new Error("Gateway tool inputSchema must declare a supported type");
    default: throw new Error(`Unsupported gateway tool JSON Schema type: ${String(schema.type)}`);
  }
}

interface EventWatch {
  readonly stream: AgentEventStream;
  error?: unknown;
  stopping?: Promise<void>;
}

function eventProjection(event: AgentEvent): JsonValue | undefined {
  if (event.type === "snapshot") return undefined;
  const record = event as unknown as { message?: unknown; entry?: unknown };
  const message = record.message && typeof record.message === "object" ? record.message as { role?: unknown } : undefined;
  const entry = record.entry && typeof record.entry === "object" ? record.entry as { kind?: unknown; model?: unknown } : undefined;
  const containsSystemMessage = message?.role === "system"
    || entry?.kind === "pi.system"
    || (Array.isArray(entry?.model) && entry.model.some((item) => item && typeof item === "object" && "role" in item && item.role === "system"));
  if (containsSystemMessage) return undefined;
  try {
    const serialized = JSON.stringify(event);
    if (serialized === undefined) return undefined;
    const parsed: unknown = JSON.parse(serialized);
    return parsed && typeof parsed === "object" ? parsed as JsonValue : undefined;
  } catch {
    return undefined;
  }
}

interface GatewayBinding {
  readonly invoker: RuntimeToolInvoker;
  readonly requestId: string;
  readonly runId: string;
}

function durableToolName(id: string): string {
  const name = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error(`Subpolar tool ID cannot be represented as a Pi Durable function name: ${id}`);
  return name;
}

function buildRegistry(tools: readonly ToolDefinition[], bindings: Map<number, GatewayBinding>, registry = createRegistry()): Registry {
  const active = tools.filter((tool) => tool.enabled);
  const names = new Set<string>();
  for (const tool of active) {
    const name = durableToolName(tool.id);
    if (names.has(name)) throw new Error(`Subpolar tool IDs collide after Pi Durable name normalization: ${name}`);
    names.add(name);
  }
  const extension = defineExtension({
    name: "subpolar-gateway",
    tools: active.map((tool) => defineTool({
      name: durableToolName(tool.id),
      description: tool.description,
      parameters: toTypeBoxSchema(tool.inputSchema),
      replay: "unsafe",
      execute: async (args: unknown, api: ToolExecutionApi) => {
        const binding = bindings.get(api.conversationId);
        if (!binding) throw new Error("Gateway tool invocation has no active Subpolar request binding");
        const callId = `pi-durable:${api.conversationId}:${binding.requestId}:${api.callId}`;
        const gatewayCall: ToolCall = {
          callId,
          toolId: tool.id,
          input: args,
          runId: binding.runId,
          requestId: binding.requestId,
          idempotencyKey: callId,
        };
        const result = await binding.invoker.call(gatewayCall);
        const failed = Boolean(result && typeof result === "object" && (result as { ok?: unknown }).ok === false);
        return { content: [{ type: "text", text: jsonResult(result) }], ...(failed ? { isError: true } : {}) };
      },
    })),
  });
  registry.install(extension);
  return registry;
}


export class PiDurableAgentEngine implements AgentEngine {
  readonly #options: PiDurableEngineOptions;
  readonly #registry: Registry;
  readonly #bindings = new Map<number, GatewayBinding>();
  readonly #eventWatches = new Map<number, EventWatch>();
  #harness: Awaited<ReturnType<typeof Harness.open>> | undefined;
  #initialized: Promise<void> | undefined;

  constructor(options: PiDurableEngineOptions) {
    this.#options = options;
    this.#registry = buildRegistry(options.tools, this.#bindings, options.registry);
  }

  static async initialize(options: PiDurableEngineInitOptions): Promise<PiDurableAgentEngine> {
    const storage = typeof Bun !== "undefined"
      ? await (await import("./sqlite.ts")).openBunSqliteStorage(options.databasePath, options.sqlite)
      : await (await import("@earendil-works/pi-durable/storage/sqlite/node")).openNodeSqliteStorage(options.databasePath, options.sqlite);
    const engine = new PiDurableAgentEngine({
      storage,
      models: options.models,
      tools: options.tools,
      ...(options.registry === undefined ? {} : { registry: options.registry }),
      ...(options.context === undefined ? {} : { context: options.context }),
    });
    await engine.initialize(options.context);
    return engine;
  }

  async initialize(context = this.#context()): Promise<void> {
    if (!this.#initialized) {
      this.#initialized = (async () => {
        this.#harness = await Harness.open(this.#options.storage, {
          // The server runtime is built against Pi AI 1.0.x while Durable's
          // installed Harness is built against 1.1.x. Both expose the same
          // runtime Models contract; keep this version boundary here.
          models: this.#options.models as Models,
          registry: this.#registry,
          settings: { extensions: [this.#registry.snapshot().extension("subpolar-gateway")!] },
        }, context);
        this.#harness.resume();
      })();
    }
    await this.#initialized;
  }

  async configure(ownerId: string, sessionId: string, config: PiDurableAgentConfig, context = this.#context()): Promise<number> {
    await this.initialize(context);
    const conversation = await this.#conversation(ownerId, sessionId, context);
    if (!conversation) throw new Error("Conversation mapping unexpectedly returned no conversation");
    if (this.#bindings.has(conversation.id)) throw new Error("A Durable execution is already active for this owner/session conversation");
    await conversation.configure({
      model: config.model,
      ...(config.instructions === undefined ? {} : { instructions: config.instructions }),
      ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
    }, context);
    return conversation.id;
  }

  async submit(request: PiDurableRequest, execution: RuntimeExecution, context = this.#context()): Promise<number> {
    const runtime = execution.context;
    if (request.ownerId !== runtime.principal.id || (execution.request.principal && request.ownerId !== execution.request.principal.id)) {
      throw new Error("Pi Durable request owner does not match the RuntimeExecution principal");
    }
    if (request.sessionId !== runtime.sessionId || (execution.request.sessionId !== undefined && request.sessionId !== execution.request.sessionId)) {
      throw new Error("Pi Durable request session does not match the RuntimeExecution session");
    }
    if (request.requestId !== runtime.requestId) {
      throw new Error("Pi Durable request ID does not match the RuntimeExecution request");
    }
    if (runtime.runId !== undefined && request.runId !== runtime.runId) {
      throw new Error("Pi Durable request run ID does not match the RuntimeExecution run");
    }
    if (request.runId !== execution.request.runId) {
      throw new Error("Pi Durable request run ID does not match the runtime request run");
    }
    await this.initialize(context);
    const conversation = await this.#conversation(request.ownerId, request.sessionId, context);
    if (!conversation) throw new Error("Conversation mapping unexpectedly returned no conversation");
    const current = this.#bindings.get(conversation.id);
    if (current && current.requestId !== request.requestId) {
      throw new Error("A different Durable execution is already active for this owner/session conversation");
    }
    let eventWatch: EventWatch | undefined;
    if (!current) {
      this.#bindings.set(conversation.id, {
        invoker: execution.tools,
        requestId: request.requestId,
        runId: request.runId,
      });
      try {
        const stream = await watchEvents(this.#harness!, conversation.id as never, context);
        eventWatch = { stream };
        this.#eventWatches.set(conversation.id, eventWatch);
        stream.start(async (events) => {
          for (const event of events) {
            const projection = eventProjection(event);
            if (projection === undefined) continue;
            try {
              await execution.emit(projection);
            } catch (error) {
              eventWatch!.error ??= error;
            }
          }
        });
      } catch (error) {
        this.#bindings.delete(conversation.id);
        if (eventWatch) await this.#stopEventWatch(conversation.id, eventWatch);
        throw error;
      }
    }
    try {
      const submission = await conversation.submit({
        type: "input",
        content: request.prompt,
        requestId: request.requestId,
      }, context);
      return submission.id;
    } catch (error) {
      if (!current) {
        this.#bindings.delete(conversation.id);
        if (eventWatch) await this.#stopEventWatch(conversation.id, eventWatch);
      }
      throw error;
    }
  }

  async wait(ownerId: string, sessionId: string, requestId: string, context = this.#context()): Promise<PiDurableWaitResult> {
    await this.initialize(context);
    const conversation = await this.#conversation(ownerId, sessionId, context);
    if (!conversation) throw new Error("Conversation mapping unexpectedly returned no conversation");
    try {
      const submission = await this.#findSubmission(conversation, requestId, context);
      const settled = await submission.wait(context);
      if (settled.status !== "done" || settled.type !== "input") {
        return {
          requestId,
          conversationId: conversation.id,
          submissionId: submission.id,
          status: "unanswered",
          reason: settled.status === "unanswered" ? settled.reason : "unexpected_submission_type",
        };
      }
      const answer = await conversation.commit((tx: Tx) => tx.entry(AssistantEntry, settled.answer), context);
      const message = answer?.model?.[0];
      return {
        requestId,
        conversationId: conversation.id,
        submissionId: submission.id,
        status: "done",
        output: message?.role === "assistant" ? assistantText(message.content) : "",
      };
    } finally {
      const binding = this.#bindings.get(conversation.id);
      if (binding?.requestId === requestId) this.#bindings.delete(conversation.id);
      const eventWatch = this.#eventWatches.get(conversation.id);
      if (eventWatch && binding?.requestId === requestId) {
        await this.#stopEventWatch(conversation.id, eventWatch);
        if (eventWatch.error !== undefined) throw eventWatch.error;
      }
    }
  }

  async abort(ownerId: string, sessionId: string, context = this.#context()): Promise<void> {
    await this.initialize(context);
    const conversation = await this.#conversation(ownerId, sessionId, context);
    if (!conversation) throw new Error("Conversation mapping unexpectedly returned no conversation");
    await conversation.abort(context);
  }

  async recover(ownerId: string, sessionId: string, requestId: string, context = this.#context()): Promise<number | undefined> {
    await this.initialize(context);
    const conversation = await this.#conversation(ownerId, sessionId, context, false);
    if (!conversation) return undefined;
    const record = await conversation.commit((tx: Tx) => tx.submissionByRequest(conversation.id, requestId), context);
    if (!record || record.type !== "input") return undefined;
    const submission = await this.#harness!.submission(record.id, context);
    return submission ? record.id : undefined;
  }

  async readTranscript(ownerId: string, sessionId: string, context = this.#context()): Promise<readonly PiDurableTranscriptEntry[]> {
    await this.initialize(context);
    const conversation = await this.#conversation(ownerId, sessionId, context, false);
    if (!conversation) return [];

    const entries: PiDurableTranscriptEntry[] = [];
    let cursor: import("@earendil-works/pi-durable").Cursor | undefined;
    do {
      const page = await conversation.entries({ order: "ascending" }, 100, cursor, context);
      entries.push(...page.items.map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        messages: entry.model ?? [],
      })));
      cursor = page.next;
    } while (cursor !== undefined);
    return entries;
  }

  async close(context = this.#context()): Promise<void> {
    const errors: unknown[] = [];
    for (const [conversationId, eventWatch] of this.#eventWatches) {
      try {
        await this.#stopEventWatch(conversationId, eventWatch);
      } catch (error) {
        errors.push(error);
      }
    }
    this.#bindings.clear();
    try {
      if (this.#harness) await this.#harness.close(context);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) throw new AggregateError(errors, "Pi Durable engine cleanup failed");
  }

  async #stopEventWatch(conversationId: number, eventWatch: EventWatch): Promise<void> {
    if (this.#eventWatches.get(conversationId) === eventWatch) this.#eventWatches.delete(conversationId);
    eventWatch.stopping ??= (async () => {
      await eventWatch.stream.stop();
      await eventWatch.stream.closed;
    })();
    await eventWatch.stopping;
  }

  #context(): Context {
    return this.#options.context ?? BACKGROUND_CONTEXT;
  }

  async #conversation(ownerId: string, sessionId: string, context: Context, create = true): Promise<Conversation | undefined> {
    const key = ownerSessionKey(ownerId, sessionId);
    const conversationId = await this.#harness!.commit(async (tx: Tx) => {
      const mapping = await tx.doc(ConversationMap);
      const existing = mapping.conversations[key];
      if (existing !== undefined) return existing;
      if (!create) return undefined;
      const record = await tx.createConversation({ ownership: { kind: "ownerless" } });
      mapping.conversations[key] = record.id;
      return record.id;
    }, context);
    if (conversationId === undefined) return undefined;
    const conversation = await this.#harness!.conversation(conversationId as never, context);
    if (!conversation) throw new Error("Mapped Pi Durable conversation is missing from storage");
    return conversation;
  }

  async #findSubmission(conversation: Conversation, requestId: string, context: Context): Promise<Submission> {
    const record = await conversation.commit((tx: Tx) => tx.submissionByRequest(conversation.id, requestId), context);
    if (!record || record.type !== "input") throw new Error(`No input submission found for request ${requestId}`);
    const submission = await this.#harness!.submission(record.id, context);
    if (!submission) throw new Error(`Submission ${record.id} is missing from the durable harness`);
    return submission;
  }
}

export function createPiDurableStatelessExecutor(engine: AgentEngine): StatelessExecutor {
  return async (execution) => {
    const { request, context } = execution;
    const ownerId = context.principal.id;
    const sessionId = context.sessionId;
    if (!sessionId) throw new Error("Pi Durable requires a stable RunContext.sessionId for conversation mapping");
    await engine.configure(ownerId, sessionId, {
      model: parseModel(context.model),
      ...(context.cwd === undefined ? {} : { cwd: context.cwd }),
    });
    const abort = () => { void engine.abort(ownerId, sessionId).catch(() => {}); };
    request.signal?.addEventListener("abort", abort, { once: true });
    try {
      await engine.submit({
        ownerId,
        sessionId,
        requestId: context.requestId,
        runId: request.runId,
        prompt: request.prompt,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }, execution);
      if (request.signal?.aborted) abort();
      const result = await engine.wait(ownerId, sessionId, context.requestId);
      if (result.status !== "done") throw new Error(result.reason ?? "Pi Durable run did not complete");
      return result.output ?? "";
    } finally {
      request.signal?.removeEventListener("abort", abort);
    }
  };
}

function parseModel(value: string | undefined): { provider: string; modelId: string } {
  if (!value) throw new Error("Pi Durable requires a configured model in RunContext.model");
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error("RunContext.model must use the provider/modelId form, for example openai/gpt-6-sol");
  }
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}
