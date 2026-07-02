import { generateKeyPairSync, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const domain = option("--domain");
const force = args.includes("--force");

if (!domain || !isDomain(domain)) {
  console.error(
    "Usage: node scripts/configure-production.mjs --domain license.example.com [--force]"
  );
  process.exit(1);
}

await mkdir(path.join(root, ".secrets"), { recursive: true });
await mkdir(path.join(root, ".data", "caddy-logs"), { recursive: true });

await ensureSigningKey("license");
await ensureSigningKey("manifest");

const rootEnvPath = path.join(root, ".env");
const apiEnvPath = path.join(root, "services/api/.env");
const adminEnvPath = path.join(root, "tools/admin-cli/.env");
const existingRoot = await readEnv(rootEnvPath);
const existingApi = await readEnv(apiEnvPath);
const existingAdmin = await readEnv(adminEnvPath);
const adminToken =
  !force && secure(existingApi.ADMIN_TOKEN)
    ? existingApi.ADMIN_TOKEN
    : randomBytes(32).toString("base64url");
const hmacSecret =
  !force && secure(existingApi.CODE_HMAC_SECRET)
    ? existingApi.CODE_HMAC_SECRET
    : randomBytes(48).toString("base64url");
const databasePassword =
  !force && secure(existingRoot.POSTGRES_PASSWORD)
    ? existingRoot.POSTGRES_PASSWORD
    : randomBytes(32).toString("hex");

await writeEnv(rootEnvPath, {
  API_DOMAIN: domain,
  POSTGRES_PASSWORD: databasePassword
});
await writeEnv(apiEnvPath, {
  HOST: "0.0.0.0",
  PORT: "8080",
  USE_MEMORY_STORE: "false",
  DATABASE_URL: `postgres://installer:${databasePassword}@127.0.0.1:5432/installer`,
  ADMIN_TOKEN: adminToken,
  CODE_HMAC_SECRET: hmacSecret,
  LICENSE_PRIVATE_KEY_PATH: "/run/secrets/license-private.pem",
  LICENSE_KEY_ID: "license-v1",
  LICENSE_TTL_DAYS: "30",
  TRUST_PROXY_HOPS: "1",
  MAX_UPLOAD_BYTES: "536870912",
  SOURCE_MANAGEMENT_ENABLED: "false"
});
await writeEnv(adminEnvPath, {
  ...existingAdmin,
  ADMIN_API_URL: "http://127.0.0.1:8080",
  ADMIN_TOKEN: adminToken
});

const runtimePath = path.join(
  root,
  "apps/desktop/public/runtime-config.json"
);
const runtime = JSON.parse(await readFile(runtimePath, "utf8"));
runtime.activationApiUrl = `https://${domain}`;
await writeFile(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);

await Promise.all([
  chmod(rootEnvPath, 0o600),
  chmod(apiEnvPath, 0o600),
  chmod(adminEnvPath, 0o600)
]);

console.log(`Production configuration prepared for https://${domain}`);
console.log("Administrator access: ssh -N -L 8080:127.0.0.1:8080 user@server");
console.log("ADMIN_TOKEN was written to tools/admin-cli/.env with mode 0600.");

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function isDomain(value) {
  return (
    /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(value) &&
    value.includes(".") &&
    !value.includes("..")
  );
}

function secure(value) {
  return (
    typeof value === "string" &&
    value.length >= 8 &&
    !/change-me|replace|example|password/i.test(value)
  );
}

async function readEnv(filePath) {
  try {
    const values = {};
    for (const line of (await readFile(filePath, "utf8")).split(/\r?\n/)) {
      if (!line || line.trimStart().startsWith("#")) continue;
      const separator = line.indexOf("=");
      if (separator < 1) continue;
      values[line.slice(0, separator)] = line.slice(separator + 1);
    }
    return values;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeEnv(filePath, values) {
  const lines = Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${value}`);
  await writeFile(filePath, `${lines.join("\n")}\n`, { mode: 0o600 });
}

async function ensureSigningKey(name) {
  const privatePath = path.join(root, ".secrets", `${name}-private.pem`);
  const publicPath = path.join(root, ".secrets", `${name}-public.pem`);
  const rawPath = path.join(root, ".secrets", `${name}-public.raw.b64`);
  try {
    await readFile(privatePath);
    const raw = (await readFile(rawPath, "utf8")).trim();
    await writeFile(
      path.join(
        root,
        "apps/desktop/src-tauri/resources",
        `${name}-public-key.b64`
      ),
      `${raw}\n`
    );
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const pair = generateKeyPairSync("ed25519");
  const privateKey = pair.privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString();
  const publicKey = pair.publicKey
    .export({ format: "pem", type: "spki" })
    .toString();
  const raw = pair.publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("base64");
  await Promise.all([
    writeFile(privatePath, privateKey, { mode: 0o600 }),
    writeFile(publicPath, publicKey),
    writeFile(rawPath, `${raw}\n`)
  ]);
  await writeFile(
    path.join(
      root,
      "apps/desktop/src-tauri/resources",
      `${name}-public-key.b64`
    ),
    `${raw}\n`
  );
}
