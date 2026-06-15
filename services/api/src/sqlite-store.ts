import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ActivationOutcome,
  AuditRecord,
  CodeListOptions,
  CodeListResult,
  CodeRecord,
  CodeStatus,
  CodeStore,
  LicenseStats,
  NewAuditRecord,
  NewCodeRecord,
  RenewalOutcome
} from "./store.js";

type SqliteRow = Record<string, string | number | bigint | null>;

export class SqliteCodeStore implements CodeStore {
  private database?: DatabaseSync;

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(path.resolve(this.filePath)), { recursive: true });
    const database = new DatabaseSync(this.filePath);
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS license_codes (
        id TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL UNIQUE,
        prefix TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
        bound_device_id TEXT,
        bound_device_fingerprint TEXT,
        label TEXT,
        batch TEXT,
        expires_at TEXT,
        last_renewed_at TEXT,
        last_app_version TEXT,
        reset_count INTEGER NOT NULL DEFAULT 0 CHECK (reset_count >= 0),
        max_resets INTEGER NOT NULL DEFAULT 1 CHECK (max_resets >= 0),
        created_at TEXT NOT NULL,
        activated_at TEXT
      );

      CREATE INDEX IF NOT EXISTS license_codes_created_at_idx
        ON license_codes (created_at DESC);
      CREATE INDEX IF NOT EXISTS license_codes_batch_idx
        ON license_codes (batch);
      CREATE INDEX IF NOT EXISTS license_codes_status_idx
        ON license_codes (status);

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS audit_events_created_at_idx
        ON audit_events (created_at DESC);
    `);
    this.database = database;
  }

  async create(records: NewCodeRecord[]): Promise<void> {
    const database = this.db();
    const statement = database.prepare(`
      INSERT INTO license_codes
        (id, code_hash, prefix, status, max_resets, label, batch, expires_at,
         created_at)
      VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)
    `);
    this.transaction(() => {
      for (const record of records) {
        statement.run(
          record.id,
          record.codeHash,
          record.prefix,
          record.maxResets,
          record.label ?? null,
          record.batch ?? null,
          record.expiresAt ?? null,
          new Date().toISOString()
        );
      }
    });
  }

  async activate(
    codeHash: string,
    deviceId: string,
    deviceFingerprint: string,
    appVersion: string
  ): Promise<ActivationOutcome> {
    return this.transaction(() => {
      const database = this.db();
      const row = database
        .prepare("SELECT * FROM license_codes WHERE code_hash = ?")
        .get(codeHash) as SqliteRow | undefined;
      if (!row) return { kind: "not_found" };
      const invalid = invalidRecordOutcome(row, deviceId, deviceFingerprint);
      if (invalid) return { kind: invalid };
      const existing =
        row.bound_device_id === deviceId &&
        row.bound_device_fingerprint === deviceFingerprint;
      const now = new Date().toISOString();
      database
        .prepare(`
          UPDATE license_codes
          SET bound_device_id = ?,
              bound_device_fingerprint = ?,
              activated_at = COALESCE(activated_at, ?),
              last_renewed_at = ?,
              last_app_version = ?
          WHERE id = ?
        `)
        .run(
          deviceId,
          deviceFingerprint,
          now,
          now,
          appVersion,
          String(row.id)
        );
      return {
        kind: existing ? "existing" : "activated",
        record: this.codeById(String(row.id))
      };
    });
  }

  async renew(
    codeId: string,
    deviceId: string,
    deviceFingerprint: string,
    appVersion: string
  ): Promise<RenewalOutcome> {
    return this.transaction(() => {
      const database = this.db();
      const row = database
        .prepare("SELECT * FROM license_codes WHERE id = ?")
        .get(codeId) as SqliteRow | undefined;
      if (!row) return { kind: "not_found" };
      const invalid = invalidRecordOutcome(row, deviceId, deviceFingerprint);
      if (invalid) return { kind: invalid };
      database
        .prepare(`
          UPDATE license_codes
          SET last_renewed_at = ?, last_app_version = ?
          WHERE id = ?
        `)
        .run(new Date().toISOString(), appVersion, codeId);
      return { kind: "renewed", record: this.codeById(codeId) };
    });
  }

  async list(options: CodeListOptions = {}): Promise<CodeListResult> {
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (options.search?.trim()) {
      clauses.push(
        "LOWER(prefix || ' ' || COALESCE(label, '') || ' ' || COALESCE(batch, '') || ' ' || id) LIKE ?"
      );
      values.push(`%${options.search.trim().toLowerCase()}%`);
    }
    if (options.status && options.status !== "all") {
      clauses.push("status = ?");
      values.push(options.status);
    }
    if (options.batch?.trim()) {
      clauses.push("batch = ?");
      values.push(options.batch.trim());
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const offset = Math.max(options.offset ?? 0, 0);
    const rows = this.db()
      .prepare(`
        SELECT * FROM license_codes
        ${where}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `)
      .all(...values, limit, offset) as SqliteRow[];
    const count = this.db()
      .prepare(`SELECT COUNT(*) AS total FROM license_codes ${where}`)
      .get(...values) as SqliteRow;
    return {
      codes: rows.map(mapCodeRow),
      total: Number(count.total ?? 0)
    };
  }

  async reset(
    id: string,
    codeHash?: string
  ): Promise<"ok" | "not_found" | "limit_reached"> {
    return this.transaction(() => {
      const row = this.find(id, codeHash);
      if (!row) return "not_found";
      if (Number(row.reset_count) >= Number(row.max_resets)) {
        return "limit_reached";
      }
      this.db()
        .prepare(`
          UPDATE license_codes
          SET bound_device_id = NULL,
              bound_device_fingerprint = NULL,
              activated_at = NULL,
              last_renewed_at = NULL,
              last_app_version = NULL,
              reset_count = reset_count + 1
          WHERE id = ?
        `)
        .run(String(row.id));
      return "ok";
    });
  }

  async disable(id: string, codeHash?: string): Promise<boolean> {
    return this.setStatus("disabled", id, codeHash);
  }

  async enable(id: string, codeHash?: string): Promise<boolean> {
    return this.setStatus("active", id, codeHash);
  }

  async stats(): Promise<LicenseStats> {
    const now = new Date().toISOString();
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const row = this.db()
      .prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
          SUM(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END) AS disabled,
          SUM(CASE WHEN expires_at IS NOT NULL AND expires_at <= ? THEN 1 ELSE 0 END) AS expired,
          SUM(CASE WHEN bound_device_id IS NOT NULL THEN 1 ELSE 0 END) AS bound,
          SUM(CASE WHEN bound_device_id IS NULL THEN 1 ELSE 0 END) AS unbound,
          SUM(CASE WHEN last_renewed_at >= ? THEN 1 ELSE 0 END) AS renewed_last_24_hours
        FROM license_codes
      `)
      .get(now, yesterday) as SqliteRow;
    return {
      total: Number(row.total ?? 0),
      active: Number(row.active ?? 0),
      disabled: Number(row.disabled ?? 0),
      expired: Number(row.expired ?? 0),
      bound: Number(row.bound ?? 0),
      unbound: Number(row.unbound ?? 0),
      renewedLast24Hours: Number(row.renewed_last_24_hours ?? 0)
    };
  }

  async addAudit(record: NewAuditRecord): Promise<void> {
    this.db()
      .prepare(`
        INSERT INTO audit_events
          (id, actor, action, target_type, target_id, metadata, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.id,
        record.actor,
        record.action,
        record.targetType ?? null,
        record.targetId ?? null,
        JSON.stringify(record.metadata ?? {}),
        new Date().toISOString()
      );
  }

  async listAudit(limit = 100): Promise<AuditRecord[]> {
    const rows = this.db()
      .prepare(`
        SELECT * FROM audit_events
        ORDER BY created_at DESC
        LIMIT ?
      `)
      .all(Math.min(Math.max(limit, 1), 500)) as SqliteRow[];
    return rows.map(mapAuditRow);
  }

  async health(): Promise<void> {
    this.db().prepare("SELECT 1").get();
  }

  async close(): Promise<void> {
    this.database?.close();
    this.database = undefined;
  }

  private db(): DatabaseSync {
    if (!this.database) throw new Error("SQLite store is not initialized");
    return this.database;
  }

  private transaction<T>(operation: () => T): T {
    const database = this.db();
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the original database error.
      }
      throw error;
    }
  }

  private codeById(id: string): CodeRecord {
    const row = this.db()
      .prepare("SELECT * FROM license_codes WHERE id = ?")
      .get(id) as SqliteRow | undefined;
    if (!row) throw new Error(`Code disappeared during transaction: ${id}`);
    return mapCodeRow(row);
  }

  private find(id: string, codeHash?: string): SqliteRow | undefined {
    return this.db()
      .prepare(`
        SELECT * FROM license_codes
        WHERE id = ? OR (? IS NOT NULL AND code_hash = ?)
        LIMIT 1
      `)
      .get(id, codeHash ?? null, codeHash ?? null) as SqliteRow | undefined;
  }

  private setStatus(
    status: CodeStatus,
    id: string,
    codeHash?: string
  ): boolean {
    const result = this.db()
      .prepare(`
        UPDATE license_codes SET status = ?
        WHERE id = ? OR (? IS NOT NULL AND code_hash = ?)
      `)
      .run(status, id, codeHash ?? null, codeHash ?? null);
    return result.changes > 0;
  }
}

function invalidRecordOutcome(
  row: SqliteRow,
  deviceId: string,
  deviceFingerprint: string
): "disabled" | "expired" | "bound_to_other_device" | undefined {
  if (row.status !== "active") return "disabled";
  if (row.expires_at && String(row.expires_at) <= new Date().toISOString()) {
    return "expired";
  }
  if (
    row.bound_device_id &&
    (String(row.bound_device_id) !== deviceId ||
      (row.bound_device_fingerprint &&
        String(row.bound_device_fingerprint) !== deviceFingerprint))
  ) {
    return "bound_to_other_device";
  }
  return undefined;
}

function mapCodeRow(row: SqliteRow): CodeRecord {
  return {
    id: String(row.id),
    prefix: String(row.prefix),
    status: row.status as CodeStatus,
    label: nullableString(row.label),
    batch: nullableString(row.batch),
    boundDeviceId: nullableString(row.bound_device_id),
    resetCount: Number(row.reset_count),
    maxResets: Number(row.max_resets),
    createdAt: String(row.created_at),
    activatedAt: nullableString(row.activated_at),
    expiresAt: nullableString(row.expires_at),
    lastRenewedAt: nullableString(row.last_renewed_at),
    lastAppVersion: nullableString(row.last_app_version)
  };
}

function mapAuditRow(row: SqliteRow): AuditRecord {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(String(row.metadata)) as Record<string, unknown>;
  } catch {
    // A damaged audit payload must not make the administration API unavailable.
  }
  return {
    id: String(row.id),
    actor: String(row.actor),
    action: String(row.action),
    targetType: nullableString(row.target_type),
    targetId: nullableString(row.target_id),
    metadata,
    createdAt: String(row.created_at)
  };
}

function nullableString(
  value: string | number | bigint | null | undefined
): string | null {
  return value === null || value === undefined ? null : String(value);
}
