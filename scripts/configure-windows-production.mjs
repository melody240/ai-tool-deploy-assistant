import {
  createPrivateKey,
  createPublicKey,
  randomBytes
} from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const root = path.resolve(option("--root") ?? "C:\\ai-tool-installer");
const expectedPublicKeyPath = path.resolve(
  option("--expected-public-key") ??
    path.join(root, "config", "license-public-key.b64")
);
const host = option("--host") ?? "127.0.0.1";
const port = option("--port") ?? "8080";
const secretsDirectory = path.join(root, ".secrets");
const dataDirectory = path.join(root, ".data");
const privateKeyPath = path.join(secretsDirectory, "license-private.pem");
const apiEnvPath = path.join(root, "services", "api", ".env");
const existingApi = await readEnv(apiEnvPath);

await Promise.all([
  mkdir(secretsDirectory, { recursive: true }),
  mkdir(dataDirectory, { recursive: true }),
  mkdir(path.join(root, "services", "api"), { recursive: true })
]);

const privateKey = await readFile(privateKeyPath, "utf8").catch((error) => {
  if (error.code === "ENOENT") {
    throw new Error(
      `Existing license signing key is missing: ${privateKeyPath}. ` +
        "Do not generate a replacement without rebuilding the desktop client."
    );
  }
  throw error;
});
const expectedPublicKey = (await readFile(expectedPublicKeyPath, "utf8")).trim();
const actualPublicKey = createPublicKey(createPrivateKey(privateKey))
  .export({ format: "der", type: "spki" })
  .subarray(-32)
  .toString("base64");
if (actualPublicKey !== expectedPublicKey) {
  throw new Error(
    "The server license signing key does not match the formal desktop client."
  );
}

const adminToken = secure(existingApi.ADMIN_TOKEN, 32)
  ? existingApi.ADMIN_TOKEN
  : randomBytes(32).toString("base64url");
const hmacSecret = secure(existingApi.CODE_HMAC_SECRET, 32)
  ? existingApi.CODE_HMAC_SECRET
  : randomBytes(48).toString("base64url");
const adminTokenPath = path.join(secretsDirectory, "admin-token.txt");
const values = {
  NODE_ENV: "production",
  HOST: host,
  PORT: port,
  DATABASE_URL: "",
  SQLITE_PATH: path.join(dataDirectory, "license.sqlite3"),
  USE_MEMORY_STORE: "false",
  ADMIN_TOKEN: adminToken,
  CODE_HMAC_SECRET: hmacSecret,
  LICENSE_PRIVATE_KEY_PATH: privateKeyPath,
  LICENSE_KEY_ID: "license-v1",
  LICENSE_TTL_DAYS: "30",
  TRUST_PROXY_HOPS: "1",
  MAX_UPLOAD_BYTES: "536870912",
  SOURCE_MANAGEMENT_ENABLED: "false"
};
await writeFile(
  apiEnvPath,
  `${Object.entries(values)
    .filter(([, value]) => value !== "")
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`,
  { mode: 0o600 }
);
await writeFile(
  adminTokenPath,
  [
    "AI Tool Installer production administrator token",
    `ADMIN_API_URL=http://127.0.0.1:${port}`,
    `ADMIN_TOKEN=${adminToken}`,
    ""
  ].join("\n"),
  { mode: 0o600 }
);
await Promise.all([
  chmod(apiEnvPath, 0o600).catch(() => {}),
  chmod(adminTokenPath, 0o600).catch(() => {})
]);

console.log(`Production API configuration written to ${apiEnvPath}`);
console.log(`Administrator credentials written to ${adminTokenPath}`);

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
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

function secure(value, minimumLength) {
  return (
    typeof value === "string" &&
    value.length >= minimumLength &&
    !/change-me|replace-with|example|password/i.test(value)
  );
}
