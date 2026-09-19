import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  AdapterCapabilities,
  SessionRecord,
  SessionStore,
  SessionTranscriptEntry,
} from "../../subpolar-contracts/src/index.ts";
import { UnsupportedCapabilityError } from "../../subpolar-contracts/src/index.ts";

const ephemeralCapabilities: AdapterCapabilities = {
  adapter: "local-ephemeral",
  durability: "ephemeral",
  supports: {
    "session.persistence": false,
    "event.replay": false,
    "multi-process-concurrency": false,
    "durable-approvals": false,
  },
};

const jsonFileCapabilities: AdapterCapabilities = {
  adapter: "local-json-file",
  durability: "json-file",
  supports: {
    "session.persistence": true,
    "event.replay": false,
    "multi-process-concurrency": false,
    "durable-approvals": false,
  },
};

const forbiddenSessionIds = new Set([
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "__proto__",
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "prototype",
  "toLocaleString",
  "toString",
  "valueOf",
]);

function assertSessionId(sessionId: unknown): asserts sessionId is string {
  if (
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    sessionId.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(sessionId) ||
    forbiddenSessionIds.has(sessionId)
  ) {
    throw new Error("Session ID must be a safe non-empty identifier");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertTimestamp(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value || Number.isNaN(Date.parse(value))) {
    throw new Error(`Invalid session ${field}`);
  }
}

function validateEntry(value: unknown, location: string): SessionTranscriptEntry {
  if (!isPlainObject(value) || !["user", "assistant", "tool"].includes(value.role as string)) {
    throw new Error(`Invalid transcript entry at ${location}`);
  }
  if (Object.keys(value).some((key) => !["role", "content", "occurredAt"].includes(key))) {
    throw new Error(`Invalid transcript entry at ${location}`);
  }
  if (typeof value.content !== "string") throw new Error(`Invalid transcript content at ${location}`);
  assertTimestamp(value.occurredAt, `${location}.occurredAt`);
  return { role: value.role as SessionTranscriptEntry["role"], content: value.content, occurredAt: value.occurredAt };
}

function validateRecord(key: string, value: unknown): SessionRecord {
  assertSessionId(key);
  if (!isPlainObject(value) || value.sessionId !== key || !Array.isArray(value.transcript)) {
    throw new Error(`Invalid session record for ${key}`);
  }
  if (Object.keys(value).some((field) => !["sessionId", "transcript", "updatedAt"].includes(field))) {
    throw new Error(`Invalid session record for ${key}`);
  }
  assertTimestamp(value.updatedAt, `${key}.updatedAt`);
  return {
    sessionId: key,
    transcript: value.transcript.map((entry, index) => validateEntry(entry, `${key}.transcript[${index}]`)),
    updatedAt: value.updatedAt,
  };
}

function copyRecord(record: SessionRecord): SessionRecord {
  return { sessionId: record.sessionId, updatedAt: record.updatedAt, transcript: record.transcript.map((entry) => ({ ...entry })) };
}

export class EphemeralSessionStore implements SessionStore {
  readonly capabilities = ephemeralCapabilities;
  private readonly records = new Map<string, SessionRecord>();

  async load(sessionId: string): Promise<SessionRecord | undefined> {
    assertSessionId(sessionId);
    const record = this.records.get(sessionId);
    return record ? copyRecord(record) : undefined;
  }

  async append(sessionId: string, entries: SessionTranscriptEntry[]): Promise<SessionRecord> {
    assertSessionId(sessionId);
    if (!Array.isArray(entries)) throw new Error("Transcript entries must be an array");
    const validatedEntries = entries.map((entry, index) => validateEntry(entry, `append.transcript[${index}]`));
    const existing = this.records.get(sessionId) ?? { sessionId, transcript: [], updatedAt: new Date().toISOString() };
    const record: SessionRecord = {
      sessionId,
      transcript: [...existing.transcript, ...validatedEntries],
      updatedAt: new Date().toISOString(),
    };
    this.records.set(sessionId, record);
    return copyRecord(record);
  }

  async persist(): Promise<never> {
    throw new UnsupportedCapabilityError("session.persistence", this.capabilities.adapter, "Ephemeral sessions are not persisted; configure a JSON file explicitly");
  }
}

export class JsonFileSessionStore implements SessionStore {
  readonly capabilities = jsonFileCapabilities;
  readonly filePath: string;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    if (!filePath.trim()) throw new Error("A JSON session file path is required");
    this.filePath = filePath;
  }

  private async readRecords(): Promise<Record<string, SessionRecord>> {
    try {
      const text = await readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(text);
      if (!isPlainObject(parsed)) throw new Error("Session file must contain an object");
      const records = Object.create(null) as Record<string, SessionRecord>;
      for (const key of Object.keys(parsed)) records[key] = validateRecord(key, parsed[key]);
      return records;
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return Object.create(null) as Record<string, SessionRecord>;
      throw error;
    }
  }

  private async writeRecords(records: Record<string, SessionRecord>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporaryPath, `${JSON.stringify(records, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async load(sessionId: string): Promise<SessionRecord | undefined> {
    assertSessionId(sessionId);
    return this.serialize(async () => {
      const records = await this.readRecords();
      const record = records[sessionId];
      return record ? copyRecord(record) : undefined;
    });
  }

  async append(sessionId: string, entries: SessionTranscriptEntry[]): Promise<SessionRecord> {
    assertSessionId(sessionId);
    if (!Array.isArray(entries)) throw new Error("Transcript entries must be an array");
    const validatedEntries = entries.map((entry, index) => validateEntry(entry, `append.transcript[${index}]`));
    return this.serialize(async () => {
      const records = await this.readRecords();
      const existing = records[sessionId] ?? { sessionId, transcript: [], updatedAt: new Date().toISOString() };
      const record: SessionRecord = {
        sessionId,
        transcript: [...existing.transcript, ...validatedEntries],
        updatedAt: new Date().toISOString(),
      };
      records[sessionId] = record;
      await this.writeRecords(records);
      return copyRecord(record);
    });
  }
}

export interface LocalAdapterOptions {
  sessionFile?: string;
}

export interface LocalAdapter {
  readonly sessions: SessionStore;
  readonly capabilities: AdapterCapabilities;
}

export function createLocalAdapter(options: LocalAdapterOptions = {}): LocalAdapter {
  const sessions = options.sessionFile ? new JsonFileSessionStore(options.sessionFile) : new EphemeralSessionStore();
  return { sessions, capabilities: sessions.capabilities };
}
