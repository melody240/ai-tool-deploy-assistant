import { describe, expect, it } from "vitest";
import type { AdminConfig } from "./config.js";
import { publishDesktopUpdate } from "./updater.js";

describe("desktop updater publishing", () => {
  it("requires object storage", async () => {
    const config: AdminConfig = {
      manifestPath: "manifest.json",
      historyDirectory: "history",
      manifestPrivateKeyPath: "private.pem",
      manifestPublicKeyPath: "public.pem",
      manifestKeyId: "manifest-v1"
    };
    await expect(
      publishDesktopUpdate(config, {
        version: "1.0.0",
        notes: "",
        pubDate: new Date().toISOString(),
        artifacts: []
      })
    ).rejects.toThrow("requires object storage");
  });
});
