import { invoke } from "@tauri-apps/api/core";
import type {
  ConfigInput,
  ConfigPreview,
  DiagnosticResult,
  LicenseRequestContext,
  LicenseStatus,
  ManifestSummary,
  ProductInstallOption,
  SignedEnvelope,
  SourceArtifact,
  SystemInfo
} from "./types";

async function postLicenseRequest(
  apiUrl: string,
  path: "/v1/activate" | "/v1/renew",
  body: Record<string, unknown>
): Promise<LicenseStatus> {
  const endpoint = new URL(path, apiUrl);
  if (!isAllowedLicenseEndpoint(endpoint)) {
    throw new Error("许可证服务地址不被当前客户端信任");
  }
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 20_000);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("连接授权服务器超时，请检查网络或稍后重试");
    }
    throw new Error("无法连接授权服务器，请检查网络或联系卖家确认服务地址");
  } finally {
    window.clearTimeout(timeout);
  }
  const payload = (await response.json().catch(() => ({}))) as {
    license?: SignedEnvelope;
    error?: string;
  };
  if (!response.ok || !payload.license) {
    throw new Error(friendlyLicenseError(payload.error, response.status));
  }
  return invoke<LicenseStatus>("accept_license_response", {
    license: payload.license
  });
}

function isAllowedLicenseEndpoint(endpoint: URL) {
  if (endpoint.protocol === "https:") return true;
  return endpoint.protocol === "http:" && endpoint.hostname === "101.37.86.232";
}

function friendlyLicenseError(error: string | undefined, status: number) {
  if (error === "CODE_ALREADY_BOUND" || error === "LICENSE_DEVICE_MISMATCH") {
    return "兑换码已绑定其他设备";
  }
  if (error === "CODE_DISABLED") return "兑换码已停用";
  if (error === "CODE_EXPIRED") return "兑换码授权期限已结束";
  if (error === "INVALID_CODE") return "兑换码无效";
  if (error === "INVALID_LICENSE") return "本机许可证无效，请重新输入兑换码";
  return `许可证请求失败（HTTP ${status}），请检查网络后重试`;
}

const nativeBackend = {
  getSystemInfo: () => invoke<SystemInfo>("get_system_info"),
  getLicenseStatus: () => invoke<LicenseStatus>("get_license_status"),
  activate: async (apiUrl: string, code: string) => {
    const context = await invoke<LicenseRequestContext>(
      "get_license_request_context",
      { includeLicense: false }
    );
    return postLicenseRequest(apiUrl, "/v1/activate", {
      code,
      deviceId: context.deviceId,
      deviceFingerprint: context.deviceFingerprint,
      appVersion: context.appVersion
    });
  },
  renew: async (apiUrl: string) => {
    const context = await invoke<LicenseRequestContext>(
      "get_license_request_context",
      { includeLicense: true }
    );
    return postLicenseRequest(apiUrl, "/v1/renew", {
      license: context.license,
      appVersion: context.appVersion
    });
  },
  fetchManifest: (manifestUrl: string) =>
    invoke<ManifestSummary>("fetch_manifest_summary", { manifestUrl }),
  install: (manifestUrl: string, sourceId: string) =>
    invoke<string>("install_source", { manifestUrl, sourceId }),
  uninstall: (productId: string) =>
    invoke<string>("uninstall_managed", { productId }),
  diagnostics: (productId: string) =>
    invoke<DiagnosticResult[]>("run_product_diagnostics", { productId }),
  openTerminal: (manifestUrl: string, sourceId: string) =>
    invoke<void>("open_product_terminal", { manifestUrl, sourceId }),
  previewConfig: (input: ConfigInput) =>
    invoke<ConfigPreview[]>("preview_config", { input }),
  applyConfig: (input: ConfigInput) =>
    invoke<ConfigPreview[]>("apply_config", { input })
};

const products = [
  {
    id: "claude-code",
    name: "Claude Code",
    description: "Anthropic 官方终端编码代理",
    homepageUrl: "https://code.claude.com/docs/en/setup",
    executable: "claude",
    terminalArgs: []
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    description: "开源个人 AI 助手和消息平台",
    homepageUrl: "https://docs.openclaw.ai/install",
    executable: "openclaw",
    terminalArgs: ["onboard"]
  },
  {
    id: "hermes-agent",
    name: "Hermes Agent",
    description: "Nous Research 开源自主智能体",
    homepageUrl: "https://hermes-agent.nousresearch.com/docs/",
    executable: "hermes",
    terminalArgs: ["setup"]
  }
];

