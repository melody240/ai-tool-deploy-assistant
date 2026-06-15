import { createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFile(path.join(root, relative), "utf8");

const [
  runtimeText,
  tauriText,
  manifestKey,
  licenseKey,
  sourceEnvelopeText,
  rootPackageText,
  desktopPackageText,
  sharedPackageText,
  apiPackageText,
  adminPackageText,
  cargoText,
  desktopCapabilityText
] = await Promise.all([
  read("apps/desktop/public/runtime-config.json"),
  read("apps/desktop/src-tauri/tauri.conf.json"),
  read("apps/desktop/src-tauri/resources/manifest-public-key.b64"),
  read("apps/desktop/src-tauri/resources/license-public-key.b64"),
  read("release/source-manifest.signed.json"),
  read("package.json"),
  read("apps/desktop/package.json"),
  read("packages/shared/package.json"),
  read("services/api/package.json"),
  read("tools/admin-cli/package.json"),
  read("apps/desktop/src-tauri/Cargo.toml"),
  read("apps/desktop/src-tauri/capabilities/default.json")
]);
const runtime = JSON.parse(runtimeText);
const tauri = JSON.parse(tauriText);
const sourceEnvelope = JSON.parse(sourceEnvelopeText);
const desktopCapability = JSON.parse(desktopCapabilityText);
const failures = [];

const openUrlPermission = desktopCapability.permissions?.find(
  (permission) =>
    typeof permission === "object" &&
    permission?.identifier === "opener:allow-open-url"
);
if (
  !openUrlPermission ||
  !openUrlPermission.allow?.some((scope) => scope?.url === "https://*")
) {
  failures.push(
    "desktop capability must allow HTTPS URLs for official, source, tutorial, and download buttons"
  );
}

for (const [name, value] of Object.entries(runtime)) {
  if (
    typeof value !== "string" ||
    value.includes("example.com") ||
    value === "https://pan.baidu.com/"
  ) {
    failures.push(`runtime-config.json: replace ${name}`);
    continue;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      failures.push(`runtime-config.json: ${name} must use HTTPS`);
    }
  } catch {
    failures.push(`runtime-config.json: ${name} must be a valid URL`);
  }
}
if (tauri.identifier.startsWith("com.example.")) {
  failures.push("tauri.conf.json: replace the example application identifier");
}
if (tauri.bundle?.createUpdaterArtifacts !== true) {
  failures.push("tauri.conf.json: enable signed updater artifacts");
}
const updaterPublicKey = tauri.plugins?.updater?.pubkey;
if (
  typeof updaterPublicKey !== "string" ||
  updaterPublicKey.length < 80 ||
  updaterPublicKey.includes("REPLACE_WITH")
) {
  failures.push("tauri.conf.json: configure the Tauri updater public key");
} else {
  try {
    const decoded = Buffer.from(updaterPublicKey, "base64").toString("utf8");
    if (!decoded.includes("minisign public key")) {
      failures.push("tauri.conf.json: updater public key is not a minisign key");
    }
  } catch {
    failures.push("tauri.conf.json: updater public key is not valid base64");
  }
}
const updaterEndpoints = tauri.plugins?.updater?.endpoints ?? [];
if (updaterEndpoints.length === 0) {
  failures.push("tauri.conf.json: configure at least one updater endpoint");
}
for (const endpoint of updaterEndpoints) {
  if (!endpoint.startsWith("https://") || endpoint.includes("example.com")) {
    failures.push("tauri.conf.json: configure an HTTPS updater endpoint");
  }
}
const csp = tauri.app?.security?.csp ?? "";
if (/http:\/\/(?!localhost|127\.0\.0\.1|ipc\.localhost|asset\.localhost)/.test(csp)) {
  failures.push("tauri.conf.json: remove non-local HTTP origins from CSP");
}
if (
  manifestKey.trim() ===
  "11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo="
) {
  failures.push("replace the development manifest public key");
}
if (
  licenseKey.trim() ===
  "PUAXw+hDiVqStwqnTRt+vJyYLM8uxJaMwM1V8Sr0Zgw="
) {
  failures.push("replace the development license public key");
}

const packageVersions = [
  ["root", JSON.parse(rootPackageText).version],
  ["desktop", JSON.parse(desktopPackageText).version],
  ["shared", JSON.parse(sharedPackageText).version],
  ["api", JSON.parse(apiPackageText).version],
  ["admin-cli", JSON.parse(adminPackageText).version],
  ["tauri", tauri.version],
  ["cargo", cargoText.match(/^version\s*=\s*"([^"]+)"/m)?.[1]]
];
const expectedVersion = packageVersions[0][1];
for (const [name, version] of packageVersions) {
  if (version !== expectedVersion) {
    failures.push(
      `version mismatch: ${name} is ${version ?? "missing"}, expected ${expectedVersion}`
    );
  }
}

try {
  const payload = Buffer.from(sourceEnvelope.payload, "base64");
  const signature = Buffer.from(sourceEnvelope.signature, "base64");
  const rawPublicKey = Buffer.from(manifestKey.trim(), "base64");
  const publicKey = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      rawPublicKey
    ]),
    format: "der",
    type: "spki"
  });
  if (!verify(null, payload, publicKey, signature)) {
    failures.push("source manifest signature verification failed");
  } else {
    const sourceManifest = JSON.parse(payload.toString("utf8"));
    const activeReleases = Object.values(sourceManifest.activeReleaseIds).map(
      (id) => sourceManifest.releases.find((release) => release.id === id)
    );
    if (activeReleases.some((release) => !release || !release.enabled)) {
      failures.push("source manifest has a missing or disabled active release");
    }
    const manifestHost = new URL(runtime.manifestUrl).host;
    for (const release of activeReleases.filter(Boolean)) {
      const sourceUrl = new URL(release.url);
      if (sourceUrl.protocol !== "https:" || sourceUrl.host !== manifestHost) {
        failures.push(
          `active source ${release.productId}/${release.platform}/${release.arch} is not mirrored beside the manifest`
        );
      }
    }
  }
} catch (error) {
  failures.push(`source manifest validation failed: ${error.message}`);
}

if (failures.length > 0) {
  console.error("Release configuration is incomplete:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log("Release configuration check passed.");
