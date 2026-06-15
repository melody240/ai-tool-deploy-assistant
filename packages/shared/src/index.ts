import { z } from "zod";

export const platformSchema = z.enum(["windows", "macos", "linux"]);
export const architectureSchema = z.enum(["x86_64", "aarch64"]);
export const installTypeSchema = z.enum([
  "standalone_binary",
  "native_installer",
  "script",
  "archive_bundle"
]);
export const archiveFormatSchema = z.enum(["zip", "tar_gz"]);
export const scriptInterpreterSchema = z.enum([
  "powershell",
  "cmd",
  "bash",
  "sh"
]);

export const productIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const sourceArtifactSchema = z
  .object({
    id: z.string().min(1),
    productId: productIdSchema,
    productName: z.string().min(1).max(80),
    productDescription: z.string().max(240).default(""),
    homepageUrl: z.string().url(),
    originUrl: z.string().url(),
    executable: z.string().min(1).max(128),
    versionArgs: z.array(z.string()).default(["--version"]),
    doctorArgs: z.array(z.string()).optional(),
    terminalArgs: z.array(z.string()).default([]),
    version: z.string().min(1),
    platform: platformSchema,
    arch: architectureSchema,
    minOsVersion: z
      .string()
      .regex(/^\d+(?:\.\d+){0,3}$/)
      .optional(),
    installType: installTypeSchema,
    url: z.string().url(),
    fileName: z.string().min(1),
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    args: z.array(z.string()).default([]),
    requiresElevation: z.boolean().default(false),
    enabled: z.boolean().default(true),
    publishedAt: z.string().datetime(),
    scriptInterpreter: scriptInterpreterSchema.optional(),
    archiveFormat: archiveFormatSchema.optional(),
    archiveExecutablePath: z.string().min(1).max(512).optional()
  })
  .superRefine((artifact, context) => {
    if (artifact.installType === "script" && !artifact.scriptInterpreter) {
      context.addIssue({
        code: "custom",
        path: ["scriptInterpreter"],
        message: "script sources require a fixed interpreter"
      });
    }
    if (artifact.installType !== "script" && artifact.scriptInterpreter) {
      context.addIssue({
        code: "custom",
        path: ["scriptInterpreter"],
        message: "scriptInterpreter is only valid for script sources"
      });
    }
    if (
      artifact.installType === "archive_bundle" &&
      (!artifact.archiveFormat || !artifact.archiveExecutablePath)
    ) {
      context.addIssue({
        code: "custom",
        path: ["archiveFormat"],
        message:
          "archive bundle sources require archiveFormat and archiveExecutablePath"
      });
    }
    if (
      artifact.installType !== "archive_bundle" &&
      (artifact.archiveFormat || artifact.archiveExecutablePath)
    ) {
      context.addIssue({
        code: "custom",
        path: ["archiveFormat"],
        message: "archive metadata is only valid for archive bundle sources"
      });
    }
  });

export const sourceManifestSchema = z.object({
  schemaVersion: z.literal(3),
  revision: z.number().int().nonnegative(),
  generatedAt: z.string().datetime(),
  activeReleaseIds: z.record(z.string(), z.string()),
  releases: z.array(sourceArtifactSchema)
});

export const signedEnvelopeSchema = z.object({
  algorithm: z.literal("Ed25519"),
  keyId: z.string().min(1),
  payload: z.string().min(1),
  signature: z.string().min(1)
});

export const activationRequestSchema = z.object({
  code: z.string().min(8).max(128),
  deviceId: z.string().uuid(),
  deviceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  appVersion: z.string().min(1).max(64)
});

export const licensePayloadSchema = z.object({
  schemaVersion: z.literal(2),
  licenseId: z.string().uuid(),
  codeId: z.string().uuid(),
  deviceId: z.string().uuid(),
  deviceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  product: z.literal("ai-tool-deploy-assistant"),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime()
});

export const activationResponseSchema = z.object({
  license: signedEnvelopeSchema
});

export const renewalRequestSchema = z.object({
  license: signedEnvelopeSchema,
  appVersion: z.string().min(1).max(64)
});

export const diagnosticResultSchema = z.object({
  name: z.string(),
  status: z.enum(["ok", "warning", "error"]),
  summary: z.string(),
  details: z.string().optional()
});

export type Platform = z.infer<typeof platformSchema>;
export type Architecture = z.infer<typeof architectureSchema>;
export type InstallType = z.infer<typeof installTypeSchema>;
export type ScriptInterpreter = z.infer<typeof scriptInterpreterSchema>;
export type ArchiveFormat = z.infer<typeof archiveFormatSchema>;
export type SourceArtifact = z.infer<typeof sourceArtifactSchema>;
export type SourceManifest = z.infer<typeof sourceManifestSchema>;
export type SignedEnvelope = z.infer<typeof signedEnvelopeSchema>;
export type ActivationRequest = z.infer<typeof activationRequestSchema>;
export type LicensePayload = z.infer<typeof licensePayloadSchema>;
export type ActivationResponse = z.infer<typeof activationResponseSchema>;
export type RenewalRequest = z.infer<typeof renewalRequestSchema>;
export type DiagnosticResult = z.infer<typeof diagnosticResultSchema>;

export function createEmptyManifest(): SourceManifest {
  return {
    schemaVersion: 3,
    revision: 0,
    generatedAt: new Date(0).toISOString(),
    activeReleaseIds: {},
    releases: []
  };
}

export function sourceTargetKey(
  productId: string,
  platform: Platform,
  arch: Architecture
): string {
  return `${productId}:${platform}:${arch}`;
}

export function decodeEnvelopePayload<T>(
  envelope: SignedEnvelope,
  schema: z.ZodType<T>
): T {
  const bytes = Buffer.from(envelope.payload, "base64");
  return schema.parse(JSON.parse(bytes.toString("utf8")));
}
