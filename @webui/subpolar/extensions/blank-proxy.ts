/**
 * Expose the currently selected/configured Pi model as a small, local
 * OpenAI-compatible HTTP endpoint. Incoming system/developer messages are
 * discarded, so Pi's system prompt is never sent upstream.
 *
 * Start Pi normally, then point an OpenAI client at:
 *   http://127.0.0.1:${PI_BLANK_PROXY_PORT:-8787}/v1
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_PORT = 8787;

type Json = Record<string, any>;

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
    "Access-Control-Allow-Origin": "*",
  });
  response.end(text);
}

async function body(request: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || !Array.isArray(value.messages)) {
    throw new Error("Request must contain a messages array");
  }
  return value;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("");
}

function openAIResponse(result: any, model: Model<any>): Json {
  const text = result.content?.filter((part: any) => part.type === "text")
    .map((part: any) => part.text).join("") || null;
  const toolCalls = result.content?.filter((part: any) => part.type === "toolCall").map((part: any) => ({
    id: part.id,
    type: "function",
    function: { name: part.name, arguments: JSON.stringify(part.arguments ?? {}) },
  }));
  const message: Json = { role: "assistant", content: text };
  if (toolCalls?.length) message.tool_calls = toolCalls;
  return {
    id: `blank-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model.id,
    choices: [{ index: 0, message, finish_reason: toolCalls?.length ? "tool_calls" : "stop" }],
    usage: {
      prompt_tokens: result.usage?.input ?? 0,
      completion_tokens: result.usage?.output ?? 0,
      total_tokens: result.usage?.totalTokens ?? 0,
    },
  };
}

async function readRequest(request: IncomingMessage, response: ServerResponse, ctx: ExtensionContext): Promise<void> {
  if (request.method === "OPTIONS") {
    response.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, authorization" });
    response.end();
    return;
  }
  if (request.method === "GET" && request.url === "/v1/models") {
    const models = ctx.modelRegistry.getAvailable();
    return send(response, 200, {
      object: "list",
      data: models.map((model) => ({ id: `${model.provider}/${model.id}`, object: "model", owned_by: model.provider })),
    });
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") return send(response, 404, { error: { message: "Not found", type: "invalid_request_error" } });

  try {
    const input = await body(request);
    const requested = typeof input.model === "string" ? input.model.trim() : "";
    const configured = requested.includes("/")
      ? (() => {
        const separator = requested.indexOf("/");
        return ctx.modelRegistry.find(requested.slice(0, separator), requested.slice(separator + 1));
      })()
      : ctx.modelRegistry.getAll().find((candidate) => candidate.id === requested) ?? (requested ? undefined : ctx.model);
    if (!configured) return send(response, 404, { error: { message: `Unknown or unavailable model: ${requested || "(none selected)"}`, type: "invalid_request_error" } });
    // Only pass user/assistant/tool messages through. In particular, this
    // removes both forms Pi can use for its generated prompt.
    const messages = input.messages.filter((message: any) => message?.role !== "system" && message?.role !== "developer");
    const result = await ctx.modelRegistry.complete(configured, { messages } as any, { signal: ctx.signal } as any);
    send(response, 200, openAIResponse(result, configured));
  } catch (error) {
    send(response, 400, { error: { message: error instanceof Error ? error.message : String(error), type: "invalid_request_error" } });
  }
}

export default function blankProxy(pi: ExtensionAPI) {
  let server: Server | undefined;
  pi.on("session_start", (_event, ctx) => {
    server?.close();
    const port = Number(process.env.PI_BLANK_PROXY_PORT || DEFAULT_PORT);
    server = createServer((request, response) => { void readRequest(request, response, ctx); });
    server.on("error", (error) => console.error(`[blank-proxy] ${error.message}`));
    server.listen(port, "127.0.0.1", () => console.log(`[blank-proxy] listening on http://127.0.0.1:${port}/v1`));
  });
  pi.on("session_shutdown", () => {
    server?.close();
    server = undefined;
  });
}
