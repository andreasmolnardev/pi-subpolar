#!/usr/bin/env bun
import { createLocalAdapter } from "../../subpolar-adapter-local/src/index.ts";
import { createPiRunPort, resolvePiExecutorFactory, type PiExecutorFactory, type PiExecutorModule } from "../../subpolar-adapter-pi/src/index.ts";
import type { AgentExecutor, RunContext, RunEvent, ToolDefinition, ToolExecutor } from "../../subpolar-contracts/src/index.ts";
import { createPolicyGateway, createRunService, redactAuditValue } from "../../subpolar-core/src/index.ts";

export const LOCAL_FIXTURE_EXECUTOR = "local-fixture-echo";

const fixtureTool: ToolDefinition = {
  id: "local.fixture.echo",
  namespace: "local.fixture",
  description: "Deterministic local echo fixture used until the Pi composition seam is wired",
  inputSchema: { type: "object", required: ["prompt"] },
  enabled: true,
  risk: "low",
};

export const localFixtureEchoExecutor: ToolExecutor = async (call) => {
  const input = call.input as { prompt?: unknown };
  if (typeof input.prompt !== "string") {
    return { ok: false, error: { code: "INVALID_FIXTURE_INPUT", message: "Fixture prompt must be a string" } };
  }
  return { ok: true, value: { executor: LOCAL_FIXTURE_EXECUTOR, text: `Local fixture echo: ${input.prompt}` } };
};

export interface CliIo {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export interface CliOptions {
  executor?: ToolExecutor;
  pi?: { factory?: PiExecutorFactory; module?: string | PiExecutorModule; config?: unknown };
  sessionFile?: string;
  now?: () => Date;
  signal?: AbortSignal;
}

interface ParsedRun {
  prompt: string;
  json: boolean;
  jsonl: boolean;
  timeout?: number;
  sessionId?: string;
  sessionFile?: string;
}

function parseRunArgs(args: string[]): ParsedRun {
  let json = false;
  let jsonl = false;
  let timeout: number | undefined;
  let sessionId: string | undefined;
  let sessionFile: string | undefined;
  const promptParts: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      json = true;
    } else if (argument === "--jsonl") {
      jsonl = true;
    } else if (argument === "--timeout") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new CliUsageError("--timeout requires a value");
      timeout = Number(value);
      if (!Number.isInteger(timeout) || timeout < 1) throw new CliUsageError("--timeout must be a positive integer in milliseconds");
      index += 1;
    } else if (argument === "--session" || argument === "--session-file") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new CliUsageError(`${argument} requires a value`);
      if (argument === "--session") sessionId = value;
      else sessionFile = value;
      index += 1;
    } else if (argument.startsWith("--")) {
      throw new CliUsageError(`Unknown option: ${argument}`);
    } else {
      promptParts.push(argument);
    }
  }
  const prompt = promptParts.join(" ").trim();
  if (!prompt) throw new CliUsageError("run requires a prompt");
  if (json && jsonl) throw new CliUsageError("--json and --jsonl cannot be used together");
  return { prompt, json, jsonl, timeout, sessionId, sessionFile };
}

export class CliUsageError extends Error {
  readonly code = "CLI_USAGE_ERROR";
}

function envelopeError(error: { code: string; message: string }, command = "run") {
  const code = /^[A-Z][A-Z0-9_.-]{0,63}$/.test(error.code) ? error.code : "CLI_ERROR";
  const message = redactAuditValue(error.message);
  return { ok: false, command, error: { code, message: typeof message === "string" ? message : "CLI failed" } };
}

