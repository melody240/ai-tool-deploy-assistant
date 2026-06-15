import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { SourceServiceOptions } from "./source-service.js";

const environmentBoolean = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}, z.boolean());

const optionalEnvironmentString = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().min(1).optional()
);

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: optionalEnvironmentString,
  SQLITE_PATH: optionalEnvironmentString,
  USE_MEMORY_STORE: environmentBoolean.default(false),
  ADMIN_TOKEN: z.string().min(8),
  ADMIN_ACTIVATION_CODE: optionalEnvironmentString,
  CODE_HMAC_SECRET: z.string().min(32),
  LICENSE_PRIVATE_KEY_PATH: z.string().min(1),
  LICENSE_KEY_ID: z.string().default("license-v1"),
  LICENSE_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(2).default(0),
  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .min(1024 * 1024)
    .max(2 * 1024 * 1024 * 1024)
    .default(512 * 1024 * 1024),
  SOURCE_MANAGEMENT_ENABLED: environmentBoolean.default(false),
  MANIFEST_PRIVATE_KEY: optionalEnvironmentString,
  MANIFEST_PUBLIC_KEY: optionalEnvironmentString,
  MANIFEST_KEY_ID: z.string().default("manifest-v1"),
  STORAGE_ENDPOINT: z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() === "" ? undefined : value,
    z.string().url().optional()
  ),
  STORAGE_REGION: z.string().default("cn-hangzhou"),
  STORAGE_BUCKET: optionalEnvironmentString,
  STORAGE_ACCESS_KEY_ID: optionalEnvironmentString,
  STORAGE_SECRET_ACCESS_KEY: optionalEnvironmentString,
  STORAGE_PUBLIC_BASE_URL: z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() === "" ? undefined : value,
    z.string().url().optional()
  ),
  STORAGE_FORCE_PATH_STYLE: environmentBoolean.default(true),
  STORAGE_MANIFEST_KEY: z
    .string()
    .default("manifests/source-manifest.json"),
  STORAGE_MANIFEST_HISTORY_PREFIX: z
    .string()
    .default("manifests/history")
});

export interface ApiConfig {
  host: string;
  port: number;
  databaseUrl?: string;
  sqlitePath?: string;
  useMemoryStore: boolean;
  adminToken: string;
  adminActivationCode?: string;
  codeHmacSecret: string;
  licensePrivateKey: string;
  licenseKeyId: string;
  licenseTtlDays: number;
  trustProxyHops: number;
  maxUploadBytes: number;
  sourceManagerOptions?: SourceServiceOptions;
}

export async function loadConfig(
  environment: NodeJS.ProcessEnv = process.env
): Promise<ApiConfig> {
  const parsed = environmentSchema.parse(environment);
  validateProductionConfig(parsed);
  const sourceManagerOptions = parsed.SOURCE_MANAGEMENT_ENABLED
    ? await loadSourceManagerOptions(parsed)
    : undefined;
  return {
    host: parsed.HOST,
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    sqlitePath: parsed.SQLITE_PATH,
    useMemoryStore: parsed.USE_MEMORY_STORE,
    adminToken: parsed.ADMIN_TOKEN,
    adminActivationCode: parsed.ADMIN_ACTIVATION_CODE,
    codeHmacSecret: parsed.CODE_HMAC_SECRET,
    licensePrivateKey: await readFile(parsed.LICENSE_PRIVATE_KEY_PATH, "utf8"),
    licenseKeyId: parsed.LICENSE_KEY_ID,
    licenseTtlDays: parsed.LICENSE_TTL_DAYS,
    trustProxyHops: parsed.TRUST_PROXY_HOPS,
    maxUploadBytes: parsed.MAX_UPLOAD_BYTES,
    sourceManagerOptions
  };
}

function validateProductionConfig(
  parsed: z.infer<typeof environmentSchema>
): void {
  if (
    !parsed.USE_MEMORY_STORE &&
    !parsed.DATABASE_URL &&
    !parsed.SQLITE_PATH
  ) {
    throw new Error(
      "DATABASE_URL or SQLITE_PATH is required when USE_MEMORY_STORE=false"
    );
  }
  if (parsed.DATABASE_URL && parsed.SQLITE_PATH) {
    throw new Error("Configure only one of DATABASE_URL or SQLITE_PATH");
  }
  if (parsed.NODE_ENV !== "production") return;
  if (parsed.USE_MEMORY_STORE) {
    throw new Error("USE_MEMORY_STORE is not allowed in production");
  }
  const insecureValues = [
    parsed.ADMIN_TOKEN,
    parsed.CODE_HMAC_SECRET,
    parsed.DATABASE_URL ?? ""
  ];
  if (
    parsed.ADMIN_TOKEN.length < 32 ||
    insecureValues.some((value) =>
      /change-me|replace-with|example|password/i.test(value)
    )
  ) {
    throw new Error("Production secrets still contain placeholder values");
  }
  if (parsed.ADMIN_ACTIVATION_CODE) {
    throw new Error("ADMIN_ACTIVATION_CODE is not allowed in production");
  }
  if (parsed.SOURCE_MANAGEMENT_ENABLED) {
    throw new Error(
      "SOURCE_MANAGEMENT_ENABLED is not allowed on the public production API"
    );
  }
}

async function loadSourceManagerOptions(
  parsed: z.infer<typeof environmentSchema>
): Promise<SourceServiceOptions> {
  const required = {
    MANIFEST_PRIVATE_KEY: parsed.MANIFEST_PRIVATE_KEY,
    MANIFEST_PUBLIC_KEY: parsed.MANIFEST_PUBLIC_KEY,
    STORAGE_BUCKET: parsed.STORAGE_BUCKET,
    STORAGE_ACCESS_KEY_ID: parsed.STORAGE_ACCESS_KEY_ID,
    STORAGE_SECRET_ACCESS_KEY: parsed.STORAGE_SECRET_ACCESS_KEY,
    STORAGE_PUBLIC_BASE_URL: parsed.STORAGE_PUBLIC_BASE_URL
  };
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `SOURCE_MANAGEMENT_ENABLED=true but these values are missing: ${missing.join(", ")}`
    );
  }
  return {
    endpoint: parsed.STORAGE_ENDPOINT,
    region: parsed.STORAGE_REGION,
    bucket: parsed.STORAGE_BUCKET!,
    accessKeyId: parsed.STORAGE_ACCESS_KEY_ID!,
    secretAccessKey: parsed.STORAGE_SECRET_ACCESS_KEY!,
    publicBaseUrl: parsed.STORAGE_PUBLIC_BASE_URL!.replace(/\/$/, ""),
    forcePathStyle: parsed.STORAGE_FORCE_PATH_STYLE,
    manifestObjectKey: parsed.STORAGE_MANIFEST_KEY,
    historyPrefix: parsed.STORAGE_MANIFEST_HISTORY_PREFIX,
    manifestPrivateKey: await readFile(parsed.MANIFEST_PRIVATE_KEY!, "utf8"),
    manifestPublicKey: await readFile(parsed.MANIFEST_PUBLIC_KEY!, "utf8"),
    manifestKeyId: parsed.MANIFEST_KEY_ID
  };
}
