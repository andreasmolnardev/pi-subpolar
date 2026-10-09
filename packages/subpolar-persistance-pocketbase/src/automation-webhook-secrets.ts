import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type PocketBase from "pocketbase";

export interface AutomationWebhookSecretRecord {
  id: string;
  ownerId: string;
  automationId: string;
  credentialRef: string;
  secretHash: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface IssuedAutomationWebhookSecret {
  credentialRef: string;
  /** Returned only from the creation/rotation call. Never persisted. */
  secret: string;
}

export interface AutomationWebhookCredential {
  ownerId: string;
  automationId: string;
  credentialRef: string;
}

type WebhookSecretCollection = {
  getFirstListItem(filter: string): Promise<AutomationWebhookSecretRecord>;
  create(data: Record<string, unknown>): Promise<AutomationWebhookSecretRecord>;
  update(id: string, data: Record<string, unknown>): Promise<AutomationWebhookSecretRecord>;
};

export type WebhookSecretDatabase = Pick<PocketBase, "collection">;

function digest(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function validRef(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value);
}

function secureMatches(candidate: string, expectedHex: string): boolean {
  const candidateHash = Buffer.from(digest(candidate), "hex");
  const expectedHash = /^[a-f0-9]{64}$/.test(expectedHex) ? Buffer.from(expectedHex, "hex") : Buffer.alloc(32);
  // Both values are fixed-length SHA-256 digests before the constant-time comparison.
  return timingSafeEqual(candidateHash, expectedHash) && /^[a-f0-9]{64}$/.test(expectedHex);
}

export class PocketBaseAutomationWebhookSecretStore {
  private readonly collection: WebhookSecretCollection;

  constructor(client: WebhookSecretDatabase, private readonly now: () => Date = () => new Date()) {
    this.collection = client.collection("subpolar_automation_webhook_secrets") as unknown as WebhookSecretCollection;
  }

  /** Create a credential reference or rotate its secret while keeping the reference stable. */
  async createOrRotate(ownerId: string, automationId: string, credentialRef?: string): Promise<IssuedAutomationWebhookSecret> {
    if (!ownerId || !automationId) throw new TypeError("Webhook credential owner and automation are required");
    if (credentialRef !== undefined && !validRef(credentialRef)) throw new TypeError("Invalid webhook credential reference");
    const existing = credentialRef ? await this.findCredential(credentialRef) : undefined;
    if (credentialRef && !existing) throw new Error("Webhook credential is unavailable");
    if (existing && (existing.ownerId !== ownerId || existing.automationId !== automationId || existing.revokedAt)) {
      throw new Error("Webhook credential is unavailable");
    }
    const nextRef = credentialRef ?? `wh_${randomBytes(18).toString("base64url")}`;
    const secret = `spwh_${randomBytes(32).toString("base64url")}`;
    const timestamp = this.now().toISOString();
    const patch = { ownerId, automationId, credentialRef: nextRef, secretHash: digest(secret), updatedAt: timestamp, revokedAt: null };
    if (existing) await this.collection.update(existing.id, patch);
    else await this.collection.create({ ...patch, createdAt: timestamp });
    return { credentialRef: nextRef, secret };
  }

  async revoke(ownerId: string, automationId: string, credentialRef: string): Promise<boolean> {
    const record = await this.findCredential(credentialRef);
    if (!record || record.ownerId !== ownerId || record.automationId !== automationId || record.revokedAt) return false;
    const timestamp = this.now().toISOString();
    await this.collection.update(record.id, { revokedAt: timestamp, updatedAt: timestamp });
    return true;
  }

  async authenticate(credentialRef: string, suppliedSecret: string): Promise<AutomationWebhookCredential | undefined> {
    if (!validRef(credentialRef)) return undefined;
    const record = await this.findCredential(credentialRef);
    const candidate = typeof suppliedSecret === "string" ? suppliedSecret.slice(0, 512) : "";
    // Hash and compare even for revoked/unknown records to avoid a cheap timing oracle.
    const matches = secureMatches(candidate, record?.secretHash ?? "");
    if (!record || record.revokedAt || !matches) return undefined;
    const timestamp = this.now().toISOString();
    await this.collection.update(record.id, { lastUsedAt: timestamp, updatedAt: timestamp }).catch(() => undefined);
    return { ownerId: record.ownerId, automationId: record.automationId, credentialRef: record.credentialRef };
  }

  async findCredential(credentialRef: string): Promise<AutomationWebhookSecretRecord | undefined> {
    if (!validRef(credentialRef)) return undefined;
    return await this.collection.getFirstListItem(`credentialRef = "${credentialRef}"`).catch(() => undefined);
  }
}

export function createPocketBaseAutomationWebhookSecretStore(client: WebhookSecretDatabase, now?: () => Date): PocketBaseAutomationWebhookSecretStore {
  return new PocketBaseAutomationWebhookSecretStore(client, now);
}

/** Convenience operation for authenticated route integration; plaintext exists only in this return value. */
export async function createOrRotateAutomationWebhookSecret(
  client: WebhookSecretDatabase,
  ownerId: string,
  automationId: string,
  credentialRef?: string,
  now?: () => Date,
): Promise<IssuedAutomationWebhookSecret> {
  return createPocketBaseAutomationWebhookSecretStore(client, now).createOrRotate(ownerId, automationId, credentialRef);
}
