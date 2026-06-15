import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createEmptyManifest,
  decodeEnvelopePayload,
  sourceTargetKey,
  sourceManifestSchema,
  type ArchiveFormat,
  type Architecture,
  type InstallType,
  type Platform,
  type ScriptInterpreter,
  type SourceArtifact,
  type SourceManifest
} from "@ai-tool-installer/shared";
import {
  signJsonEnvelope,
  verifyJsonEnvelope
} from "@ai-tool-installer/shared/node";
import type { AdminConfig } from "./config.js";
import {
  downloadUrl,
  digestFile,
  digestUrl,
  readJsonFile,
  writeJsonAtomic
} from "./files.js";
import { ObjectStorage } from "./storage.js";
import {
  findOfficialProduct,
  officialSources,
  type ProductDefinition
} from "./official-sources.js";

export interface PublishOptions {
  file?: string;
  url?: string;
  publicUrl?: string;
  originUrl?: string;
  product: ProductDefinition;
  platform: Platform;
  arch: Architecture;
  minOsVersion?: string;
  installType: InstallType;
  version: string;
  fileName?: string;
  args: string[];
  requiresElevation: boolean;
  interpreter?: ScriptInterpreter;
  archiveFormat?: ArchiveFormat;
  archiveExecutablePath?: string;
}

async function loadKeys(config: AdminConfig): Promise<{
  privateKey: string;
  publicKey: string;
}> {
  return {
    privateKey: await readFile(config.manifestPrivateKeyPath, "utf8"),
    publicKey: await readFile(config.manifestPublicKeyPath, "utf8")
  };
}

export async function loadManifest(config: AdminConfig): Promise<SourceManifest> {
  try {
    const keys = await loadKeys(config);
    const envelope = verifyJsonEnvelope(
      await readJsonFile(config.manifestPath),
      keys.publicKey
    );
    return decodeEnvelopePayload(envelope, sourceManifestSchema);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return createEmptyManifest();
    }
    throw error;
  }
}

async function publishManifest(
  config: AdminConfig,
  manifest: SourceManifest
): Promise<void> {
  const keys = await loadKeys(config);
  const envelope = signJsonEnvelope(
    sourceManifestSchema.parse(manifest),
    keys.privateKey,
    config.manifestKeyId
  );
  await writeJsonAtomic(config.manifestPath, envelope);
  await mkdir(config.historyDirectory, { recursive: true });
  await copyFile(
    config.manifestPath,
    path.join(
      config.historyDirectory,
      `revision-${String(manifest.revision).padStart(6, "0")}.json`
    )
  );
  if (config.storage) {
    await new ObjectStorage(config.storage).uploadJson(
      envelope,
      config.storage.manifestObjectKey
    );
  }
}

export async function publishSource(
  config: AdminConfig,
  options: PublishOptions
): Promise<SourceArtifact> {
  if (Boolean(options.file) === Boolean(options.url)) {
    throw new Error("Specify exactly one of --file or --url");
  }
  if (options.installType === "script" && !options.interpreter) {
    throw new Error("Script sources require --interpreter");
  }
  if (
    options.installType === "archive_bundle" &&
    (!options.archiveFormat || !options.archiveExecutablePath)
  ) {
    throw new Error(
      "Archive bundle sources require an archive format and executable path"
    );
  }

  const sourceFile = options.file ? path.resolve(options.file) : undefined;
  const digest = sourceFile
    ? await digestFile(sourceFile)
    : await digestUrl(options.url!);
  const fileName =
    options.fileName ??
    (sourceFile
      ? path.basename(sourceFile)
      : path.basename(new URL(options.url!).pathname) || "download.bin");

  let publicUrl = options.publicUrl ?? options.url;
  if (sourceFile && config.storage) {
    const objectKey = [
      "sources",
      options.product.id,
      options.platform,
      options.arch,
      options.version,
      digest.sha256.slice(0, 16),
      fileName
    ].join("/");
    publicUrl = await new ObjectStorage(config.storage).uploadFile(
      sourceFile,
      objectKey
    );
  }
  if (!publicUrl) {
    throw new Error(
      "Local files require object storage configuration or --public-url"
    );
  }

  const artifact = sourceManifestSchema.shape.releases.element.parse({
    id: randomUUID(),
    productId: options.product.id,
    productName: options.product.name,
    productDescription: options.product.description,
    homepageUrl: options.product.homepageUrl,
    originUrl:
      options.originUrl ??
      options.url ??
      options.product.homepageUrl,
    executable: options.product.executable,
    versionArgs: options.product.versionArgs,
    doctorArgs: options.product.doctorArgs,
    terminalArgs: options.product.terminalArgs,
    version: options.version,
    platform: options.platform,
    arch: options.arch,
    minOsVersion: options.minOsVersion,
    installType: options.installType,
    url: publicUrl,
    fileName,
    size: digest.size,
    sha256: digest.sha256,
    args: options.args,
    requiresElevation: options.requiresElevation,
    enabled: true,
    publishedAt: new Date().toISOString(),
    scriptInterpreter: options.interpreter,
    archiveFormat: options.archiveFormat,
    archiveExecutablePath: options.archiveExecutablePath
  });
  const current = await loadManifest(config);
  const targetKey = sourceTargetKey(
    artifact.productId,
    artifact.platform,
    artifact.arch
  );
  const next: SourceManifest = {
    ...current,
    revision: current.revision + 1,
    generatedAt: new Date().toISOString(),
    activeReleaseIds: {
      ...current.activeReleaseIds,
      [targetKey]: artifact.id
    },
    releases: [...current.releases, artifact]
  };
  await publishManifest(config, next);
  return artifact;
}

