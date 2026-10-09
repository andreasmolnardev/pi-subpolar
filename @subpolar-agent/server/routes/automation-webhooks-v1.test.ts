import { describe, expect, test } from "bun:test";
import { createPocketBaseAutomationWebhookSecretStore } from "../../../packages/subpolar-persistance-pocketbase/src/automation-webhook-secrets.ts";
import { handleAutomationWebhooksV1Route } from "./automation-webhooks-v1.ts";

function fakeDatabase() {
  const records: any[] = [];
  let id = 0;
  const client = {
    collection(name: string) {
      if (name !== "subpolar_automation_webhook_secrets") throw new Error(`unexpected collection ${name}`);
      return {
        async getFirstListItem(filter: string) {
          const ref = filter.match(/^credentialRef = "([^"]+)"$/)?.[1];
          const record = records.find((item) => item.credentialRef === ref);
          if (!record) throw new Error("not found");
          return record;
        },
        async create(data: Record<string, unknown>) {
          const record = { ...data, id: `secret-${++id}` };
          records.push(record);
          return record;
        },
        async update(recordId: string, data: Record<string, unknown>) {
          const index = records.findIndex((item) => item.id === recordId);
          if (index < 0) throw new Error("not found");
          records[index] = { ...records[index], ...data };
          return records[index];
        },
      };
    },
  };
  return { client: client as any, records };
}

function context(request: Request, client: any, runtimeFactory: (ownerId: string) => unknown) {
  const url = new URL(request.url);
  return {
    request,
    url,
    path: url.pathname.split("/").filter(Boolean),
    correlationId: "request-1",
    authenticatedUser: null,
    gatewayCredential: null,
    internalRequest: false,
    deps: {
      applicationDatabase: async () => client,
      firstClassAutomationFor: (_client: unknown, ownerId: string) => runtimeFactory(ownerId),
      json(value: unknown, status = 200, _requestId?: string, headers?: Record<string, string>) {
        return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
      },
    },
  } as any;
}

function request(path: string, secret: string, options: { body?: string; idempotencyKey?: string; contentType?: string; contentLength?: string } = {}) {
  const headers = new Headers({ authorization: `Bearer ${secret}`, "content-type": options.contentType ?? "application/json" });
  if (options.idempotencyKey !== undefined) headers.set("idempotency-key", options.idempotencyKey);
  if (options.contentLength !== undefined) headers.set("content-length", options.contentLength);
  return new Request(`http://localhost${path}`, { method: "POST", headers, body: options.body ?? JSON.stringify({ event: "created" }) });
}

describe("automation webhook credentials and route", () => {
  test("persists only a hash, authenticates in constant-time form, rotates, and revokes", async () => {
    const { client, records } = fakeDatabase();
    const store = createPocketBaseAutomationWebhookSecretStore(client, () => new Date("2026-01-01T00:00:00.000Z"));
    const first = await store.createOrRotate("owner-a", "automation-a");
    expect(records[0].secretHash).not.toBe(first.secret);
    expect(records[0]).not.toHaveProperty("secret");
    expect(await store.authenticate(first.credentialRef, first.secret)).toMatchObject({ ownerId: "owner-a", automationId: "automation-a" });
    expect(await store.authenticate(first.credentialRef, "incorrect-secret" )).toBeUndefined();

    const rotated = await store.createOrRotate("owner-a", "automation-a", first.credentialRef);
    expect(rotated.credentialRef).toBe(first.credentialRef);
    expect(await store.authenticate(first.credentialRef, first.secret)).toBeUndefined();
    expect(await store.authenticate(first.credentialRef, rotated.secret)).toMatchObject({ ownerId: "owner-a", automationId: "automation-a" });
    expect(await store.revoke("owner-a", "automation-a", first.credentialRef)).toBe(true);
    expect(await store.authenticate(first.credentialRef, rotated.secret)).toBeUndefined();
  });

  test("requires a bearer secret and idempotency key, then deduplicates webhook delivery", async () => {
    const { client } = fakeDatabase();
    const issued = await createPocketBaseAutomationWebhookSecretStore(client).createOrRotate("owner-a", "automation-a");
    const deliveries: string[] = [];
    const runtimeFactory = (ownerId: string) => ({
      definitions: { async get(requestedOwner: string, automationId: string) {
        return requestedOwner === ownerId && automationId === "automation-a"
          ? { id: automationId, ownerId, agentId: "agent-a", enabled: true, trigger: { type: "webhook", credentialRef: issued.credentialRef } }
          : undefined;
      } },
      async deliver(receivedOwner: string, automationId: string, trigger: any, occurrenceKey: string) {
        deliveries.push(occurrenceKey);
        expect(receivedOwner).toBe(ownerId);
        expect(automationId).toBe("automation-a");
        expect(trigger.payload).toEqual({ event: "created" });
        return { accepted: true, duplicate: deliveries.length > 1, execution: { id: "exec-1", status: "completed" } };
      },
    });

    const urlPath = `/api/v1/automation-webhooks/${issued.credentialRef}`;
    const missingKey = await handleAutomationWebhooksV1Route(context(request(urlPath, issued.secret), client, runtimeFactory));
    expect(missingKey?.status).toBe(400);
    const invalidSecret = await handleAutomationWebhooksV1Route(context(request(urlPath, "x".repeat(40), { idempotencyKey: "delivery-1" }), client, runtimeFactory));
    expect(invalidSecret?.status).toBe(401);

    const first = await handleAutomationWebhooksV1Route(context(request(urlPath, issued.secret, { idempotencyKey: "delivery-1" }), client, runtimeFactory));
    expect(first?.status).toBe(202);
    expect(deliveries).toEqual(["webhook:delivery-1"]);
    const duplicate = await handleAutomationWebhooksV1Route(context(request(urlPath, issued.secret, { idempotencyKey: "delivery-1" }), client, runtimeFactory));
    expect(duplicate?.status).toBe(200);
  });

  test("rejects oversize bodies before invoking trigger execution", async () => {
    const { client } = fakeDatabase();
    const issued = await createPocketBaseAutomationWebhookSecretStore(client).createOrRotate("owner-b", "automation-b");
    let delivered = false;
    const runtimeFactory = (ownerId: string) => ({
      definitions: { async get() { return { id: "automation-b", ownerId, enabled: true, trigger: { type: "webhook", credentialRef: issued.credentialRef } }; } },
      async deliver() { delivered = true; return { accepted: true, duplicate: false, execution: { id: "e" } }; },
    });
    const response = await handleAutomationWebhooksV1Route(context(
      request(`/api/v1/automation-webhooks/${issued.credentialRef}`, issued.secret, { idempotencyKey: "large", contentLength: "131073" }),
      client,
      runtimeFactory,
    ));
    expect(response?.status).toBe(413);
    expect(delivered).toBe(false);
  });
});
