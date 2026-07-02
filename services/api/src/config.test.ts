import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateEd25519KeyPair } from "@ai-tool-installer/shared/node";
import { loadConfig } from "./config.js";

async function environment(
  overrides: NodeJS.ProcessEnv = {}
): Promise<NodeJS.ProcessEnv> {
  const directory = await mkdtemp(path.join(tmpdir(), "api-config-test-"));
  const keyPath = path.join(directory, "license-private.pem");
  await writeFile(keyPath, generateEd25519KeyPair().privateKeyPem);
  return {
    NODE_ENV: "production",
    DATABASE_URL: "postgres://installer:strong-random-value@postgres/installer",
    USE_MEMORY_STORE: "false",
    ADMIN_TOKEN: "a".repeat(48),
    CODE_HMAC_SECRET: "b".repeat(64),
    LICENSE_PRIVATE_KEY_PATH: keyPath,
    SOURCE_MANAGEMENT_ENABLED: "false",
    ...overrides
  };
}

describe("production API configuration", () => {
  it("accepts strong activation-only production configuration", async () => {
    const config = await loadConfig(await environment());
    expect(config.licenseTtlDays).toBe(30);
    expect(config.sourceManagerOptions).toBeUndefined();
  });

  it("accepts SQLite for a single-server production deployment", async () => {
    const config = await loadConfig(
      await environment({
        DATABASE_URL: "",
        SQLITE_PATH: "C:\\ai-tool-installer\\.data\\license.sqlite3"
      })
    );
    expect(config.sqlitePath).toContain("license.sqlite3");
  });

  it("rejects volatile memory storage in production", async () => {
    await expect(
      loadConfig(
        await environment({
          DATABASE_URL: "",
          USE_MEMORY_STORE: "true"
        })
      )
    ).rejects.toThrow("not allowed in production");
  });

  it("accepts operator-provided admin tokens with at least 8 characters", async () => {
    const config = await loadConfig(
      await environment({
        ADMIN_TOKEN: "826474874hz"
      })
    );
    expect(config.adminToken).toBe("826474874hz");
  });

  it("rejects reusable administrator activation codes", async () => {
    await expect(
      loadConfig(
        await environment({
          ADMIN_ACTIVATION_CODE: "ADA-ADMIN-INSECURE-PERMANENT-CODE"
        })
      )
    ).rejects.toThrow();
  });

  it("rejects manifest signing on the public production API", async () => {
    await expect(
      loadConfig(
        await environment({
          SOURCE_MANAGEMENT_ENABLED: "true"
        })
      )
    ).rejects.toThrow("not allowed on the public production API");
  });
});
