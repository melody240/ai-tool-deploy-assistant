import { readFile, readdir } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";

export type CodeStatus = "active" | "disabled";

export interface CodeRecord {
  id: string;
  prefix: string;
  status: CodeStatus;
  label: string | null;
  batch: string | null;
  boundDeviceId: string | null;
  resetCount: number;
  maxResets: number;
  createdAt: string;
  activatedAt: string | null;
  expiresAt: string | null;
  lastRenewedAt: string | null;
  lastAppVersion: string | null;
}

export type ActivationOutcome =
  | { kind: "activated" | "existing"; record: CodeRecord }
  | {
      kind:
        | "not_found"
        | "disabled"
        | "expired"
        | "bound_to_other_device";
    };

export type RenewalOutcome =
  | { kind: "renewed"; record: CodeRecord }
  | {
      kind:
        | "not_found"
        | "disabled"
        | "expired"
        | "bound_to_other_device";
    };

export interface NewCodeRecord {
  id: string;
  codeHash: string;
  prefix: string;
  maxResets: number;
  label?: string;
  batch?: string;
  expiresAt?: string;
}

export interface CodeListOptions {
  search?: string;
  status?: CodeStatus | "all";
  batch?: string;
  limit?: number;
  offset?: number;
}

export interface CodeListResult {
  codes: CodeRecord[];
  total: number;
}

export interface LicenseStats {
  total: number;
  active: number;
  disabled: number;
  expired: number;
  bound: number;
  unbound: number;
  renewedLast24Hours: number;
}

