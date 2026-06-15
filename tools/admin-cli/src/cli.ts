#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Command, Option } from "commander";
import dotenv from "dotenv";
import {
  archiveFormatSchema,
  architectureSchema,
  installTypeSchema,
  platformSchema,
  scriptInterpreterSchema
} from "@ai-tool-installer/shared";
import { generateEd25519KeyPair } from "@ai-tool-installer/shared/node";
import { adminRequest } from "./api-client.js";
import { loadConfig } from "./config.js";
import {
  disableSource,
  loadManifest,
  publishSource,
  rollbackManifest,
  syncOfficialSources
} from "./manifest.js";
import {
  findOfficialProduct,
  officialProducts,
  type ProductDefinition
} from "./official-sources.js";
import { publishDesktopUpdate } from "./updater.js";

dotenv.config();
if (process.env.INIT_CWD) {
  process.chdir(process.env.INIT_CWD);
}

const program = new Command()
  .name("ai-tool-installer-admin")
  .description("Publish signed AI tool sources and manage activation codes")
  .showHelpAfterError();

const keys = program.command("keys").description("Manage signing keys");
keys
  .command("generate")
  .requiredOption("--name <name>", "Key name, for example manifest or license")
  .option("--output <directory>", "Output directory", ".secrets")
  .action(async ({ name, output }) => {
    const directory = path.resolve(output);
    await mkdir(directory, { recursive: true });
    const pair = generateEd25519KeyPair();
    await Promise.all([
      writeFile(path.join(directory, `${name}-private.pem`), pair.privateKeyPem, {
        mode: 0o600
      }),
      writeFile(path.join(directory, `${name}-public.pem`), pair.publicKeyPem),
      writeFile(
        path.join(directory, `${name}-public.raw.b64`),
        `${pair.publicKeyRawBase64}\n`
      )
    ]);
    console.log(`Generated ${name} signing keys in ${directory}`);
  });

const source = program.command("source").description("Manage installer sources");
source
  .command("publish")
  .option("--file <path>", "Upload and publish a local package")
  .option("--url <url>", "Publish an existing remote package or script")
  .option("--public-url <url>", "Public URL for a local file without S3 upload")
  .requiredOption("--product <productId>", "Product id")
  .option("--product-name <name>", "Custom product display name")
  .option("--description <description>", "Custom product description", "")
  .option("--homepage <url>", "Custom product official homepage")
  .option("--executable <name>", "Installed executable name")
  .option("--version-arg <argument>", "Version command argument", collect, [])
  .option("--doctor-arg <argument>", "Doctor command argument", collect, [])
  .option("--terminal-arg <argument>", "Terminal setup argument", collect, [])
  .option("--origin-url <url>", "Original vendor download URL")
  .requiredOption("--platform <platform>")
  .requiredOption("--arch <architecture>")
  .option("--min-os-version <version>", "Minimum supported OS version")
  .requiredOption("--type <installType>")
  .requiredOption("--version <version>")
  .option("--file-name <name>")
  .option("--arg <argument>", "Fixed installer argument", collect, [])
  .option("--elevated", "Installation requires elevation", false)
  .addOption(new Option("--interpreter <interpreter>").choices(scriptInterpreterSchema.options))
  .action(async (options) => {
    if (options.type === "archive_bundle") {
      throw new Error(
        "Use source publish-bundle for archive_bundle sources"
      );
    }
    const product = resolveProduct(options);
    const artifact = await publishSource(loadConfig(), {
      file: options.file,
      url: options.url,
      publicUrl: options.publicUrl,
      originUrl: options.originUrl,
      product,
      platform: platformSchema.parse(options.platform),
      arch: architectureSchema.parse(options.arch),
      minOsVersion: normalizeOsVersion(options.minOsVersion),
      installType: installTypeSchema.parse(options.type),
      version: options.version,
      fileName: options.fileName,
      args: options.arg,
      requiresElevation: options.elevated,
      interpreter: options.interpreter
        ? scriptInterpreterSchema.parse(options.interpreter)
        : undefined
    });
    console.log(JSON.stringify(artifact, null, 2));
  });

