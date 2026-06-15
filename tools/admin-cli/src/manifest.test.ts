import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { generateEd25519KeyPair } from "@ai-tool-installer/shared/node";
import type { AdminConfig } from "./config.js";
import {
  loadManifest,
  publishSource,
  validateOfficialScript
} from "./manifest.js";
import { officialProducts, officialSources } from "./official-sources.js";

let directory: string;
let config: AdminConfig;

beforeEach(async () => {
  directory = path.join(os.tmpdir(), `installer-cli-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const keys = generateEd25519KeyPair();
  await writeFile(path.join(directory, "private.pem"), keys.privateKeyPem);
  await writeFile(path.join(directory, "public.pem"), keys.publicKeyPem);
  config = {
    manifestPath: path.join(directory, "manifest.json"),
    historyDirectory: path.join(directory, "history"),
    manifestPrivateKeyPath: path.join(directory, "private.pem"),
    manifestPublicKeyPath: path.join(directory, "public.pem"),
    manifestKeyId: "test"
  };
});

describe("source publishing", () => {
  it("hashes a local package and emits a signed manifest", async () => {
    const packagePath = path.join(directory, "claude");
    await writeFile(packagePath, "test binary");

    const artifact = await publishSource(config, {
      file: packagePath,
      publicUrl: "https://downloads.example.test/claude",
      originUrl: "https://claude.ai/install.sh",
      product: officialProducts[0]!,
      platform: "macos",
      arch: "aarch64",
      minOsVersion: "13.0",
      installType: "standalone_binary",
      version: "1.2.3",
      args: [],
      requiresElevation: false
    });
    const manifest = await loadManifest(config);

    expect(artifact.sha256).toHaveLength(64);
    expect(artifact.minOsVersion).toBe("13.0");
    expect(manifest.activeReleaseIds["claude-code:macos:aarch64"]).toBe(
      artifact.id
    );
    expect(JSON.parse(await readFile(config.manifestPath, "utf8"))).toHaveProperty(
      "signature"
    );
  });

  it("defines official installers for every supported product and platform", () => {
    for (const product of officialProducts) {
      for (const platform of ["windows", "macos", "linux"]) {
        expect(
          officialSources.some(
            (source) =>
              source.product.id === product.id && source.platform === platform
          )
        ).toBe(true);
      }
    }
  });

  it("rejects an HTML response masquerading as an official script", async () => {
    const responsePath = path.join(directory, "install.sh");
    await writeFile(
      responsePath,
      "<!doctype html><html><body>Unavailable</body></html>"
    );

    await expect(
      validateOfficialScript(
        responsePath,
        "https://vendor.example.test/install.sh",
        "bash"
      )
    ).rejects.toThrow("did not return an install script");
  });

  it("publishes signed archive bundle metadata", async () => {
    const bundlePath = path.join(directory, "openclaw.zip");
    await writeFile(bundlePath, "test archive");

    const artifact = await publishSource(config, {
      file: bundlePath,
      publicUrl: "https://downloads.example.test/openclaw.zip",
      originUrl: "https://docs.openclaw.ai/install",
      product: officialProducts[1]!,
      platform: "windows",
      arch: "x86_64",
      minOsVersion: "10.0.17763",
      installType: "archive_bundle",
      archiveFormat: "zip",
      archiveExecutablePath: "bin/openclaw.cmd",
      version: "1.0.0",
      args: [],
      requiresElevation: false
    });

    expect(artifact.installType).toBe("archive_bundle");
    expect(artifact.archiveFormat).toBe("zip");
    expect(artifact.archiveExecutablePath).toBe("bin/openclaw.cmd");
    expect(artifact.minOsVersion).toBe("10.0.17763");
  });
});
