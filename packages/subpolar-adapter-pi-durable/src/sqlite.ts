import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { SqliteStorage, type SqliteDatabase, type SqliteExecutor, type SqliteValue } from "@earendil-works/pi-durable/storage/sqlite";

export interface SqliteOptions {
  readonly walAutoCheckpointPages?: number;
  readonly busyTimeoutMs?: number;
}

const ignore = () => {};

class SerialQueue {
  #tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(ignore, ignore);
    return result;
  }
}

interface TransactionScope {
  active: boolean;
}

type BunStatement = ReturnType<Database["prepare"]>;

class BunSqliteExecutor implements SqliteExecutor {
  constructor(
    protected readonly database: Database,
    protected readonly statements: Map<string, BunStatement>,
  ) {}

  async exec(sql: string): Promise<void> {
    this.database.exec(sql);
  }

  async run(sql: string, ...params: SqliteValue[]): Promise<void> {
    this.statement(sql).run(...params);
  }

  async get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
    return (this.statement(sql).get(...params) ?? undefined) as T | undefined;
  }

  async all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
    return this.statement(sql).all(...params) as T[];
  }

  protected statement(sql: string): BunStatement {
    let statement = this.statements.get(sql);
    if (statement === undefined) {
      statement = this.database.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
}

class BunSqliteTransaction extends BunSqliteExecutor {
  constructor(database: Database, statements: Map<string, BunStatement>, private readonly scope: TransactionScope) {
    super(database, statements);
  }

  override async exec(sql: string): Promise<void> {
    this.assertActive();
    this.database.exec(sql);
  }

  override async run(sql: string, ...params: SqliteValue[]): Promise<void> {
    this.assertActive();
    this.statement(sql).run(...params);
  }

  override async get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
    this.assertActive();
    return (this.statement(sql).get(...params) ?? undefined) as T | undefined;
  }

  override async all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
    this.assertActive();
    return this.statement(sql).all(...params) as T[];
  }

  private assertActive(): void {
    if (!this.scope.active) throw new Error("SQLite transaction handle is no longer active");
  }
}

/** Single-connection Bun SQLite facade with serialized operations and rollback-safe async transactions. */
export class BunSqliteDatabase extends BunSqliteExecutor implements SqliteDatabase {
  #queue = new SerialQueue();
  #closed = false;
  #closing = false;

  constructor(database: Database) {
    super(database, new Map());
  }

  override exec(sql: string): Promise<void> {
    return this.#operation(() => {
      this.database.exec(sql);
    });
  }

  override run(sql: string, ...params: SqliteValue[]): Promise<void> {
    return this.#operation(() => {
      this.statement(sql).run(...params);
    });
  }

  override get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
    return this.#operation(() => (this.statement(sql).get(...params) ?? undefined) as T | undefined);
  }

  override all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
    return this.#operation(() => this.statement(sql).all(...params) as T[]);
  }

  transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
    if (this.#closing || this.#closed) return Promise.reject(new Error("SQLite database is closed"));
    return this.#queue.run(async () => {
      this.#assertOpen();
      this.database.exec("BEGIN IMMEDIATE");
      const scope: TransactionScope = { active: true };
      try {
        const result = await callback(new BunSqliteTransaction(this.database, this.statements, scope));
        scope.active = false;
        this.database.exec("COMMIT");
        return result;
      } catch (error) {
        scope.active = false;
        try {
          this.database.exec("ROLLBACK");
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "SQLite transaction failed and rollback failed");
        }
        throw error;
      }
    });
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#closing) return this.#queue.run(() => {});
    this.#closing = true;
    return this.#queue.run(() => {
      if (this.#closed) return;
      this.#closed = true;
      try {
        for (const statement of this.statements.values()) statement.finalize();
        this.statements.clear();
        this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } finally {
        this.database.close();
      }
    });
  }

  #operation<T>(operation: () => T): Promise<T> {
    if (this.#closing || this.#closed) return Promise.reject(new Error("SQLite database is closed"));
    return this.#queue.run(() => {
      this.#assertOpen();
      return operation();
    });
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("SQLite database is closed");
  }
}

export async function openBunSqliteDatabase(path: string, options: SqliteOptions = {}): Promise<BunSqliteDatabase> {
  if (path !== ":memory:") await mkdir(dirname(path), { recursive: true });
  const database = new Database(path, { create: true, readwrite: true });
  const adapter = new BunSqliteDatabase(database);
  try {
    await adapter.exec("PRAGMA journal_mode = WAL");
    await adapter.exec("PRAGMA synchronous = NORMAL");
    await adapter.exec(`PRAGMA wal_autocheckpoint = ${options.walAutoCheckpointPages ?? 1_000}`);
    await adapter.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5_000}`);
    return adapter;
  } catch (error) {
    try {
      await adapter.close();
    } catch {
      // Preserve the configuration failure.
    }
    throw error;
  }
}

export async function openBunSqliteStorage(path: string, options?: SqliteOptions): Promise<SqliteStorage> {
  return SqliteStorage.open(await openBunSqliteDatabase(path, options));
}
