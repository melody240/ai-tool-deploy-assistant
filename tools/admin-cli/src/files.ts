import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface FileDigest {
  size: number;
  sha256: string;
}

export async function digestFile(filePath: string): Promise<FileDigest> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(filePath)) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    hash.update(bytes);
  }
  return { size, sha256: hash.digest("hex") };
}

export async function digestUrl(url: string): Promise<FileDigest> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Unable to download source: HTTP ${response.status}`);
  }

  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of Readable.fromWeb(response.body as never)) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    hash.update(bytes);
  }
  return { size, sha256: hash.digest("hex") };
}

export async function downloadUrl(
  url: string,
  destination: string
): Promise<void> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Unable to download source: HTTP ${response.status}`);
  }
  await pipeline(
    Readable.fromWeb(response.body as never),
    createWriteStream(destination, { mode: 0o600 })
  );
}

export async function readJsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function writeJsonAtomic(
  filePath: string,
  value: unknown
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600
  });
  await rename(temporary, filePath);
}