source
  .command("publish-bundle")
  .description(
    "Upload, hash and publish a complete offline ZIP or TAR.GZ bundle"
  )
  .requiredOption("--file <path>", "Local offline bundle")
  .requiredOption("--product <productId>", "Product id")
  .option("--product-name <name>", "Custom product display name")
  .option("--description <description>", "Custom product description", "")
  .option("--homepage <url>", "Custom product official homepage")
  .option("--executable <name>", "Installed executable name")
  .option("--version-arg <argument>", "Version command argument", collect, [])
  .option("--doctor-arg <argument>", "Doctor command argument", collect, [])
  .option("--terminal-arg <argument>", "Terminal setup argument", collect, [])
  .option("--origin-url <url>", "Original vendor or project URL")
  .requiredOption("--platform <platform>")
  .requiredOption("--arch <architecture>")
  .option("--min-os-version <version>", "Minimum supported OS version")
  .requiredOption("--version <version>")
  .requiredOption(
    "--executable-path <path>",
    "Relative executable path inside the archive, for example bin/openclaw"
  )
  .option("--format <format>", "Archive format: zip or tar_gz")
  .option("--public-url <url>", "Public URL when object storage is not configured")
  .action(async (options) => {
    const platform = platformSchema.parse(options.platform);
    const archiveFormat = archiveFormatSchema.parse(
      options.format ?? inferArchiveFormat(options.file)
    );
    validateBundleTarget(platform, archiveFormat);
    const artifact = await publishSource(loadConfig(), {
      file: options.file,
      publicUrl: options.publicUrl,
      originUrl: options.originUrl,
      product: resolveProduct(options),
      platform,
      arch: architectureSchema.parse(options.arch),
      minOsVersion: normalizeOsVersion(options.minOsVersion),
      installType: "archive_bundle",
      version: options.version,
      args: [],
      requiresElevation: false,
      archiveFormat,
      archiveExecutablePath: normalizeArchivePath(options.executablePath)
    });
    console.log(JSON.stringify(artifact, null, 2));
  });

source
  .command("sync-official")
  .description(
    "Mirror, hash and sign official Claude Code, OpenClaw and Hermes Agent installers"
  )
  .option(
    "--product <productId>",
    `Only sync one product: ${officialProducts.map((item) => item.id).join(", ")}`
  )
  .option("--version <version>", "Published source version")
  .action(async ({ product, version }) => {
    const artifacts = await syncOfficialSources(
      loadConfig(),
      product,
      version
    );
    console.table(
      artifacts.map((artifact) => ({
        product: artifact.productName,
        target: `${artifact.platform}/${artifact.arch}`,
        version: artifact.version,
        id: artifact.id
      }))
    );
  });

source.command("list").action(async () => {
  const manifest = await loadManifest(loadConfig());
  console.table(
    manifest.releases.map((release) => ({
      id: release.id,
      product: release.productName,
      version: release.version,
      target: `${release.platform}/${release.arch}`,
      type: release.installType,
      enabled: release.enabled,
      active:
        release.id ===
        manifest.activeReleaseIds[
          `${release.productId}:${release.platform}:${release.arch}`
        ]
    }))
  );
});

source
  .command("disable")
  .argument("<sourceId>")
  .action(async (sourceId) => {
    await disableSource(loadConfig(), sourceId);
    console.log(`Disabled source ${sourceId}`);
  });

source
  .command("rollback")
  .argument("<revision>", "Historical manifest revision")
  .action(async (revision) => {
    await rollbackManifest(loadConfig(), Number.parseInt(revision, 10));
    console.log(`Published rollback of revision ${revision}`);
  });

const codes = program.command("codes").description("Manage activation codes");
codes
  .command("create")
  .requiredOption("--count <count>", "Number of codes")
  .option("--batch <batch>", "Order, channel or campaign batch")
  .option("--label <label>", "Customer or order note")
  .option("--max-resets <count>", "Allowed device resets", "1")
  .option("--expires-at <date>", "Redemption and renewal deadline in ISO format")
  .action(async ({ count, batch, label, maxResets, expiresAt }) => {
    const result = await adminRequest<{ codes: string[] }>(
      loadConfig(),
      "POST",
      "/v1/admin/codes",
      {
        count: Number.parseInt(count, 10),
        batch,
        label,
        maxResets: Number.parseInt(maxResets, 10),
        expiresAt
      }
    );
    console.log(result.codes.join("\n"));
  });
codes
  .command("list")
  .option("--search <text>")
  .option("--status <status>", "all, active or disabled", "all")
  .option("--batch <batch>")
  .option("--limit <count>", "Maximum rows", "100")
  .action(async ({ search, status, batch, limit }) => {
    const query = new URLSearchParams({
      status,
      limit: String(Number.parseInt(limit, 10))
    });
    if (search) query.set("search", search);
    if (batch) query.set("batch", batch);
    const result = await adminRequest<{ codes: unknown[]; total: number }>(
      loadConfig(),
      "GET",
      `/v1/admin/codes?${query}`
    );
    console.table(result.codes);
    console.log(`Total: ${result.total}`);
  });
