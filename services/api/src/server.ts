import "dotenv/config";
import pg from "pg";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { MemoryCodeStore } from "./memory-store.js";
import { LicenseService } from "./service.js";
import { ObjectStorageSourceManager } from "./source-service.js";
import { SqliteCodeStore } from "./sqlite-store.js";
import { PostgresCodeStore } from "./store.js";

const config = await loadConfig();
const store = config.useMemoryStore
  ? new MemoryCodeStore()
  : config.sqlitePath
    ? new SqliteCodeStore(config.sqlitePath)
    : new PostgresCodeStore(
      new pg.Pool({
        connectionString: config.databaseUrl,
        max: 10
      })
    );
await store.initialize();
const service = new LicenseService({
  store,
  codeHmacSecret: config.codeHmacSecret,
  adminActivationCode: config.adminActivationCode,
  licensePrivateKey: config.licensePrivateKey,
  licenseKeyId: config.licenseKeyId,
  licenseTtlDays: config.licenseTtlDays
});
const sourceManager = config.sourceManagerOptions
  ? new ObjectStorageSourceManager(config.sourceManagerOptions)
  : undefined;
const app = await buildApp({
  service,
  adminToken: config.adminToken,
  sourceManager,
  trustProxyHops: config.trustProxyHops,
  maxUploadBytes: config.maxUploadBytes,
  logger: true
});

const shutdown = async () => {
  await app.close();
  await store.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ host: config.host, port: config.port });
