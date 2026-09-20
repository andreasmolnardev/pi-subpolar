import type {
  PocketBaseClientPort,
  PocketBaseCollectionPort,
  PocketBaseStoredRecord,
} from "../packages/subpolar-adapter-pocketbase/src/index.ts";

export class InMemoryPocketBaseCollection implements PocketBaseCollectionPort {
  private readonly records = new Map<string, PocketBaseStoredRecord>();
  private nextId = 1;

  async list(): Promise<readonly PocketBaseStoredRecord[]> {
    return [...this.records.values()].map((record) => structuredClone(record));
  }

  async get(id: string): Promise<PocketBaseStoredRecord | undefined> {
    const record = this.records.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async create(data: Record<string, unknown>): Promise<PocketBaseStoredRecord> {
    const id = typeof data.id === "string" ? data.id : `record-${this.nextId++}`;
    const record = { id, ...structuredClone(data) };
    this.records.set(id, record);
    return structuredClone(record);
  }

  async update(id: string, data: Record<string, unknown>): Promise<PocketBaseStoredRecord | undefined> {
    const existing = this.records.get(id);
    if (!existing) return undefined;
    const record = { ...existing, ...structuredClone(data), id };
    this.records.set(id, record);
    return structuredClone(record);
  }

  seed(record: PocketBaseStoredRecord): void {
    this.records.set(record.id, structuredClone(record));
  }
}

export class InMemoryPocketBaseClient implements PocketBaseClientPort {
  private readonly collections = new Map<string, InMemoryPocketBaseCollection>();

  collection(name: string): InMemoryPocketBaseCollection {
    let collection = this.collections.get(name);
    if (!collection) {
      collection = new InMemoryPocketBaseCollection();
      this.collections.set(name, collection);
    }
    return collection;
  }
}
