import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AdminConfig } from "./config.js";
import { ObjectStorage } from "./storage.js";

const targetPattern = /^(darwin|windows|linux)-(x86_64|aarch64)$/;

export interface UpdaterArtifactInput {
  target: string;
  file: string;
}

export interface PublishUpdaterInput {
  version: string;
  notes: string;
  pubDate: string;
  artifacts: UpdaterArtifactInput[];
}

export interface UpdaterManifest {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { signature: string; url: string }>;
}

export async function publishDesktopUpdate(
  config: AdminConfig,
  input: PublishUpdaterInput
): Promise<{ manifest: UpdaterManifest; manifestUrl: string }> {
  if (!config.storage) {
    throw new Error("Desktop update publishing requires object storage");
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(input.version)) {
    throw new Error("Update version must be a semantic version such as 1.2.3");
  }
  if (input.artifacts.length === 0) {
    throw new Error("Provide at least one --artifact target=path");
  }
  const pubDate = new Date(input.pubDate);
  if (Number.isNaN(pubDate.getTime())) {
    throw new Error("Update publication date must be a valid RFC 3339 date");
  }

  const storage = new ObjectStorage(config.storage);
  const platforms: UpdaterManifest["platforms"] = {};
  for (const artifact of input.artifacts) {
    if (!targetPattern.test(artifact.target)) {
      throw new Error(
        `Unsupported updater target ${artifact.target}; expected OS-ARCH`
      );
    }
    if (platforms[artifact.target]) {
      throw new Error(`Duplicate updater target: ${artifact.target}`);
    }
    const filePath = path.resolve(artifact.file);
    const signature = (await readFile(`${filePath}.sig`, "utf8")).trim();
    if (!signature) {
      throw new Error(`Empty updater signature: ${filePath}.sig`);
    }
    const objectKey = [
      "updates",
      input.version,
      artifact.target,
      path.basename(filePath)
    ].join("/");
    const url = await storage.uploadFile(filePath, objectKey);
    platforms[artifact.target] = { signature, url };
  }

  const manifest: UpdaterManifest = {
    version: input.version,
    notes: input.notes,
    pub_date: pubDate.toISOString(),
    platforms
  };
  const manifestUrl = await storage.uploadJson(
    manifest,
    config.storage.updaterObjectKey
  );
  return { manifest, manifestUrl };
}
