import path from "node:path";

export interface AdminConfig {
  manifestPath: string;
  historyDirectory: string;
  manifestPrivateKeyPath: string;
  manifestPublicKeyPath: string;
  manifestKeyId: string;
  apiUrl?: string;
  adminToken?: string;
  storage?: {
    endpoint?: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    publicBaseUrl: string;
    forcePathStyle: boolean;
    manifestObjectKey: string;
    updaterObjectKey: string;
  };
}

export function loadConfig(): AdminConfig {
  const root = process.cwd();
  const storageConfigured =
    process.env.STORAGE_BUCKET &&
    process.env.STORAGE_ACCESS_KEY_ID &&
    process.env.STORAGE_SECRET_ACCESS_KEY &&
    process.env.STORAGE_PUBLIC_BASE_URL;

  return {
    manifestPath: path.resolve(
      process.env.MANIFEST_PATH ?? path.join(root, "release/source-manifest.signed.json")
    ),
    historyDirectory: path.resolve(
      process.env.MANIFEST_HISTORY_DIR ?? path.join(root, "release/history")
    ),
    manifestPrivateKeyPath: path.resolve(
      process.env.MANIFEST_PRIVATE_KEY ?? path.join(root, ".secrets/manifest-private.pem")
    ),
    manifestPublicKeyPath: path.resolve(
      process.env.MANIFEST_PUBLIC_KEY ?? path.join(root, ".secrets/manifest-public.pem")
    ),
    manifestKeyId: process.env.MANIFEST_KEY_ID ?? "manifest-v1",
    apiUrl: process.env.ADMIN_API_URL,
    adminToken: process.env.ADMIN_TOKEN,
    storage: storageConfigured
      ? {
          endpoint: process.env.STORAGE_ENDPOINT,
          region: process.env.STORAGE_REGION ?? "auto",
          bucket: process.env.STORAGE_BUCKET!,
          accessKeyId: process.env.STORAGE_ACCESS_KEY_ID!,
          secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY!,
          publicBaseUrl: process.env.STORAGE_PUBLIC_BASE_URL!.replace(/\/$/, ""),
          forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE === "true",
          manifestObjectKey:
            process.env.STORAGE_MANIFEST_KEY ?? "manifests/source-manifest.json",
          updaterObjectKey:
            process.env.STORAGE_UPDATER_KEY ?? "updates/latest.json"
        }
      : undefined
  };
}