export async function runCli(argv: string[], options: CliOptions = {}, io: CliIo = {}): Promise<number> {
  const stdout = io.stdout ?? ((text) => process.stdout.write(text));
  const stderr = io.stderr ?? ((text) => process.stderr.write(text));
  const jsonRequested = argv.includes("--json");
  const jsonlRequested = argv.includes("--jsonl");
  let timedOut = false;
  let explicitlyCancelled = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const abortFromCaller = () => {
    explicitlyCancelled = true;
    controller.abort();
  };
  const processCancel = () => abortFromCaller();
  process.on("SIGINT", processCancel);
  process.on("SIGTERM", processCancel);
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  try {
    if (argv[0] !== "run") throw new CliUsageError("Usage: subpolar-cli run <prompt> [--json|--jsonl] [--timeout <ms>] [--session <id>] [--session-file <path>]");
    const parsed = parseRunArgs(argv.slice(1));
    if (parsed.timeout !== undefined) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, parsed.timeout);
    }
    const sessionId = parsed.sessionId ?? `ephemeral-${(options.now ?? (() => new Date()))().getTime()}`;
    const adapter = createLocalAdapter({ sessionFile: parsed.sessionFile ?? options.sessionFile });
    const executor = options.executor ?? localFixtureEchoExecutor;
    const gateway = createPolicyGateway({
      tools: [fixtureTool],
      validateInput: (input) => {
        const prompt = (input as { prompt?: unknown } | null)?.prompt;
        return typeof prompt === "string" && prompt.length > 0 ? { valid: true } : { valid: false, errors: ["prompt must be a non-empty string"] };
      },
      resolvePolicy: (definition) => definition.id === fixtureTool.id ? { allow: true, reason: "Explicit local fixture policy" } : { deny: true },
      execute: executor,
    });
    const context: RunContext = {
      requestId: `request-${sessionId}`,
      principal: { id: "local-cli", kind: "local", displayName: "Subpolar CLI" },
      sessionId,
    };
    let agentExecutor: AgentExecutor;
    let executorName = LOCAL_FIXTURE_EXECUTOR;
    if (options.pi?.factory || options.pi?.module) {
      const factory = options.pi.factory ?? await resolvePiExecutorFactory(
        typeof options.pi.module === "string" ? await import(options.pi.module) : options.pi.module!,
      );
      const piPort = createPiRunPort(factory, options.pi.config);
      agentExecutor = (request, emit) => piPort.run(request, emit);
      executorName = "pi";
    } else {
      agentExecutor = async (request) => {
      const result = await gateway.call(
        { callId: `call-${request.runId}`, toolId: fixtureTool.id, input: { prompt: request.prompt } },
        { ...request.context, runId: request.runId },
      );
      if (!result.ok) throw result.error;
      return result.value;
      };
    }
    const emitEvent = parsed.jsonl ? (event: RunEvent) => {
      const terminal = event.type === "run.completed" || event.type === "run.failed" || event.type === "run.interrupted" || event.type === "run.unknown";
      const category = event.type === "run.started" ? "started" : event.type === "run.progress" ? "progress" : terminal ? "terminal" : undefined;
      if (category) stdout(`${JSON.stringify(redactAuditValue({ event: category, ...event }))}\n`);
    } : undefined;
    const run = createRunService({ executor: agentExecutor, sessionStore: adapter.sessions, now: options.now, eventSink: emitEvent });
    const result = await run.run({ runId: `run-${sessionId}`, prompt: parsed.prompt, context, signal: controller.signal });
    if (result.state !== "completed") {
      const error = timedOut
        ? { code: "CLI_TIMEOUT", message: "Run timed out" }
        : explicitlyCancelled
          ? { code: "CLI_CANCELLED", message: "Run cancelled" }
          : result.error;
      const output = envelopeError(error);
      if (!parsed.jsonl) (parsed.json ? stdout : stderr)(`${parsed.json ? JSON.stringify(output) : `Error [${output.error.code}]: ${output.error.message}`}\n`);
      return timedOut ? 3 : explicitlyCancelled ? 4 : 1;
    }
    const value = result.output as { executor?: string; text?: string };
    const output = {
      ok: true,
      command: "run",
      sessionId,
      resumed: result.resumed,
      executor: value.executor ?? executorName,
      result: value,
    };
    if (!parsed.jsonl) {
      const safeOutput = redactAuditValue(output) as typeof output;
      stdout(`${parsed.json ? JSON.stringify(safeOutput) : `${safeOutput.result.text}\n(session ${sessionId}; ${safeOutput.executor})\n`}\n`);
    }
    return 0;
  } catch (error) {
    const typed = error instanceof CliUsageError ? error : { code: "CLI_ERROR", message: "CLI failed" };
    const output = envelopeError(typed);
    if (jsonlRequested) stdout(`${JSON.stringify(redactAuditValue({ event: "terminal", ...output }))}\n`);
    else (jsonRequested ? stdout : stderr)(`${jsonRequested ? JSON.stringify(output) : `Error [${output.error.code}]: ${output.error.message}`}\n`);
    return error instanceof CliUsageError ? 2 : timedOut ? 3 : explicitlyCancelled ? 4 : 1;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    options.signal?.removeEventListener("abort", abortFromCaller);
    process.off("SIGINT", processCancel);
    process.off("SIGTERM", processCancel);
  }
}

if (import.meta.main) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
