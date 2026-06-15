import {
  createHmac,
  createPublicKey,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import {
  activationRequestSchema,
  decodeEnvelopePayload,
  licensePayloadSchema,
  signedEnvelopeSchema,
  type ActivationRequest,
  type LicensePayload,
  type SignedEnvelope
} from "@ai-tool-installer/shared";
import {
  signJsonEnvelope,
  verifyJsonEnvelope
} from "@ai-tool-installer/shared/node";
import type {
  AuditRecord,
  CodeListOptions,
  CodeListResult,
  CodeStore,
  LicenseStats
} from "./store.js";

export interface LicenseServiceOptions {
  store: CodeStore;
  codeHmacSecret: string;
  adminActivationCode?: string;
  licensePrivateKey: string;
  licenseKeyId: string;
  licenseTtlDays: number;
}

export interface CreateCodesInput {
  count: number;
  label?: string;
  batch?: string;
  maxResets?: number;
  expiresAt?: string;
}

export class LicenseService {
  private readonly licensePublicKey: string;

  constructor(private readonly options: LicenseServiceOptions) {
    this.licensePublicKey = createPublicKey(options.licensePrivateKey)
      .export({ format: "pem", type: "spki" })
      .toString();
  }

  async createCodes(input: number | CreateCodesInput): Promise<string[]> {
    const options = typeof input === "number" ? { count: input } : input;
    if (!Number.isInteger(options.count) || options.count < 1 || options.count > 500) {
      throw serviceError("INVALID_COUNT", 400);
    }
    const maxResets = options.maxResets ?? 1;
    if (!Number.isInteger(maxResets) || maxResets < 0 || maxResets > 20) {
      throw serviceError("INVALID_MAX_RESETS", 400);
    }
    const label = normalizeOptional(options.label, 120, "INVALID_LABEL");
    const batch =
      normalizeOptional(options.batch, 80, "INVALID_BATCH") ??
      `batch-${new Date().toISOString().slice(0, 10)}-${randomBytes(3).toString("hex")}`;
    const expiresAt = normalizeFutureDate(options.expiresAt);
    const values = Array.from({ length: options.count }, () => generateCode());
    await this.options.store.create(
      values.map((code) => ({
        id: randomUUID(),
        codeHash: this.hashCode(code),
        prefix: code.slice(0, 10),
        maxResets,
        label,
        batch,
        expiresAt
      }))
    );
    await this.audit("admin", "codes.created", "batch", batch, {
      count: values.length,
      label: label ?? null,
      maxResets,
      expiresAt: expiresAt ?? null
    });
    return values;
  }

  async activate(input: ActivationRequest): Promise<SignedEnvelope> {
    const request = activationRequestSchema.parse(input);
    if (
      this.options.adminActivationCode &&
      secureTokenEquals(
        normalizeCode(request.code),
        normalizeCode(this.options.adminActivationCode)
      )
    ) {
      return this.signLicense(
        "00000000-0000-4000-8000-000000000001",
        request.deviceId,
        request.deviceFingerprint,
        new Date().toISOString()
      );
    }
    const outcome = await this.options.store.activate(
      this.hashCode(request.code),
      request.deviceId,
      request.deviceFingerprint,
      request.appVersion
    );
    if (outcome.kind === "not_found") throw serviceError("INVALID_CODE", 404);
    if (outcome.kind === "disabled") throw serviceError("CODE_DISABLED", 403);
    if (outcome.kind === "expired") throw serviceError("CODE_EXPIRED", 403);
    if (outcome.kind === "bound_to_other_device") {
      throw serviceError("CODE_ALREADY_BOUND", 409);
    }
    if (outcome.kind !== "activated" && outcome.kind !== "existing") {
      throw serviceError("ACTIVATION_FAILED", 500);
    }
    await this.audit("client", `license.${outcome.kind}`, "code", outcome.record.id, {
      appVersion: request.appVersion
    });
    return this.signLicense(
      outcome.record.id,
      request.deviceId,
      request.deviceFingerprint,
      new Date().toISOString()
    );
  }

  async renew(
    license: unknown,
    appVersion: string
  ): Promise<SignedEnvelope> {
    const envelope = signedEnvelopeSchema.parse(license);
    let payload: LicensePayload;
    try {
      payload = decodeEnvelopePayload(
        verifyJsonEnvelope(envelope, this.licensePublicKey),
        licensePayloadSchema
      );
    } catch {
      throw serviceError("INVALID_LICENSE", 401);
    }
    const outcome = await this.options.store.renew(
      payload.codeId,
      payload.deviceId,
      payload.deviceFingerprint,
      appVersion
    );
    if (outcome.kind === "not_found") throw serviceError("INVALID_LICENSE", 404);
    if (outcome.kind === "disabled") throw serviceError("CODE_DISABLED", 403);
    if (outcome.kind === "expired") throw serviceError("CODE_EXPIRED", 403);
    if (outcome.kind === "bound_to_other_device") {
      throw serviceError("LICENSE_DEVICE_MISMATCH", 409);
    }
    if (outcome.kind !== "renewed") {
      throw serviceError("RENEWAL_FAILED", 500);
    }
    await this.audit("client", "license.renewed", "code", outcome.record.id, {
      appVersion
    });
    return this.signLicense(
      outcome.record.id,
      payload.deviceId,
      payload.deviceFingerprint,
      new Date().toISOString()
    );
  }

  async listCodes(options?: CodeListOptions): Promise<CodeListResult> {
    return this.options.store.list(options);
  }

  async reset(identifier: string): Promise<void> {
    const result = await this.options.store.reset(
      isUuid(identifier) ? identifier : "",
      isUuid(identifier) ? undefined : this.hashCode(identifier)
    );
    if (result === "not_found") throw serviceError("CODE_NOT_FOUND", 404);
    if (result === "limit_reached") {
      throw serviceError("RESET_LIMIT_REACHED", 409);
    }
    await this.audit("admin", "code.reset", "code", safeIdentifier(identifier));
  }

  async disable(identifier: string): Promise<void> {
    const changed = await this.options.store.disable(
      isUuid(identifier) ? identifier : "",
      isUuid(identifier) ? undefined : this.hashCode(identifier)
    );
    if (!changed) throw serviceError("CODE_NOT_FOUND", 404);
    await this.audit("admin", "code.disabled", "code", safeIdentifier(identifier));
  }

  async enable(identifier: string): Promise<void> {
    const changed = await this.options.store.enable(
      isUuid(identifier) ? identifier : "",
      isUuid(identifier) ? undefined : this.hashCode(identifier)
    );
    if (!changed) throw serviceError("CODE_NOT_FOUND", 404);
    await this.audit("admin", "code.enabled", "code", safeIdentifier(identifier));
  }

  async stats(): Promise<LicenseStats> {
    return this.options.store.stats();
  }

  async listAudit(limit?: number): Promise<AuditRecord[]> {
    return this.options.store.listAudit(limit);
  }

  async health(): Promise<void> {
    await this.options.store.health();
  }

  private signLicense(
    codeId: string,
    deviceId: string,
    deviceFingerprint: string,
    issuedAt: string
  ): SignedEnvelope {
    const expiresAt = new Date(
      Date.now() + this.options.licenseTtlDays * 24 * 60 * 60 * 1000
    ).toISOString();
    const payload: LicensePayload = {
      schemaVersion: 2,
      licenseId: deterministicLicenseId(codeId, deviceId),
      codeId,
      deviceId,
      deviceFingerprint,
      product: "ai-tool-deploy-assistant",
      issuedAt,
      expiresAt
    };
    return signJsonEnvelope(
      payload,
      this.options.licensePrivateKey,
      this.options.licenseKeyId
    );
  }

  private hashCode(code: string): string {
    return createHmac("sha256", this.options.codeHmacSecret)
      .update(normalizeCode(code))
      .digest("hex");
  }

  private async audit(
    actor: string,
    action: string,
    targetType?: string,
    targetId?: string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    await this.options.store.addAudit({
      id: randomUUID(),
      actor,
      action,
      targetType,
      targetId,
      metadata
    });
  }
}

export interface ServiceError extends Error {
  statusCode: number;
  code: string;
}

function serviceError(code: string, statusCode: number): ServiceError {
  return Object.assign(new Error(code), { code, statusCode });
}

function generateCode(): string {
  const body = randomBytes(15).toString("base64url").toUpperCase();
  return `ADA-${body.slice(0, 5)}-${body.slice(5, 10)}-${body.slice(10, 15)}-${body.slice(15)}`;
}

function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

function normalizeOptional(
  value: string | undefined,
  maxLength: number,
  errorCode: string
): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized.length > maxLength) throw serviceError(errorCode, 400);
  return normalized;
}

function normalizeFutureDate(value?: string): string | undefined {
  if (!value?.trim()) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date <= new Date()) {
    throw serviceError("INVALID_EXPIRATION", 400);
  }
  return date.toISOString();
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

function safeIdentifier(value: string): string {
  return isUuid(value) ? value : `${value.slice(0, 10)}...`;
}

function deterministicLicenseId(codeId: string, deviceId: string): string {
  const digest = createHmac("sha256", codeId).update(deviceId).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join("-");
}

export function secureTokenEquals(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
