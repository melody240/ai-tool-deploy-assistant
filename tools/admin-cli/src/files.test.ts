import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { digestFile } from "./files.js";

describe("file digests", () => {
  it("fully consumes files larger than the stream buffer", async () => {
    const directory = path.join(
      os.tmpdir(),
      `installer-digest-${crypto.randomUUID()}`
    );
    await mkdir(directory, { recursive: true });
    const bytes = randomBytes(2 * 1024 * 1024 + 37);
    const filePath = path.join(directory, "bundle.zip");
    await writeFile(filePath, bytes);

    await expect(digestFile(filePath)).resolves.toEqual({
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
  });
});
