import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import {
  architectureSchema,
  createEmptyManifest,
  decodeEnvelopePayload,
  platformSchema,
  sourceManifestSchema,
  sourceTargetKey,
  type SourceArtifact,
  type SourceManifest
} from "@ai-tool-installer/shared";
import {
  signJsonEnvelope,
  verifyJsonEnvelope
} from "@ai-tool-installer/shared/node";

const MAX_BUNDLE_BYTES = 8 * 1024 * 1024 * 1024;

interface ProductDefinition {
  id: string;
  name: string;
  description: string;
  homepageUrl: string;
  executable: string;
  versionArgs: string[];
  doctorArgs?: string[];
  terminalArgs: string[];
}

const products: ProductDefinition[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    description: "Anthropic 官方终端编码代理",
    homepageUrl: "https://code.claude.com/docs/en/setup",
    executable: "claude",
    versionArgs: ["--version"],
    doctorArgs: ["doctor"],
    terminalArgs: []
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    description: "开源个人 AI 助手和消息平台",
    homepageUrl: "https://docs.openclaw.ai/install",
    executable: "openclaw",
    versionArgs: ["--version"],
    doctorArgs: ["doctor"],
    terminalArgs: ["onboard"]
  },
  {
    id: "hermes-agent",
    name: "Hermes Agent",
    description: "Nous Research 开源自主智能体",
    homepageUrl: "https://hermes-agent.nousresearch.com/docs/",
    executable: "hermes",
    versionArgs: ["--version"],
    terminalArgs: ["setup"]
  }
];

export interface SourceServiceOptions {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl: string;
  forcePathStyle: boolean;
  manifestObjectKey: string;
  historyPrefix: string;
  manifestPrivateKey: string;
  manifestPublicKey: string;
  manifestKeyId: string;
}

export interface PublishBundleInput {
  filePath: string;
  originalFilename: string;
  productId: string;
  platform: string;
  arch: string;
  minOsVersion?: string;
  version: string;
  executablePath: string;
  originUrl?: string;
}

export interface SourceListResult {
  revision: number;
  releases: Array<SourceArtifact & { active: boolean }>;
}

export interface SourceManager {
  list(): Promise<SourceListResult>;
  publishBundle(input: PublishBundleInput): Promise<SourceArtifact>;
  disable(sourceId: string): Promise<void>;
  rollback(revision: number): Promise<SourceListResult>;
}