export async function disableSource(
  config: AdminConfig,
  sourceId: string
): Promise<void> {
  const current = await loadManifest(config);
  if (!current.releases.some((release) => release.id === sourceId)) {
    throw new Error(`Unknown source id: ${sourceId}`);
  }
  const releases = current.releases.map((release) =>
    release.id === sourceId ? { ...release, enabled: false } : release
  );
  const disabled = current.releases.find((release) => release.id === sourceId)!;
  const targetKey = sourceTargetKey(
    disabled.productId,
    disabled.platform,
    disabled.arch
  );
  const fallback = [...releases]
    .reverse()
    .find(
      (release) =>
        release.enabled &&
        release.productId === disabled.productId &&
        release.platform === disabled.platform &&
        release.arch === disabled.arch
    )?.id;
  const activeReleaseIds = { ...current.activeReleaseIds };
  if (activeReleaseIds[targetKey] === sourceId) {
    if (fallback) activeReleaseIds[targetKey] = fallback;
    else delete activeReleaseIds[targetKey];
  }
  await publishManifest(config, {
    ...current,
    revision: current.revision + 1,
    generatedAt: new Date().toISOString(),
    activeReleaseIds,
    releases
  });
}

export async function rollbackManifest(
  config: AdminConfig,
  revision: number
): Promise<void> {
  const historyPath = path.join(
    config.historyDirectory,
    `revision-${String(revision).padStart(6, "0")}.json`
  );
  const keys = await loadKeys(config);
  const envelope = verifyJsonEnvelope(await readJsonFile(historyPath), keys.publicKey);
  const historical = decodeEnvelopePayload(envelope, sourceManifestSchema);
  const current = await loadManifest(config);
  await publishManifest(config, {
    ...historical,
    revision: current.revision + 1,
    generatedAt: new Date().toISOString()
  });
}

export async function syncOfficialSources(
  config: AdminConfig,
  productId?: string,
  version = new Date().toISOString().slice(0, 10).replaceAll("-", "")
): Promise<SourceArtifact[]> {
  if (!config.storage) {
    throw new Error(
      "Official source sync requires S3-compatible storage so dynamic official scripts are mirrored to an immutable signed copy"
    );
  }
  if (productId && !findOfficialProduct(productId)) {
    throw new Error(`Unknown official product: ${productId}`);
  }
  const definitions = officialSources.filter(
    (source) => !productId || source.product.id === productId
  );
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "ai-tool-official-sources-")
  );
  const downloaded = new Map<string, string>();
  const artifacts: SourceArtifact[] = [];
  try {
    for (const definition of definitions) {
      let localPath = downloaded.get(definition.originUrl);
      if (!localPath) {
        const extension =
          definition.interpreter === "powershell" ? ".ps1" : ".sh";
        localPath = path.join(
          temporaryDirectory,
          `${definition.product.id}${extension}`
        );
        await downloadUrl(definition.originUrl, localPath);
        await validateOfficialScript(
          localPath,
          definition.originUrl,
          definition.interpreter
        );
        downloaded.set(definition.originUrl, localPath);
      }
      for (const arch of definition.architectures) {
        artifacts.push(
          await publishSource(config, {
            file: localPath,
            originUrl: definition.originUrl,
            product: definition.product,
            platform: definition.platform,
            arch,
            installType: "script",
            version,
            fileName:
              definition.interpreter === "powershell"
                ? "install.ps1"
                : "install.sh",
            args: definition.args,
            requiresElevation: false,
            interpreter: definition.interpreter
          })
        );
      }
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
  return artifacts;
}

export async function validateOfficialScript(
  filePath: string,
  originUrl: string,
  interpreter: ScriptInterpreter
): Promise<void> {
  const text = await readFile(filePath, "utf8");
  const trimmed = text.trimStart();
  const valid =
    interpreter === "powershell"
      ? trimmed.startsWith("#") || trimmed.startsWith("param(")
      : trimmed.startsWith("#!");
  if (!valid || /<html[\s>]/i.test(trimmed.slice(0, 2000))) {
    throw new Error(
      `Official URL did not return an install script: ${originUrl}. This can happen when the vendor blocks the current region.`
    );
  }
}