export interface AuditRecord {
  id: string;
  actor: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface NewAuditRecord {
  id: string;
  actor: string;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

export interface CodeStore {
  initialize(): Promise<void>;
  create(records: NewCodeRecord[]): Promise<void>;
  activate(
    codeHash: string,
    deviceId: string,
    deviceFingerprint: string,
    appVersion: string
  ): Promise<ActivationOutcome>;
  renew(
    codeId: string,
    deviceId: string,
    deviceFingerprint: string,
    appVersion: string
  ): Promise<RenewalOutcome>;
  list(options?: CodeListOptions): Promise<CodeListResult>;
  reset(
    id: string,
    codeHash?: string
  ): Promise<"ok" | "not_found" | "limit_reached">;
  disable(id: string, codeHash?: string): Promise<boolean>;
  enable(id: string, codeHash?: string): Promise<boolean>;
  stats(): Promise<LicenseStats>;
  addAudit(record: NewAuditRecord): Promise<void>;
  listAudit(limit?: number): Promise<AuditRecord[]>;
  health(): Promise<void>;
  close(): Promise<void>;
}

export class PostgresCodeStore implements CodeStore {
  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(734291)");
      await client.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
           name TEXT PRIMARY KEY,
           applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
         )`
      );
      const directory = new URL("../migrations/", import.meta.url);
      const migrations = (await readdir(directory))
        .filter((name) => /^\d+.*\.sql$/.test(name))
        .sort();
      const applied = new Set<string>(
        (
          await client.query<{ name: string }>(
            "SELECT name FROM schema_migrations"
          )
        ).rows.map((row) => row.name)
      );
      for (const name of migrations) {
        if (applied.has(name)) continue;
        const sql = await readFile(new URL(name, directory), "utf8");
        await client.query("BEGIN");
        try {
          await client.query(sql);
          await client.query(
            "INSERT INTO schema_migrations (name) VALUES ($1)",
            [name]
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(734291)").catch(() => {});
      client.release();
    }
  }

  async create(records: NewCodeRecord[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const record of records) {
        await client.query(
          `INSERT INTO license_codes
             (id, code_hash, prefix, status, max_resets, label, batch, expires_at)
           VALUES ($1, $2, $3, 'active', $4, $5, $6, $7)`,
          [
            record.id,
            record.codeHash,
            record.prefix,
            record.maxResets,
            record.label ?? null,
            record.batch ?? null,
            record.expiresAt ?? null
          ]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async activate(
    codeHash: string,
    deviceId: string,
    deviceFingerprint: string,
    appVersion: string
  ): Promise<ActivationOutcome> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        "SELECT * FROM license_codes WHERE code_hash = $1 FOR UPDATE",
        [codeHash]
      );
      if (result.rowCount === 0) {
        await client.query("ROLLBACK");
        return { kind: "not_found" };
      }
      const row = result.rows[0];
      const invalid = invalidRecordOutcome(row, deviceId, deviceFingerprint);
      if (invalid) {
        await client.query("ROLLBACK");
        return { kind: invalid };
      }
      const existing =
        row.bound_device_id === deviceId &&
        row.bound_device_fingerprint === deviceFingerprint;
      const update = await client.query(
        `UPDATE license_codes
           SET bound_device_id = $1,
               bound_device_fingerprint = $2,
               activated_at = COALESCE(activated_at, NOW()),
               last_renewed_at = NOW(),
               last_app_version = $3
         WHERE id = $4
         RETURNING *`,
        [deviceId, deviceFingerprint, appVersion, row.id]
      );
      await client.query("COMMIT");
      return {
        kind: existing ? "existing" : "activated",
        record: mapCodeRow(update.rows[0])
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async renew(
    codeId: string,
    deviceId: string,
    deviceFingerprint: string,
    appVersion: string
  ): Promise<RenewalOutcome> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        "SELECT * FROM license_codes WHERE id = $1 FOR UPDATE",
        [codeId]
      );
      if (result.rowCount === 0) {
        await client.query("ROLLBACK");
        return { kind: "not_found" };
      }
      const row = result.rows[0];
      const invalid = invalidRecordOutcome(row, deviceId, deviceFingerprint);
      if (invalid) {
        await client.query("ROLLBACK");
        return { kind: invalid };
      }
      const update = await client.query(
        `UPDATE license_codes
           SET last_renewed_at = NOW(),
               last_app_version = $1
         WHERE id = $2
         RETURNING *`,
        [appVersion, codeId]
      );
      await client.query("COMMIT");
      return { kind: "renewed", record: mapCodeRow(update.rows[0]) };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async list(options: CodeListOptions = {}): Promise<CodeListResult> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    const add = (value: unknown): string => {
      values.push(value);
      return `$${values.length}`;
    };
    if (options.search?.trim()) {
      const parameter = add(`%${options.search.trim()}%`);
      clauses.push(
        `(prefix ILIKE ${parameter} OR COALESCE(label, '') ILIKE ${parameter} OR COALESCE(batch, '') ILIKE ${parameter} OR id::text ILIKE ${parameter})`
      );
    }
    if (options.status && options.status !== "all") {
      clauses.push(`status = ${add(options.status)}`);
    }
    if (options.batch?.trim()) {
      clauses.push(`batch = ${add(options.batch.trim())}`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const offset = Math.max(options.offset ?? 0, 0);
    const [rows, count] = await Promise.all([
      this.pool.query(
        `SELECT * FROM license_codes
         ${where}
         ORDER BY created_at DESC
         LIMIT ${add(limit)} OFFSET ${add(offset)}`,
        values
      ),
      this.pool.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM license_codes ${where}`,
        values.slice(0, values.length - 2)
      )
    ]);
    return {
      codes: rows.rows.map(mapCodeRow),
      total: Number(count.rows[0]?.total ?? 0)
    };
  }

  async reset(
    id: string,
    codeHash?: string
  ): Promise<"ok" | "not_found" | "limit_reached"> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `SELECT * FROM license_codes
         WHERE id = $1 OR ($2::text IS NOT NULL AND code_hash = $2)
         FOR UPDATE`,
        [id, codeHash ?? null]
      );
      if (result.rowCount === 0) {
        await client.query("ROLLBACK");
        return "not_found";
      }
      const row = result.rows[0];
      if (row.reset_count >= row.max_resets) {
        await client.query("ROLLBACK");
        return "limit_reached";
      }
      await client.query(
        `UPDATE license_codes
         SET bound_device_id = NULL,
             bound_device_fingerprint = NULL,
             activated_at = NULL,
             last_renewed_at = NULL,
             last_app_version = NULL,
             reset_count = reset_count + 1
         WHERE id = $1`,
        [row.id]
      );
      await client.query("COMMIT");
      return "ok";
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async disable(id: string, codeHash?: string): Promise<boolean> {
    return this.setStatus("disabled", id, codeHash);
  }

  async enable(id: string, codeHash?: string): Promise<boolean> {
    return this.setStatus("active", id, codeHash);
  }

  async stats(): Promise<LicenseStats> {
    const result = await this.pool.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status = 'active')::int AS active,
         COUNT(*) FILTER (WHERE status = 'disabled')::int AS disabled,
         COUNT(*) FILTER (WHERE expires_at IS NOT NULL AND expires_at <= NOW())::int AS expired,
         COUNT(*) FILTER (WHERE bound_device_id IS NOT NULL)::int AS bound,
         COUNT(*) FILTER (WHERE bound_device_id IS NULL)::int AS unbound,
         COUNT(*) FILTER (WHERE last_renewed_at >= NOW() - INTERVAL '24 hours')::int
           AS renewed_last_24_hours
       FROM license_codes`
    );
    const row = result.rows[0];
    return {
      total: Number(row.total),
      active: Number(row.active),
      disabled: Number(row.disabled),
      expired: Number(row.expired),
      bound: Number(row.bound),
      unbound: Number(row.unbound),
      renewedLast24Hours: Number(row.renewed_last_24_hours)
    };
  }

  async addAudit(record: NewAuditRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_events
         (id, actor, action, target_type, target_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        record.id,
        record.actor,
        record.action,
        record.targetType ?? null,
        record.targetId ?? null,
        JSON.stringify(record.metadata ?? {})
      ]
    );
  }

  async listAudit(limit = 100): Promise<AuditRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM audit_events
       ORDER BY created_at DESC
       LIMIT $1`,
      [Math.min(Math.max(limit, 1), 500)]
    );
    return result.rows.map(mapAuditRow);
  }

  async health(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async setStatus(
    status: CodeStatus,
    id: string,
    codeHash?: string
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE license_codes SET status = $1
       WHERE id = $2 OR ($3::text IS NOT NULL AND code_hash = $3)`,
      [status, id, codeHash ?? null]
    );
    return (result.rowCount ?? 0) > 0;
  }
}

function invalidRecordOutcome(
  row: Record<string, unknown>,
  deviceId: string,
  deviceFingerprint: string
): "disabled" | "expired" | "bound_to_other_device" | undefined {
  if (row.status !== "active") return "disabled";
  if (row.expires_at && new Date(row.expires_at as string | Date) <= new Date()) {
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

function mapCodeRow(row: Record<string, unknown>): CodeRecord {
  return {
    id: String(row.id),
    prefix: String(row.prefix),
    status: row.status as CodeStatus,
    label: row.label ? String(row.label) : null,
    batch: row.batch ? String(row.batch) : null,
    boundDeviceId: row.bound_device_id ? String(row.bound_device_id) : null,
    resetCount: Number(row.reset_count),
    maxResets: Number(row.max_resets),
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    activatedAt: row.activated_at
      ? new Date(row.activated_at as string | Date).toISOString()
      : null,
    expiresAt: row.expires_at
      ? new Date(row.expires_at as string | Date).toISOString()
      : null,
    lastRenewedAt: row.last_renewed_at
      ? new Date(row.last_renewed_at as string | Date).toISOString()
      : null,
    lastAppVersion: row.last_app_version
      ? String(row.last_app_version)
      : null
  };
}

function mapAuditRow(row: Record<string, unknown>): AuditRecord {
  return {
    id: String(row.id),
    actor: String(row.actor),
    action: String(row.action),
    targetType: row.target_type ? String(row.target_type) : null,
    targetId: row.target_id ? String(row.target_id) : null,
    metadata:
      typeof row.metadata === "object" && row.metadata
        ? (row.metadata as Record<string, unknown>)
        : {},
    createdAt: new Date(row.created_at as string | Date).toISOString()
  };
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original database error.
  }
}