export class ObjectStorageSourceManager implements SourceManager {
  private readonly client: S3Client;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: SourceServiceOptions) {
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: options.forcePathStyle,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey
      }
    });
  }

  async list(): Promise<SourceListResult> {
    return summarizeManifest(await this.loadManifest());
  }

  async publishBundle(input: PublishBundleInput): Promise<SourceArtifact> {
    return this.serializeMutation(() => this.publishBundleUnlocked(input));
  }

  private async publishBundleUnlocked(
    input: PublishBundleInput
  ): Promise<SourceArtifact> {
    const product = products.find((candidate) => candidate.id === input.productId);
    if (!product) throw sourceError("UNKNOWN_PRODUCT", 400);
    const platform = platformSchema.parse(input.platform);
    const arch = architectureSchema.parse(input.arch);
    const minOsVersion = normalizeOsVersion(input.minOsVersion);
    if (
      (platform !== "windows" && platform !== "macos") ||
      (platform === "windows" && arch !== "x86_64") ||
      (platform === "macos" && arch !== "aarch64")
    ) {
      throw sourceError("UNSUPPORTED_BUNDLE_PLATFORM", 400);
    }
    const version = normalizeVersion(input.version);
    const archiveExecutablePath = normalizeArchivePath(input.executablePath);
    const archiveFormat = inferArchiveFormat(input.originalFilename);
    if (
      (platform === "windows" && archiveFormat !== "zip") ||
      (platform === "macos" && archiveFormat !== "tar_gz")
    ) {
      throw sourceError("ARCHIVE_FORMAT_MISMATCH", 400);
    }

    const digest = await digestFile(input.filePath);
    if (digest.size === 0 || digest.size > MAX_BUNDLE_BYTES) {
      throw sourceError("INVALID_BUNDLE_SIZE", 400);
    }
    const fileName = safeFileName(input.originalFilename);
    const objectKey = [
      "sources",
      product.id,
      platform,
      arch,
      version,
      digest.sha256.slice(0, 16),
      fileName
    ].join("/");
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: objectKey,
        Body: createReadStream(input.filePath),
        ContentLength: digest.size,
        ContentType:
          archiveFormat === "zip" ? "application/zip" : "application/gzip"
      })
    );

    const artifact = sourceManifestSchema.shape.releases.element.parse({
      id: randomUUID(),
      productId: product.id,
      productName: product.name,
      productDescription: product.description,
      homepageUrl: product.homepageUrl,
      originUrl: input.originUrl?.trim() || product.homepageUrl,
      executable: product.executable,
      versionArgs: product.versionArgs,
      doctorArgs: product.doctorArgs,
      terminalArgs: product.terminalArgs,
      version,
      platform,
      arch,
      minOsVersion,
      installType: "archive_bundle",
      url: `${this.options.publicBaseUrl}/${encodeObjectKey(objectKey)}`,
      fileName,
      size: digest.size,
      sha256: digest.sha256,
      args: [],
      requiresElevation: false,
      enabled: true,
      publishedAt: new Date().toISOString(),
      archiveFormat,
      archiveExecutablePath
    });
    const current = await this.loadManifest();
    const target = sourceTargetKey(product.id, platform, arch);
    const next: SourceManifest = {
      ...current,
      revision: current.revision + 1,
      generatedAt: new Date().toISOString(),
      activeReleaseIds: {
        ...current.activeReleaseIds,
        [target]: artifact.id
      },
      releases: [...current.releases, artifact]
    };
    await this.publishManifest(next);
    return artifact;
  }

  async disable(sourceId: string): Promise<void> {
    return this.serializeMutation(() => this.disableUnlocked(sourceId));
  }

  private async disableUnlocked(sourceId: string): Promise<void> {
    const current = await this.loadManifest();
    const source = current.releases.find((release) => release.id === sourceId);
    if (!source) throw sourceError("SOURCE_NOT_FOUND", 404);
    const releases = current.releases.map((release) =>
      release.id === sourceId ? { ...release, enabled: false } : release
    );
    const target = sourceTargetKey(
      source.productId,
      source.platform,
      source.arch
    );
    const activeReleaseIds = { ...current.activeReleaseIds };
    if (activeReleaseIds[target] === sourceId) {
      const fallback = [...releases]
        .reverse()
        .find(
          (release) =>
            release.enabled &&
            release.productId === source.productId &&
            release.platform === source.platform &&
            release.arch === source.arch
        );
      if (fallback) activeReleaseIds[target] = fallback.id;
      else delete activeReleaseIds[target];
    }
    await this.publishManifest({
      ...current,
      revision: current.revision + 1,
      generatedAt: new Date().toISOString(),
      activeReleaseIds,
      releases
    });
  }

  async rollback(revision: number): Promise<SourceListResult> {
    return this.serializeMutation(() => this.rollbackUnlocked(revision));
  }

  private async rollbackUnlocked(revision: number): Promise<SourceListResult> {
    if (!Number.isInteger(revision) || revision < 0) {
      throw sourceError("INVALID_REVISION", 400);
    }
    const [current, historical] = await Promise.all([
      this.loadManifest(),
      this.loadManifestObject(this.historyKey(revision))
    ]);
    const next: SourceManifest = {
      ...historical,
      revision: current.revision + 1,
      generatedAt: new Date().toISOString()
    };
    await this.publishManifest(next);
    return summarizeManifest(next);
  }

  private async loadManifest(): Promise<SourceManifest> {
    try {
      return await this.loadManifestObject(this.options.manifestObjectKey);
    } catch (error) {
      if (isMissingObject(error)) return createEmptyManifest();
      throw error;
    }
  }

  private async loadManifestObject(objectKey: string): Promise<SourceManifest> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.options.bucket,
        Key: objectKey
      })
    );
    if (!response.Body) throw sourceError("MANIFEST_EMPTY", 502);
    const envelope = JSON.parse(await response.Body.transformToString());
    return decodeEnvelopePayload(
      verifyJsonEnvelope(envelope, this.options.manifestPublicKey),
      sourceManifestSchema
    );
  }

  private async publishManifest(manifest: SourceManifest): Promise<void> {
    const envelope = signJsonEnvelope(
      sourceManifestSchema.parse(manifest),
      this.options.manifestPrivateKey,
      this.options.manifestKeyId
    );
    const body = `${JSON.stringify(envelope, null, 2)}\n`;
    await this.putJson(this.historyKey(manifest.revision), body, "immutable");
    await this.putJson(this.options.manifestObjectKey, body, "no-cache");
  }

  private async putJson(
    objectKey: string,
    body: string,
    cacheControl: string
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: objectKey,
        Body: body,
        ContentType: "application/json; charset=utf-8",
        CacheControl: cacheControl
      })
    );
  }

  private historyKey(revision: number): string {
    return `${this.options.historyPrefix.replace(/\/$/, "")}/revision-${String(
      revision
    ).padStart(6, "0")}.json`;
  }

  private serializeMutation<T>(action: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(action, action);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

function summarizeManifest(manifest: SourceManifest): SourceListResult {
  const activeIds = new Set(Object.values(manifest.activeReleaseIds));
  return {
    revision: manifest.revision,
    releases: manifest.releases
      .map((release) => ({
        ...release,
        active: activeIds.has(release.id)
      }))
      .reverse()
  };
}

async function digestFile(
  filePath: string
): Promise<{ size: number; sha256: string }> {
  const fileStat = await stat(filePath);
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return { size: fileStat.size, sha256: hash.digest("hex") };
}

function inferArchiveFormat(fileName: string): "zip" | "tar_gz" {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tar_gz";
  throw sourceError("UNSUPPORTED_ARCHIVE_FORMAT", 400);
}

function normalizeArchivePath(value: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes("\\") ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw sourceError("INVALID_EXECUTABLE_PATH", 400);
  }
  return normalized;
}

function normalizeVersion(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(normalized)) {
    throw sourceError("INVALID_VERSION", 400);
  }
  return normalized;
}

function normalizeOsVersion(value?: string): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (!/^\d+(?:\.\d+){0,3}$/.test(normalized)) {
    throw sourceError("INVALID_MIN_OS_VERSION", 400);
  }
  return normalized;
}

function safeFileName(value: string): string {
  const filename = path.basename(value).replace(/[^A-Za-z0-9._-]/g, "-");
  if (!filename || filename === "." || filename === "..") {
    throw sourceError("INVALID_FILE_NAME", 400);
  }
  return filename;
}

function encodeObjectKey(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

function isMissingObject(error: unknown): boolean {
  const name = (error as { name?: string }).name;
  return name === "NoSuchKey" || name === "NotFound";
}

function sourceError(code: string, statusCode: number): Error {
  return Object.assign(new Error(code), { code, statusCode });
}