codes.command("stats").action(async () => {
  const result = await adminRequest<Record<string, number>>(
    loadConfig(),
    "GET",
    "/v1/admin/stats"
  );
  console.table(result);
});
codes
  .command("audit")
  .option("--limit <count>", "Maximum events", "100")
  .action(async ({ limit }) => {
    const result = await adminRequest<{ events: unknown[] }>(
      loadConfig(),
      "GET",
      `/v1/admin/audit?limit=${encodeURIComponent(limit)}`
    );
    console.table(result.events);
});
for (const action of ["reset", "disable", "enable"] as const) {
  codes
    .command(action)
    .argument("<codeOrId>")
    .action(async (codeOrId) => {
      await adminRequest(
        loadConfig(),
        "POST",
        `/v1/admin/codes/${encodeURIComponent(codeOrId)}/${action}`
      );
      console.log(`${action} completed for ${codeOrId}`);
    });
}

const desktop = program
  .command("desktop")
  .description("Publish signed desktop application updates");
desktop
  .command("publish-update")
  .requiredOption("--version <version>", "Desktop semantic version")
  .requiredOption(
    "--artifact <target=path>",
    "Signed Tauri updater artifact; repeat for each platform",
    collect,
    []
  )
  .option("--notes <text>", "Release notes", "")
  .option("--notes-file <path>", "Read release notes from a UTF-8 file")
  .option("--pub-date <date>", "RFC 3339 publication date")
  .action(async ({ version, artifact, notes, notesFile, pubDate }) => {
    const releaseNotes = notesFile
      ? await readFile(path.resolve(notesFile), "utf8")
      : notes;
    const result = await publishDesktopUpdate(loadConfig(), {
      version,
      notes: releaseNotes,
      pubDate: pubDate ?? new Date().toISOString(),
      artifacts: artifact.map(parseUpdaterArtifact)
    });
    console.table(
      Object.entries(result.manifest.platforms).map(([target, value]) => ({
        target,
        url: value.url
      }))
    );
    console.log(`Published updater manifest: ${result.manifestUrl}`);
  });

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseUpdaterArtifact(value: string): {
  target: string;
  file: string;
} {
  const separator = value.indexOf("=");
  if (separator < 1 || separator === value.length - 1) {
    throw new Error(
      "Updater artifacts must use target=path, for example darwin-aarch64=app.tar.gz"
    );
  }
  return {
    target: value.slice(0, separator),
    file: value.slice(separator + 1)
  };
}

function inferArchiveFormat(filePath: string): "zip" | "tar_gz" {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tar_gz";
  throw new Error(
    "Unable to infer archive format; use a .zip, .tar.gz or .tgz file"
  );
}

function validateBundleTarget(
  platform: "windows" | "macos" | "linux",
  format: "zip" | "tar_gz"
): void {
  if (platform === "windows" && format !== "zip") {
    throw new Error("Windows offline bundles must use ZIP");
  }
  if (platform === "macos" && format !== "tar_gz") {
    throw new Error("macOS offline bundles must use TAR.GZ");
  }
}

function normalizeArchivePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => part === "" || part === "..")
  ) {
    throw new Error("Archive executable path must be a safe relative path");
  }
  return normalized;
}

function normalizeOsVersion(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const normalized = String(value).trim();
  if (!/^\d+(?:\.\d+){0,3}$/.test(normalized)) {
    throw new Error(
      "Minimum OS version must contain one to four numeric components"
    );
  }
  return normalized;
}

function resolveProduct(options: Record<string, unknown>): ProductDefinition {
  const productId = String(options.product);
  const official = findOfficialProduct(productId);
  if (official) return official;
  const name = options.productName ? String(options.productName) : "";
  const homepageUrl = options.homepage ? String(options.homepage) : "";
  const executable = options.executable ? String(options.executable) : "";
  if (!name || !homepageUrl || !executable) {
    throw new Error(
      "Custom products require --product-name, --homepage and --executable"
    );
  }
  const versionArgs = options.versionArg as string[];
  const doctorArgs = options.doctorArg as string[];
  return {
    id: productId,
    name,
    description: String(options.description ?? ""),
    homepageUrl,
    executable,
    versionArgs: versionArgs.length > 0 ? versionArgs : ["--version"],
    doctorArgs: doctorArgs.length > 0 ? doctorArgs : undefined,
    terminalArgs: options.terminalArg as string[]
  };
}

try {
  await program.parseAsync();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
