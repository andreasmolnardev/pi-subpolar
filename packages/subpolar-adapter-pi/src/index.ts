import type { AgentRunPort, JsonValue, RunProgressEmitter, RunRequest } from "../../subpolar-contracts/src/index.ts";

export interface PiExecutionContext {
  principal: RunRequest["context"]["principal"];
  sessionId?: string;
  projectId?: string;
  agentId?: string;
  model?: string;
  permission?: string;
  cwd?: string;
}

export interface PiStreamEvent {
  type: "text" | "status" | "tool" | "message";
  data: JsonValue;
}

export interface PiExecutionRequest {
  prompt: string;
  context: PiExecutionContext;
  signal?: AbortSignal;
  emit: (event: PiStreamEvent) => void | Promise<void>;
}

export interface PiExecutor {
  execute(request: PiExecutionRequest): unknown | Promise<unknown>;
}

export type PiExecutorFactory<Config = unknown> = (config: Config) => PiExecutor | Promise<PiExecutor>;
export type PiExecutorModule =
  | PiExecutorFactory
  | { default?: PiExecutorFactory; createPiExecutor?: PiExecutorFactory };

export class PiProviderError extends Error {
  readonly code = "PI_PROVIDER_ERROR";
  readonly details?: JsonValue;

  constructor(message = "Pi provider execution failed", details?: JsonValue) {
    super(message);
    this.name = "PiProviderError";
    this.details = details;
  }
}

export class PiRuntimeError extends Error {
  readonly code = "PI_RUNTIME_ERROR";
  readonly details?: JsonValue;

  constructor(message = "Pi runtime execution failed", details?: JsonValue) {
    super(message);
    this.name = "PiRuntimeError";
    this.details = details;
  }
}

function mapContext(request: RunRequest): PiExecutionContext {
  const { principal, sessionId, projectId, agentId, model, permission, cwd } = request.context;
  return { principal, sessionId, projectId, agentId, model, permission, cwd };
}

function jsonDetails(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((entry) => jsonDetails(entry) ?? null);
  if (value && typeof value === "object") {
    const result: { [key: string]: JsonValue } = {};
    for (const [key, entry] of Object.entries(value)) result[key] = jsonDetails(entry) ?? null;
    return result;
  }
  return undefined;
}

function mapError(error: unknown): PiProviderError | PiRuntimeError {
  if (error instanceof PiProviderError || error instanceof PiRuntimeError) return error;
  const candidate = error as { kind?: unknown; message?: unknown; details?: unknown } | null;
  const message = typeof candidate?.message === "string" ? candidate.message : undefined;
  const details = jsonDetails(candidate?.details);
  return candidate?.kind === "provider" ? new PiProviderError(message, details) : new PiRuntimeError(message, details);
}

export function createPiRunPort<Config>(factory: PiExecutorFactory<Config>, config: Config): AgentRunPort {
  let executorPromise: Promise<PiExecutor> | undefined;
  const executor = () => executorPromise ?? (executorPromise = Promise.resolve(factory(config)));

  return {
    async run(request: RunRequest, emit?: RunProgressEmitter) {
      try {
        return await (await executor()).execute({
          prompt: request.prompt,
          context: mapContext(request),
          signal: request.signal,
          emit: async (event) => { await emit?.({ type: event.type, data: event.data }); },
        });
      } catch (error) {
        throw mapError(error);
      }
    },
  };
}

export async function resolvePiExecutorFactory(moduleValue: PiExecutorModule): Promise<PiExecutorFactory> {
  const factory = typeof moduleValue === "function" ? moduleValue : moduleValue.default ?? moduleValue.createPiExecutor;
  if (typeof factory !== "function") throw new PiRuntimeError("Pi executor module must export a factory");
  return factory;
}
