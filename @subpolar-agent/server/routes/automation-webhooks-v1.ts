import type { BridgeRequestContext } from "../bridge-route-context.ts";
import { createPocketBaseAutomationWebhookSecretStore } from "../../../packages/subpolar-persistance-pocketbase/src/automation-webhook-secrets.ts";
import type { JsonValue, TriggerInput } from "../../../packages/subpolar-automations/src/types.ts";

const MAX_BODY_BYTES = 128 * 1024;
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 30;
const MAX_GLOBAL_REQUESTS_PER_WINDOW = 5_000;
const MAX_BUCKETS = 8_192;
const buckets = new Map<string, { startedAt: number; count: number }>();
let globalBucket = { startedAt: Date.now(), count: 0 };
let lastPruneAt = 0;

function routeError(context: BridgeRequestContext, code: string, message: string, status: number, headers?: Record<string, string>): Response {
  return context.deps.json({ error: { code, message } }, status, context.correlationId, headers);
}

function allowRequest(credentialRef: string, now = Date.now()): { allowed: boolean; retryAfterSeconds?: number } {
  if (now - globalBucket.startedAt >= WINDOW_MS) globalBucket = { startedAt: now, count: 0 };
  globalBucket.count += 1;
  if (globalBucket.count > MAX_GLOBAL_REQUESTS_PER_WINDOW) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((globalBucket.startedAt + WINDOW_MS - now) / 1000)) };
  }
  if (now - lastPruneAt > WINDOW_MS) {
    for (const [key, bucket] of buckets) if (now - bucket.startedAt >= WINDOW_MS) buckets.delete(key);
    lastPruneAt = now;
  }
  let bucket = buckets.get(credentialRef);
  if (!bucket || now - bucket.startedAt >= WINDOW_MS) {
    if (buckets.size >= MAX_BUCKETS) return { allowed: false, retryAfterSeconds: 60 };
    bucket = { startedAt: now, count: 0 };
    buckets.set(credentialRef, bucket);
  }
  bucket.count += 1;
  if (bucket.count <= MAX_REQUESTS_PER_WINDOW) return { allowed: true };
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.startedAt + WINDOW_MS - now) / 1000)) };
}

async function readBoundedJson(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|\s*$)/i.test(contentType)) throw Object.assign(new Error("Request body must be JSON"), { code: "INVALID_CONTENT_TYPE", status: 415 });
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_BODY_BYTES)) {
    throw Object.assign(new Error("Webhook body exceeds the 128 KiB limit"), { code: "WEBHOOK_BODY_TOO_LARGE", status: 413 });
  }
  if (!request.body) throw Object.assign(new Error("Webhook request body is required"), { code: "INVALID_JSON", status: 400 });
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw Object.assign(new Error("Webhook body exceeds the 128 KiB limit"), { code: "WEBHOOK_BODY_TOO_LARGE", status: 413 });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw Object.assign(new Error("Webhook body must contain valid UTF-8 JSON"), { code: "INVALID_JSON", status: 400 }); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Object.assign(new Error("Webhook body must be a JSON object"), { code: "INVALID_JSON", status: 400 });
  }
  return parsed as Record<string, unknown>;
}

function bearerSecret(request: Request): string | undefined {
  const value = request.headers.get("authorization") ?? "";
  const match = value.match(/^Bearer ([A-Za-z0-9_-]{32,128})$/);
  return match?.[1];
}

function idempotencyKey(request: Request): string | undefined {
  const value = request.headers.get("idempotency-key");
  if (!value || value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) return undefined;
  return value;
}

/** Public route; the high-entropy Bearer secret is the sole authentication credential. */
export async function handleAutomationWebhooksV1Route(context: BridgeRequestContext): Promise<Response | undefined> {
  const { request, path, deps } = context;
  if (path[0] !== "api" || path[1] !== "v1" || path[2] !== "automation-webhooks") return undefined;
  if (request.method !== "POST" || path.length !== 4) return routeError(context, "METHOD_NOT_ALLOWED", "Webhook triggers accept POST requests only", 405, { allow: "POST" });

  const credentialRef = path[3] ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(credentialRef)) return routeError(context, "WEBHOOK_NOT_FOUND", "Webhook credential not found", 404);

  const secret = bearerSecret(request);
  if (!secret) return routeError(context, "WEBHOOK_AUTH_REQUIRED", "A valid Bearer webhook secret is required", 401, { "www-authenticate": "Bearer" });
  const key = idempotencyKey(request);
  if (!key) return routeError(context, "IDEMPOTENCY_KEY_REQUIRED", "A valid Idempotency-Key header is required", 400);

  try {
    const client = await deps.applicationDatabase();
    const credentials = await createPocketBaseAutomationWebhookSecretStore(client).authenticate(credentialRef, secret);
    if (!credentials) return routeError(context, "WEBHOOK_AUTH_INVALID", "Webhook credential is invalid", 401, { "www-authenticate": "Bearer" });

    // Only authenticated callers can consume the per-webhook and accepted
    // delivery budgets. The credential reference is public and must not let
    // an unauthenticated caller exhaust another owner's webhook allowance.
    const rate = allowRequest(credentialRef);
    if (!rate.allowed) return routeError(context, "WEBHOOK_RATE_LIMITED", "Webhook request rate limit exceeded", 429, { "retry-after": String(rate.retryAfterSeconds) });

    const runtime = deps.firstClassAutomationFor(client, credentials.ownerId);
    const automation = await runtime.definitions.get(credentials.ownerId, credentials.automationId);
    if (!automation || automation.ownerId !== credentials.ownerId || automation.trigger.type !== "webhook" || automation.trigger.credentialRef !== credentialRef) {
      return routeError(context, "WEBHOOK_NOT_FOUND", "Webhook trigger is unavailable", 404);
    }
    const payload = await readBoundedJson(request);
    const trigger: TriggerInput = { kind: "webhook", payload: payload as JsonValue, occurredAt: new Date().toISOString() };
    const result = await runtime.deliver(credentials.ownerId, credentials.automationId, trigger, `webhook:${key}`, undefined, true);
    if (!result.accepted || !result.execution) return routeError(context, "WEBHOOK_TRIGGER_REJECTED", "Webhook trigger was rejected", 409);
    return deps.json({ accepted: true, duplicate: result.duplicate, executionId: result.execution.id, status: result.execution.status }, result.duplicate ? 200 : 202, context.correlationId);
  } catch (error) {
    const candidate = error as { code?: unknown; status?: unknown; message?: unknown };
    const status = typeof candidate.status === "number" ? candidate.status : 503;
    const code = typeof candidate.code === "string" ? candidate.code : "WEBHOOK_TRIGGER_UNAVAILABLE";
    const message = typeof candidate.message === "string" ? candidate.message : "Webhook trigger service is unavailable";
    return routeError(context, code, message, status);
  }
}