export const officialCatalog = products.map((product) => ({
  productId: product.id,
  productName: product.name,
  productDescription: product.description,
  homepageUrl: product.homepageUrl,
  executable: product.executable
}));

function previewSource(
  product: (typeof products)[number],
  index: number
): SourceArtifact {
  return {
    id: `preview-${product.id}`,
    productId: product.id,
    productName: product.name,
    productDescription: product.description,
    homepageUrl: product.homepageUrl,
    originUrl: `${product.homepageUrl}#installer`,
    executable: product.executable,
    versionArgs: ["--version"],
    doctorArgs: index < 2 ? ["doctor"] : undefined,
    terminalArgs: product.terminalArgs,
    version: index === 0 ? "2.1.0" : "latest",
    platform: "macos",
    arch: "aarch64",
    minOsVersion: "12.0",
    installType: "archive_bundle",
    url: `https://preview-bucket.oss-cn-hangzhou.aliyuncs.com/sources/${product.id}/macos/aarch64/bundle.tar.gz`,
    fileName: `${product.id}-macos-arm64.tar.gz`,
    size: 256_000_000 + index * 8_000_000,
    sha256: "0".repeat(64),
    args: [],
    requiresElevation: false,
    enabled: true,
    publishedAt: new Date().toISOString(),
    archiveFormat: "tar_gz",
    archiveExecutablePath: `bin/${product.executable}`
  };
}

const previewOptions: ProductInstallOption[] = products.map((product, index) => ({
  productId: product.id,
  productName: product.name,
  productDescription: product.description,
  homepageUrl: product.homepageUrl,
  installedPath: index === 1 ? "/opt/homebrew/bin/openclaw" : null,
  installedVersion: index === 1 ? "OpenClaw 1.8.2" : null,
  recommendationReason: "适配当前 macOS 15.5 与 Apple 芯片",
  selected: previewSource(product, index)
}));

const previewBackend = {
  getSystemInfo: async (): Promise<SystemInfo> => ({
    platform: "macos",
    architecture: "aarch64",
    osVersion: "15.5",
    totalMemoryMb: 16384,
    gitVersion: "git version 2.49.0",
    tools: previewOptions.map((product) => {
      const selected = product.selected!;
      return {
        productId: product.productId,
        productName: product.productName,
        executable: selected.executable,
        path: product.installedPath,
        version: product.installedVersion
      };
    })
  }),
  getLicenseStatus: async (): Promise<LicenseStatus> => ({
    active: true,
    mode: "development",
    deviceId: "00000000-0000-4000-8000-000000000000",
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    canRenew: false,
    renewalRecommended: false,
    daysRemaining: 30,
    message: "浏览器预览正在使用测试模式"
  }),
  activate: async () => previewBackend.getLicenseStatus(),
  renew: async () => previewBackend.getLicenseStatus(),
  fetchManifest: async (): Promise<ManifestSummary> =>
    new URLSearchParams(window.location.search).has("unpublished")
      ? { revision: 0, products: [] }
      : {
          revision: 18,
          products: previewOptions
        },
  install: async () => "界面预览：安装完成",
  uninstall: async () => "界面预览：已卸载",
  diagnostics: async (productId: string): Promise<DiagnosticResult[]> => [
    {
      name: "系统兼容性",
      status: "ok",
      summary: "macos / aarch64"
    },
    {
      name: "工具路径",
      status: productId === "openclaw" ? "ok" : "warning",
      summary: productId === "openclaw"
        ? "/opt/homebrew/bin/openclaw"
        : "尚未安装"
    }
  ],
  openTerminal: async () => {},
  previewConfig: async (input: ConfigInput): Promise<ConfigPreview[]> => [
    {
      path: `${input.projectDir}/CLAUDE.md`,
      before: "",
      after: input.claudeMd,
      changed: true
    }
  ],
  applyConfig: async (input: ConfigInput) => previewBackend.previewConfig(input)
};

const isBrowserPreview =
  import.meta.env.DEV &&
  typeof window !== "undefined" &&
  !("__TAURI_INTERNALS__" in window);

export const backend = isBrowserPreview ? previewBackend : nativeBackend;
