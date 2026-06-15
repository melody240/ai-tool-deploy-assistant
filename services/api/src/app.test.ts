import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { generateEd25519KeyPair } from "@ai-tool-installer/shared/node";
import { buildApp } from "./app.js";
import { MemoryCodeStore } from "./memory-store.js";
import { LicenseService } from "./service.js";
import type {
  PublishBundleInput,
  SourceManager
} from "./source-service.js";

async function fixture(sourceManager?: SourceManager) {
  const keys = generateEd25519KeyPair();
  const store = new MemoryCodeStore();
  const service = new LicenseService({
    store,
    codeHmacSecret: "test-secret-with-at-least-thirty-two-characters",
    adminActivationCode: "ADA-ADMIN-TEST-PERMANENT-CODE",
    licensePrivateKey: keys.privateKeyPem,
    licenseKeyId: "test",
    licenseTtlDays: 30
  });
  const app = await buildApp({
    service,
    adminToken: "admin-token-with-at-least-32-random-characters",
    sourceManager
  });
  return { app, service };
}

describe("activation API", () => {
  it("allows Tauri desktop preflight only on license routes", async () => {
    const { app } = await fixture();
    const allowed = await app.inject({
      method: "OPTIONS",
      url: "/v1/activate",
      headers: {
        origin: "tauri://localhost",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type"
      }
    });
    const rejected = await app.inject({
      method: "OPTIONS",
      url: "/v1/activate",
      headers: {
        origin: "https://example.com",
        "access-control-request-method": "POST"
      }
    });

    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers["access-control-allow-origin"]).toBe(
      "tauri://localhost"
    );
    expect(allowed.headers["cross-origin-resource-policy"]).toBe(
      "cross-origin"
    );
    expect(rejected.statusCode).toBe(403);
    expect(rejected.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });

  it("binds a code to one device and renews its signed lease", async () => {
    const { app, service } = await fixture();
    const [code] = await service.createCodes(1);
    const deviceId = crypto.randomUUID();
    const first = await app.inject({
      method: "POST",
      url: "/v1/activate",
      payload: activationPayload(code!, deviceId)
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/activate",
      payload: activationPayload(code!, deviceId)
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    await app.close();
  });

  it("renews from the signed license without resending the redemption code", async () => {
    const { app, service } = await fixture();
    const [code] = await service.createCodes(1);
    const activated = await app.inject({
      method: "POST",
      url: "/v1/activate",
      payload: activationPayload(code!, crypto.randomUUID())
    });
    const renewed = await app.inject({
      method: "POST",
      url: "/v1/renew",
      payload: {
        license: activated.json().license,
        appVersion: "0.2.0"
      }
    });

    expect(renewed.statusCode).toBe(200);
    expect(renewed.json().license.signature).toBeTypeOf("string");
    await app.close();
  });

  it("rejects a second device", async () => {
    const { app, service } = await fixture();
    const [code] = await service.createCodes(1);
    await app.inject({
      method: "POST",
      url: "/v1/activate",
      payload: activationPayload(code!, crypto.randomUUID())
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/activate",
      payload: activationPayload(code!, crypto.randomUUID())
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "CODE_ALREADY_BOUND" });
    await app.close();
  });

  it("rejects a copied device id with a different machine fingerprint", async () => {
    const { app, service } = await fixture();
    const [code] = await service.createCodes(1);
    const deviceId = crypto.randomUUID();
    await app.inject({
      method: "POST",
      url: "/v1/activate",
      payload: activationPayload(code!, deviceId)
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/activate",
      payload: {
        ...activationPayload(code!, deviceId),
        deviceFingerprint: "b".repeat(64)
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "CODE_ALREADY_BOUND" });
    await app.close();
  });

  it("allows the reusable administrator code on multiple devices", async () => {
    const { app } = await fixture();
    const first = await app.inject({
      method: "POST",
      url: "/v1/activate",
      payload: {
        code: "ada-admin-test-permanent-code",
        deviceId: crypto.randomUUID(),
        deviceFingerprint: "a".repeat(64),
        appVersion: "0.1.0"
      }
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/activate",
      payload: {
        code: "ADA-ADMIN-TEST-PERMANENT-CODE",
        deviceId: crypto.randomUUID(),
        deviceFingerprint: "b".repeat(64),
        appVersion: "0.1.0"
      }
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json()).not.toEqual(second.json());
    await app.close();
  });

  it("protects admin routes", async () => {
    const { app } = await fixture();
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/codes"
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("serves the administrator page without embedding the admin token", async () => {
    const { app } = await fixture();
    const response = await app.inject({
      method: "GET",
      url: "/admin"
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-security-policy"]).toContain(
      "default-src 'self'"
    );
    expect(response.headers["strict-transport-security"]).toContain(
      "max-age=31536000"
    );
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(response.body).toContain("管理员登录");
    expect(response.body).not.toContain(
      "admin-token-with-at-least-32-random-characters"
    );
    await app.close();
  });

  it("serves the public tutorial and download pages", async () => {
    const { app } = await fixture();
    for (const url of ["/tutorial", "/downloads"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.headers["content-security-policy"]).toContain(
        "default-src 'none'"
      );
      expect(response.headers["cache-control"]).toBe("public, max-age=300");
      expect(response.body).toContain("AI 工具部署助手");
    }
    await app.close();
  });

  it("reports when source management is not configured", async () => {
    const { app } = await fixture();
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/sources",
      headers: {
        authorization: "Bearer admin-token-with-at-least-32-random-characters"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      configured: false,
      revision: 0,
      releases: []
    });
    await app.close();
  });

  it("creates operational metadata and exposes stats and audit events", async () => {
    const { app } = await fixture();
    const headers = {
      authorization: "Bearer admin-token-with-at-least-32-random-characters"
    };
    const created = await app.inject({
      method: "POST",
      url: "/v1/admin/codes",
      headers,
      payload: {
        count: 2,
        batch: "order-2026-001",
        label: "Customer A",
        maxResets: 3,
        expiresAt: "2030-01-01T00:00:00.000Z"
      }
    });
    const listed = await app.inject({
      method: "GET",
      url: "/v1/admin/codes?batch=order-2026-001",
      headers
    });
    const stats = await app.inject({
      method: "GET",
      url: "/v1/admin/stats",
      headers
    });
    const audit = await app.inject({
      method: "GET",
      url: "/v1/admin/audit",
      headers
    });

    expect(created.statusCode).toBe(200);
    expect(created.json().codes).toHaveLength(2);
    expect(listed.json()).toMatchObject({ total: 2 });
    expect(listed.json().codes[0]).toMatchObject({
      batch: "order-2026-001",
      label: "Customer A",
      maxResets: 3
    });
    expect(stats.json()).toMatchObject({ total: 2, active: 2 });
    expect(audit.json().events[0].action).toBe("codes.created");
    await app.close();
  });

  it("accepts an offline bundle through the protected administrator API", async () => {
    let published: PublishBundleInput | undefined;
    const sourceManager = sourceManagerFixture({
      publishBundle: async (input) => {
        published = {
          ...input,
          filePath: input.filePath
        };
        expect(await readFile(input.filePath, "utf8")).toBe("test-zip");
        return sourceArtifact();
      }
    });
    const { app } = await fixture(sourceManager);
    const boundary = "----ai-tool-installer-test";
    const body = multipartBody(boundary, {
      productId: "claude-code",
      platform: "windows",
      arch: "x86_64",
      minOsVersion: "10.0.17763",
      version: "2.1.0",
      executablePath: "bin/claude.exe"
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/sources/bundles",
      headers: {
        authorization: "Bearer admin-token-with-at-least-32-random-characters",
        "content-type": `multipart/form-data; boundary=${boundary}`
      },
      payload: body
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().source.productId).toBe("claude-code");
    expect(published).toMatchObject({
      originalFilename: "claude.zip",
      productId: "claude-code",
      platform: "windows",
      arch: "x86_64",
      minOsVersion: "10.0.17763",
      version: "2.1.0",
      executablePath: "bin/claude.exe"
    });
    await app.close();
  });

  it("allows one reset and then enforces the reset limit", async () => {
    const { app, service } = await fixture();
    const [code] = await service.createCodes(1);
    const headers = {
      authorization: "Bearer admin-token-with-at-least-32-random-characters"
    };
    await app.inject({
      method: "POST",
      url: "/v1/activate",
      payload: activationPayload(code!, crypto.randomUUID())
    });
    const firstReset = await app.inject({
      method: "POST",
      url: `/v1/admin/codes/${encodeURIComponent(code!)}/reset`,
      headers
    });
    const secondDevice = await app.inject({
      method: "POST",
      url: "/v1/activate",
      payload: activationPayload(code!, crypto.randomUUID())
    });
    const secondReset = await app.inject({
      method: "POST",
      url: `/v1/admin/codes/${encodeURIComponent(code!)}/reset`,
      headers
    });

    expect(firstReset.statusCode).toBe(200);
    expect(secondDevice.statusCode).toBe(200);
    expect(secondReset.statusCode).toBe(409);
    await app.close();
  });

  it("prevents new activation after a code is disabled", async () => {
    const { app, service } = await fixture();
    const [code] = await service.createCodes(1);
    await app.inject({
      method: "POST",
      url: `/v1/admin/codes/${encodeURIComponent(code!)}/disable`,
      headers: {
        authorization: "Bearer admin-token-with-at-least-32-random-characters"
      }
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/activate",
      payload: activationPayload(code!, crypto.randomUUID())
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "CODE_DISABLED" });
    await app.close();
  });

  it("can re-enable a disabled code but refuses renewal while disabled", async () => {
    const { app, service } = await fixture();
    const [code] = await service.createCodes(1);
    const headers = {
      authorization: "Bearer admin-token-with-at-least-32-random-characters"
    };
    const activated = await app.inject({
      method: "POST",
      url: "/v1/activate",
      payload: activationPayload(code!, crypto.randomUUID())
    });
    const listed = await app.inject({
      method: "GET",
      url: "/v1/admin/codes",
      headers
    });
    const id = listed.json().codes[0].id;
    await app.inject({
      method: "POST",
      url: `/v1/admin/codes/${id}/disable`,
      headers
    });
    const refused = await app.inject({
      method: "POST",
      url: "/v1/renew",
      payload: {
        license: activated.json().license,
        appVersion: "0.2.0"
      }
    });
    const enabled = await app.inject({
      method: "POST",
      url: `/v1/admin/codes/${id}/enable`,
      headers
    });

    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: "CODE_DISABLED" });
    expect(enabled.statusCode).toBe(200);
    await app.close();
  });
});

function activationPayload(code: string, deviceId: string) {
  return {
    code,
    deviceId,
    deviceFingerprint: "a".repeat(64),
    appVersion: "0.1.0"
  };
}

function sourceManagerFixture(
  overrides: Partial<SourceManager> = {}
): SourceManager {
  return {
    list: async () => ({ revision: 0, releases: [] }),
    publishBundle: async () => sourceArtifact(),
    disable: async () => {},
    rollback: async () => ({ revision: 0, releases: [] }),
    ...overrides
  };
}

function sourceArtifact() {
  return {
    id: crypto.randomUUID(),
    productId: "claude-code",
    productName: "Claude Code",
    productDescription: "Anthropic 官方终端编码代理",
    homepageUrl: "https://code.claude.com/docs/en/setup",
    originUrl: "https://code.claude.com/docs/en/setup",
    executable: "claude",
    versionArgs: ["--version"],
    doctorArgs: ["doctor"],
    terminalArgs: [],
    version: "2.1.0",
    platform: "windows" as const,
    arch: "x86_64" as const,
    minOsVersion: "10.0.17763",
    installType: "archive_bundle" as const,
    url: "https://example.com/claude.zip",
    fileName: "claude.zip",
    size: 8,
    sha256: "0".repeat(64),
    args: [],
    requiresElevation: false,
    enabled: true,
    publishedAt: new Date().toISOString(),
    archiveFormat: "zip" as const,
    archiveExecutablePath: "bin/claude.exe"
  };
}

function multipartBody(
  boundary: string,
  fields: Record<string, string>
): Buffer {
  const chunks = Object.entries(fields).map(
    ([name, value]) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
  );
  chunks.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="bundle"; filename="claude.zip"\r\nContent-Type: application/zip\r\n\r\ntest-zip\r\n`
  );
  chunks.push(`--${boundary}--\r\n`);
  return Buffer.from(chunks.join(""));
}
