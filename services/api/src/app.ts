import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { z } from "zod";
import {
  activationRequestSchema,
  renewalRequestSchema
} from "@ai-tool-installer/shared";
import { LicenseService, secureTokenEquals, type ServiceError } from "./service.js";
import type {
  PublishBundleInput,
  SourceManager
} from "./source-service.js";

export interface BuildAppOptions {
  service: LicenseService;
  adminToken: string;
  sourceManager?: SourceManager;
  trustProxyHops?: number;
  maxUploadBytes?: number;
  logger?: boolean;
}

const createCodesSchema = z.object({
  count: z.coerce.number().int().min(1).max(500),
  label: z.string().trim().max(120).optional(),
  batch: z.string().trim().max(80).optional(),
  maxResets: z.coerce.number().int().min(0).max(20).default(1),
  expiresAt: z.string().datetime().optional()
});

const listCodesQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  status: z.enum(["all", "active", "disabled"]).default("all"),
  batch: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0)
});

const desktopOrigins = new Set([
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost"
]);

function isLicenseRoute(url: string) {
  return url.startsWith("/v1/activate") || url.startsWith("/v1/renew");
}

export async function buildApp(options: BuildAppOptions) {
  const app = Fastify({
    trustProxy: options.trustProxyHops ?? 0,
    logger: options.logger
      ? {
          redact: {
            paths: [
              "req.headers.authorization",
              "req.body.code",
              "res.headers.authorization"
            ],
            censor: "[REDACTED]"
          }
        }
      : false,
    bodyLimit: 32 * 1024
  });

  await app.register(rateLimit, {
    global: false
  });
  await app.register(multipart, {
    limits: {
      files: 1,
      fields: 20,
      fileSize: options.maxUploadBytes ?? 512 * 1024 * 1024
    }
  });

  app.addHook("onSend", async (request, reply, payload) => {
    const origin = request.headers.origin;
    const allowedDesktopOrigin =
      isLicenseRoute(request.url) &&
      typeof origin === "string" &&
      desktopOrigins.has(origin);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
    );
    reply.header(
      "Cross-Origin-Resource-Policy",
      allowedDesktopOrigin ? "cross-origin" : "same-origin"
    );
    if (allowedDesktopOrigin) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Access-Control-Allow-Methods", "POST, OPTIONS");
      reply.header("Access-Control-Allow-Headers", "Content-Type");
      reply.header("Access-Control-Max-Age", "86400");
      reply.header("Vary", "Origin");
    }
    reply.header(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains"
    );
    if (
      request.url.startsWith("/admin") ||
      request.url.startsWith("/v1/admin") ||
      request.url.startsWith("/v1/activate") ||
      request.url.startsWith("/v1/renew")
    ) {
      reply.header("Cache-Control", "no-store");
    }
    return payload;
  });

  app.get("/live", async () => ({ status: "ok" }));
  app.get("/health", async () => {
    await options.service.health();
    return { status: "ok", database: "ok" };
  });
  app.get("/tutorial", async (_request, reply) =>
    sendPublicAsset(reply, "tutorial.html", "text/html; charset=utf-8")
  );
  app.get("/downloads", async (_request, reply) =>
    sendPublicAsset(reply, "downloads.html", "text/html; charset=utf-8")
  );
  app.get("/admin", async (_request, reply) =>
    sendAdminAsset(reply, "admin.html", "text/html; charset=utf-8")
  );
  app.get("/admin/admin.css", async (_request, reply) =>
    sendAdminAsset(reply, "admin.css", "text/css; charset=utf-8")
  );
  app.get("/admin/admin.js", async (_request, reply) =>
    sendAdminAsset(reply, "admin.js", "text/javascript; charset=utf-8")
  );

  for (const path of ["/v1/activate", "/v1/renew"]) {
    app.options(path, async (request, reply) => {
      const origin = request.headers.origin;
      if (typeof origin !== "string" || !desktopOrigins.has(origin)) {
        return reply.code(403).send({ error: "ORIGIN_NOT_ALLOWED" });
      }
      return reply.code(204).send();
    });
  }

  app.post(
    "/v1/activate",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request) => {
      const input = activationRequestSchema.parse(request.body);
      return { license: await options.service.activate(input) };
    }
  );
  app.post(
    "/v1/renew",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request) => {
      const input = renewalRequestSchema.parse(request.body);
      return {
        license: await options.service.renew(input.license, input.appVersion)
      };
    }
  );

  app.register(async (admin) => {
    admin.addHook(
      "onRequest",
      admin.rateLimit({
        max: 30,
        timeWindow: "1 minute",
        groupId: "admin"
      })
    );
    admin.addHook("onRequest", async (request, reply) => {
      const authorization = request.headers.authorization ?? "";
      const token = authorization.startsWith("Bearer ")
        ? authorization.slice(7)
        : "";
      if (!secureTokenEquals(token, options.adminToken)) {
        return reply.code(401).send({ error: "UNAUTHORIZED" });
      }
    });

    admin.post("/codes", async (request) => {
      const body = createCodesSchema.parse(request.body);
      return { codes: await options.service.createCodes(body) };
    });
    admin.get("/codes", async (request) =>
      options.service.listCodes(listCodesQuerySchema.parse(request.query))
    );
    admin.get("/stats", async () => options.service.stats());
    admin.get("/audit", async (request) => {
      const query = z
        .object({
          limit: z.coerce.number().int().min(1).max(500).default(100)
        })
        .parse(request.query);
      return { events: await options.service.listAudit(query.limit) };
    });
    admin.post<{ Params: { identifier: string } }>(
      "/codes/:identifier/reset",
      async (request) => {
        await options.service.reset(request.params.identifier);
        return { ok: true };
      }
    );
    admin.post<{ Params: { identifier: string } }>(
      "/codes/:identifier/disable",
      async (request) => {
        await options.service.disable(request.params.identifier);
        return { ok: true };
      }
    );
    admin.post<{ Params: { identifier: string } }>(
      "/codes/:identifier/enable",
      async (request) => {
        await options.service.enable(request.params.identifier);
        return { ok: true };
      }
    );

    admin.get("/sources", async () => {
      if (!options.sourceManager) {
        return { configured: false, revision: 0, releases: [] };
      }
      return { configured: true, ...(await options.sourceManager.list()) };
    });
    admin.post("/sources/bundles", async (request, reply) => {
      if (!options.sourceManager) {
        return reply
          .code(503)
          .send({ error: "SOURCE_MANAGEMENT_NOT_CONFIGURED" });
      }
      const temporary = await mkdtemp(path.join(tmpdir(), "ai-tool-bundle-"));
      const filePath = path.join(temporary, "upload.bin");
      let originalFilename = "";
      const fields: Record<string, string> = {};
      try {
        for await (const part of request.parts()) {
          if (part.type === "file") {
            if (originalFilename) {
              part.file.resume();
              throw requestError("ONE_FILE_ONLY", 400);
            }
            originalFilename = part.filename;
            await pipeline(part.file, createWriteStream(filePath, { mode: 0o600 }));
          } else {
            fields[part.fieldname] = String(part.value);
          }
        }
        if (!originalFilename) throw requestError("BUNDLE_FILE_REQUIRED", 400);
        const input: PublishBundleInput = {
          filePath,
          originalFilename,
          productId: fields.productId ?? "",
          platform: fields.platform ?? "",
          arch: fields.arch ?? "",
          minOsVersion: fields.minOsVersion,
          version: fields.version ?? "",
          executablePath: fields.executablePath ?? "",
          originUrl: fields.originUrl
        };
        return {
          source: await options.sourceManager.publishBundle(input)
        };
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    });
    admin.post<{ Params: { sourceId: string } }>(
      "/sources/:sourceId/disable",
      async (request) => {
        if (!options.sourceManager) {
          throw requestError("SOURCE_MANAGEMENT_NOT_CONFIGURED", 503);
        }
        await options.sourceManager.disable(request.params.sourceId);
        return { ok: true };
      }
    );
    admin.post<{ Params: { revision: string } }>(
      "/sources/rollback/:revision",
      async (request) => {
        if (!options.sourceManager) {
          throw requestError("SOURCE_MANAGEMENT_NOT_CONFIGURED", 503);
        }
        return options.sourceManager.rollback(
          Number(request.params.revision)
        );
      }
    );
  }, { prefix: "/v1/admin" });

  app.setErrorHandler((error, _request, reply) => {
    const serviceError = error as Partial<ServiceError>;
    if (serviceError.statusCode === 429) {
      return reply.code(429).send({ error: "RATE_LIMITED" });
    }
    if (serviceError.statusCode && serviceError.code) {
      return reply
        .code(serviceError.statusCode)
        .send({ error: serviceError.code });
    }
    if ((error as Error).name === "ZodError") {
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    }
    app.log.error(error);
    return reply.code(500).send({ error: "INTERNAL_ERROR" });
  });

  return app;
}

async function sendAdminAsset(
  reply: {
    type(contentType: string): unknown;
    header(name: string, value: string): unknown;
    send(payload: string | Buffer): unknown;
  },
  fileName: string,
  contentType: string
) {
  reply.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'"
  );
  reply.type(contentType);
  return reply.send(
    await readFile(new URL(`../public/${fileName}`, import.meta.url))
  );
}

async function sendPublicAsset(
  reply: {
    type(contentType: string): unknown;
    header(name: string, value: string): unknown;
    send(payload: string | Buffer): unknown;
  },
  fileName: string,
  contentType: string
) {
  reply.header(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"
  );
  reply.header("Cache-Control", "public, max-age=300");
  reply.type(contentType);
  return reply.send(
    await readFile(new URL(`../public/${fileName}`, import.meta.url))
  );
}

function requestError(code: string, statusCode: number): Error {
  return Object.assign(new Error(code), { code, statusCode });
}
