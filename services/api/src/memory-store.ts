import type {
  ActivationOutcome,
  AuditRecord,
  CodeListOptions,
  CodeListResult,
  CodeRecord,
  CodeStore,
  LicenseStats,
  NewAuditRecord,
  NewCodeRecord,
  RenewalOutcome
} from "./store.js";

interface InternalCode extends CodeRecord {
  codeHash: string;
  boundDeviceFingerprint: string | null;
}

export class MemoryCodeStore implements CodeStore {
  private readonly codes = new Map<string, InternalCode>();
  private readonly audits: AuditRecord[] = [];

  async create(records: NewCodeRecord[]): Promise<void> {
    for (const record of records) {
      this.codes.set(record.id, {
        id: record.id,
        codeHash: record.codeHash,
        prefix: record.prefix,
        status: "active",
        label: record.label ?? null,
        batch: record.batch ?? null,
        boundDeviceId: null,
        boundDeviceFingerprint: null,
        resetCount: 0,
        maxResets: record.maxResets,
        createdAt: new Date().toISOString(),
        activatedAt: null,
        expiresAt: record.expiresAt ?? null,
        lastRenewedAt: null,
        lastAppVersion: null
      });
    }
  }

  async initialize(): Promise<void> {}

  async activate(
    codeHash: string,
    deviceId: string,
    deviceFingerprint: string,
    appVersion: string
  ): Promise<ActivationOutcome> {
    const record = [...this.codes.values()].find(
      (candidate) => candidate.codeHash === codeHash
    );
    if (!record) return { kind: "not_found" };
    const invalid = invalidRecordOutcome(record, deviceId, deviceFingerprint);
    if (invalid) return { kind: invalid };
    const existing =
      record.boundDeviceId === deviceId &&
      record.boundDeviceFingerprint === deviceFingerprint;
    record.boundDeviceId = deviceId;
    record.boundDeviceFingerprint = deviceFingerprint;
    record.activatedAt ??= new Date().toISOString();
    record.lastRenewedAt = new Date().toISOString();
    record.lastAppVersion = appVersion;
    return { kind: existing ? "existing" : "activated", record };
  }

  async renew(
    codeId: string,
    deviceId: string,
    deviceFingerprint: string,
    appVersion: string
  ): Promise<RenewalOutcome> {
    const record = this.codes.get(codeId);
    if (!record) return { kind: "not_found" };
    const invalid = invalidRecordOutcome(record, deviceId, deviceFingerprint);
    if (invalid) return { kind: invalid };
    record.lastRenewedAt = new Date().toISOString();
    record.lastAppVersion = appVersion;
    return { kind: "renewed", record };
  }

  async list(options: CodeListOptions = {}): Promise<CodeListResult> {
    const search = options.search?.trim().toLowerCase();
    let values = [...this.codes.values()].filter((record) => {
      if (options.status && options.status !== "all") {
        if (record.status !== options.status) return false;
      }
      if (options.batch?.trim() && record.batch !== options.batch.trim()) {
        return false;
      }
      if (
        search &&
        ![record.id, record.prefix, record.label ?? "", record.batch ?? ""]
          .join(" ")
          .toLowerCase()
          .includes(search)
      ) {
        return false;
      }
      return true;
    });
    values = values.sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt)
    );
    const total = values.length;
    const offset = Math.max(options.offset ?? 0, 0);
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    return { codes: values.slice(offset, offset + limit), total };
  }

  async reset(
    id: string,
    codeHash?: string
  ): Promise<"ok" | "not_found" | "limit_reached"> {
    const record = this.find(id, codeHash);
    if (!record) return "not_found";
    if (record.resetCount >= record.maxResets) return "limit_reached";
    record.resetCount += 1;
    record.boundDeviceId = null;
    record.boundDeviceFingerprint = null;
    record.activatedAt = null;
    record.lastRenewedAt = null;
    record.lastAppVersion = null;
    return "ok";
  }

  async disable(id: string, codeHash?: string): Promise<boolean> {
    return this.setStatus("disabled", id, codeHash);
  }

  async enable(id: string, codeHash?: string): Promise<boolean> {
    return this.setStatus("active", id, codeHash);
  }

  async stats(): Promise<LicenseStats> {
    const records = [...this.codes.values()];
    const now = Date.now();
    return {
      total: records.length,
      active: records.filter((record) => record.status === "active").length,
      disabled: records.filter((record) => record.status === "disabled").length,
      expired: records.filter(
        (record) =>
          record.expiresAt !== null &&
          new Date(record.expiresAt).getTime() <= now
      ).length,
      bound: records.filter((record) => record.boundDeviceId !== null).length,
      unbound: records.filter((record) => record.boundDeviceId === null).length,
      renewedLast24Hours: records.filter(
        (record) =>
          record.lastRenewedAt !== null &&
          new Date(record.lastRenewedAt).getTime() >= now - 24 * 60 * 60 * 1000
      ).length
    };
  }

  async addAudit(record: NewAuditRecord): Promise<void> {
    this.audits.unshift({
      id: record.id,
      actor: record.actor,
      action: record.action,
      targetType: record.targetType ?? null,
      targetId: record.targetId ?? null,
      metadata: record.metadata ?? {},
      createdAt: new Date().toISOString()
    });
  }

  async listAudit(limit = 100): Promise<AuditRecord[]> {
    return this.audits.slice(0, Math.min(Math.max(limit, 1), 500));
  }

  async health(): Promise<void> {}

  async close(): Promise<void> {}

  private find(id: string, codeHash?: string): InternalCode | undefined {
    return (
      this.codes.get(id) ??
      [...this.codes.values()].find((record) => record.codeHash === codeHash)
    );
  }

  private setStatus(
    status: "active" | "disabled",
    id: string,
    codeHash?: string
  ): boolean {
    const record = this.find(id, codeHash);
    if (!record) return false;
    record.status = status;
    return true;
  }
}

function invalidRecordOutcome(
  record: InternalCode,
  deviceId: string,
  deviceFingerprint: string
): "disabled" | "expired" | "bound_to_other_device" | undefined {
  if (record.status === "disabled") return "disabled";
  if (record.expiresAt && new Date(record.expiresAt) <= new Date()) {
    return "expired";
  }
  if (
    record.boundDeviceId &&
    (record.boundDeviceId !== deviceId ||
      (record.boundDeviceFingerprint !== null &&
        record.boundDeviceFingerprint !== deviceFingerprint))
  ) {
    return "bound_to_other_device";
  }
  return undefined;
}
