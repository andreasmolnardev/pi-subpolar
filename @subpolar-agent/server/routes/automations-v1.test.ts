import { describe, expect, test } from "bun:test";
import { createPocketBaseAutomationWebhookSecretStore } from "../../../packages/subpolar-persistance-pocketbase/src/automation-webhook-secrets.ts";
import { handleAutomationsV1Route } from "./automations-v1.ts";

function fakeDatabase() {
  const secrets: any[] = [];
  let secretId = 0;
  const client = {
    collection(name: string) {
      if (name !== "subpolar_automation_webhook_secrets") throw new Error(`unexpected collection ${name}`);
      return {
        async getFirstListItem(filter: string) {
          const ref = filter.match(/^credentialRef = "([^"]+)"$/)?.[1];
          const secret = secrets.find((item) => item.credentialRef === ref);
          if (!secret) throw new Error("not found");
          return secret;
        },
        async create(data: Record<string, unknown>) {
          const secret = { ...data, id: `secret-${++secretId}` };
          secrets.push(secret);
          return secret;
        },
        async update(id: string, data: Record<string, unknown>) {
          const index = secrets.findIndex((item) => item.id === id);
          if (index < 0) throw new Error("not found");
          secrets[index] = { ...secrets[index], ...data };
          return secrets[index];
        },
      };
    },
  };
  return { client: client as any, secrets };
}

function harness(options: { initial?: any; failFinalize?: boolean } = {}) {
  const { client, secrets } = fakeDatabase();
  const definitions = new Map<string, any>();
  if (options.initial) definitions.set(options.initial.id, structuredClone(options.initial));
  const deleted: string[] = [];
  const runtime = {
    definitions: {
      async create(ownerId: string, input: any) {
        const automation = { ...structuredClone(input), id: "automation-created", ownerId, createdAt: "now", updatedAt: "now" };
        definitions.set(automation.id, automation);
        return automation;
      },
      async get(ownerId: string, automationId: string) {
        const automation = definitions.get(automationId);
        return automation?.ownerId === ownerId ? automation : undefined;
      },
      async update(ownerId: string, automationId: string, patch: any) {
        const current = definitions.get(automationId);
        if (!current || current.ownerId !== ownerId || (options.failFinalize && patch.trigger?.type === "webhook")) return undefined;
        const updated = { ...current, ...structuredClone(patch) };
        definitions.set(automationId, updated);
        return updated;
      },
      async delete(ownerId: string, automationId: string) {
        const current = definitions.get(automationId);
        if (!current || current.ownerId !== ownerId) return false;
        deleted.push(automationId);
        definitions.delete(automationId);
        return true;
      },
      async list() { return [...definitions.values()]; },
    },
    executions: { async list() { return []; } },
    repositories: { schedules: { async get() { return undefined; } } },
  };
  const deps = {
    applicationDatabase: async () => client,
    firstClassAutomationFor: () => runtime,
    async body(request: Request) { return await request.json() as any; },
    json(value: unknown, status = 200) { return Response.json(value, { status }); },
    routeError(_requestId: string, code: string, message: string, status: number) { return Response.json({ error: { code, message } }, { status }); },
  };
  return { client, secrets, definitions, deleted, runtime, deps };
}

function routeContext(deps: any, path: string, body: unknown) {
  const request = new Request(`http://localhost/api/v1/automations${path}`, {
    method: path ? "PATCH" : "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const url = new URL(request.url);
  return { request, url, path: url.pathname.split("/").filter(Boolean), correlationId: "request-1", deps, authenticatedUser: { id: "owner-a" } } as any;
}

describe("authenticated webhook automation provisioning", () => {
  test("creates a webhook automation with the exact newly issued credential reference", async () => {
    const app = harness();
    const response = await handleAutomationsV1Route(routeContext(app.deps, "", {
      name: "Incoming events", agentId: "agent-a", enabled: true, promptTemplate: "Review {{ trigger.payload.event }}",
      trigger: { type: "webhook", credentialRef: "ignored-placeholder" }, actions: [],
    }));
    expect(response?.status).toBe(201);
    const result = await response!.json() as any;
    expect(result.automation.enabled).toBe(true);
    expect(result.automation.trigger.credentialRef).toBe(result.webhook.credentialRef);
    const credential = await createPocketBaseAutomationWebhookSecretStore(app.client).authenticate(result.webhook.credentialRef, result.webhook.secret);
    expect(credential).toMatchObject({ ownerId: "owner-a", automationId: result.automation.id });
    expect(app.secrets[0].secretHash).not.toBe(result.webhook.secret);
  });

  test("provisions a credential before switching an existing automation to webhook", async () => {
    const app = harness({ initial: {
      id: "automation-existing", ownerId: "owner-a", name: "Existing", agentId: "agent-a", enabled: true,
      promptTemplate: "Review the event", trigger: { type: "manual" }, actions: [],
    } });
    const response = await handleAutomationsV1Route(routeContext(app.deps, "/automation-existing", {
      trigger: { type: "webhook" },
    }));
    expect(response?.status).toBe(200);
    const result = await response!.json() as any;
    expect(result.automation.trigger.credentialRef).toBe(result.webhook.credentialRef);
    const credential = await createPocketBaseAutomationWebhookSecretStore(app.client).authenticate(result.webhook.credentialRef, result.webhook.secret);
    expect(credential).toMatchObject({ ownerId: "owner-a", automationId: "automation-existing" });
  });

  test("removes the new definition and revokes the secret when finalization fails", async () => {
    const app = harness({ failFinalize: true });
    const response = await handleAutomationsV1Route(routeContext(app.deps, "", {
      name: "Provisioning failure", agentId: "agent-a", promptTemplate: "Review event",
      trigger: { type: "webhook" }, actions: [],
    }));
    expect(response?.status).toBe(503);
    expect(app.definitions.size).toBe(0);
    expect(app.deleted).toEqual(["automation-created"]);
    expect(app.secrets[0].revokedAt).toBeTruthy();
  });
});
