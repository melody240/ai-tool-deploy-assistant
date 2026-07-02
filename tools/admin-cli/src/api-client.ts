import type { AdminConfig } from "./config.js";

export async function adminRequest<T>(
  config: AdminConfig,
  method: string,
  pathname: string,
  body?: unknown
): Promise<T> {
  if (!config.apiUrl || !config.adminToken) {
    throw new Error("ADMIN_API_URL and ADMIN_TOKEN are required");
  }
  if (config.adminToken.length < 8) {
    throw new Error("ADMIN_TOKEN must contain at least 8 characters");
  }
  const baseUrl = validateAdminApiUrl(config.apiUrl);
  const response = await fetch(
    new URL(pathname, baseUrl),
    {
      method,
      headers: {
        authorization: `Bearer ${config.adminToken}`,
        "content-type": "application/json"
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    }
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `Admin API returned HTTP ${response.status}: ${JSON.stringify(payload)}`
    );
  }
  return payload as T;
}

export function validateAdminApiUrl(value: string): URL {
  const url = new URL(value.endsWith("/") ? value : `${value}/`);
  const local =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1";
  const temporaryAliyunHttp =
    url.protocol === "http:" && url.hostname === "101.37.86.232";
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && local) &&
    !temporaryAliyunHttp
  ) {
    throw new Error(
      "ADMIN_API_URL must use HTTPS, except for a localhost SSH tunnel or the configured temporary Aliyun IP"
    );
  }
  if (url.username || url.password) {
    throw new Error("ADMIN_API_URL must not contain credentials");
  }
  return url;
}
