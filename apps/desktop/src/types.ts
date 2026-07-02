export interface RuntimeConfig {
  manifestUrl: string;
  activationApiUrl: string;
  tutorialUrl: string;
  backupDownloadUrl: string;
}

export interface ToolStatus {
  productId: string;
  productName: string;
  executable: string;
  path: string | null;
  version: string | null;
}

export interface SystemInfo {
  platform: "windows" | "macos" | "linux" | "unsupported";
  architecture: "x86_64" | "aarch64" | "unsupported";
  osVersion: string;
  totalMemoryMb: number;
  gitVersion: string | null;
  tools: ToolStatus[];
}

export interface SourceArtifact {
  id: string;
  productId: string;
  productName: string;
  productDescription: string;
  homepageUrl: string;
  originUrl: string;
  executable: string;
  versionArgs: string[];
  doctorArgs?: string[];
  terminalArgs: string[];
  version: string;
  platform: string;
  arch: string;
  minOsVersion?: string;
  installType:
    | "standalone_binary"
    | "native_installer"
    | "script"
    | "archive_bundle";
  url: string;
  fileName: string;
  size: number;
  sha256: string;
  args: string[];
  requiresElevation: boolean;
  enabled: boolean;
  publishedAt: string;
  scriptInterpreter?: string;
  archiveFormat?: "zip" | "tar_gz";
  archiveExecutablePath?: string;
}

export interface ProductInstallOption {
  productId: string;
  productName: string;
  productDescription: string;
  homepageUrl: string;
  installedPath: string | null;
  installedVersion: string | null;
  recommendationReason?: string;
  selected: SourceArtifact | null;
}

export interface ManifestSummary {
  revision: number;
  products: ProductInstallOption[];
}

export interface LicenseStatus {
  active: boolean;
  mode: "development" | "licensed" | "inactive";
  deviceId: string;
  issuedAt?: string;
  expiresAt?: string;
  canRenew: boolean;
  renewalRecommended: boolean;
  daysRemaining?: number;
  message: string;
}

export interface SignedEnvelope {
  algorithm: string;
  keyId: string;
  payload: string;
  signature: string;
}

export interface LicenseRequestContext {
  deviceId: string;
  deviceFingerprint: string;
  appVersion: string;
  license?: SignedEnvelope;
}

export interface DiagnosticResult {
  name: string;
  status: "ok" | "warning" | "error";
  summary: string;
  details?: string;
}

export interface InstallProgress {
  stage: string;
  percent: number;
  message: string;
  current?: number;
  total?: number;
  unit?: "bytes" | "steps";
}

export interface ConfigInput {
  projectDir: string;
  claudeMd: string;
  settings: Record<string, unknown>;
  mcp: Record<string, unknown>;
}

export interface ConfigPreview {
  path: string;
  before: string;
  after: string;
  changed: boolean;
}
