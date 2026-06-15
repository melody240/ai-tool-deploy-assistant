import type {
  Architecture,
  Platform,
  ScriptInterpreter
} from "@ai-tool-installer/shared";

export interface ProductDefinition {
  id: string;
  name: string;
  description: string;
  homepageUrl: string;
  executable: string;
  versionArgs: string[];
  doctorArgs?: string[];
  terminalArgs: string[];
}

export interface OfficialSourceDefinition {
  product: ProductDefinition;
  platform: Platform;
  architectures: Architecture[];
  originUrl: string;
  interpreter: ScriptInterpreter;
  args: string[];
}

export const officialProducts: ProductDefinition[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    description: "Anthropic 官方终端编码代理",
    homepageUrl: "https://code.claude.com/docs/en/setup",
    executable: "claude",
    versionArgs: ["--version"],
    doctorArgs: ["doctor"],
    terminalArgs: []
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    description: "开源个人 AI 助手和消息平台",
    homepageUrl: "https://docs.openclaw.ai/install",
    executable: "openclaw",
    versionArgs: ["--version"],
    doctorArgs: ["doctor"],
    terminalArgs: ["onboard"]
  },
  {
    id: "hermes-agent",
    name: "Hermes Agent",
    description: "Nous Research 开源自主智能体",
    homepageUrl: "https://hermes-agent.nousresearch.com/docs/",
    executable: "hermes",
    versionArgs: ["--version"],
    terminalArgs: ["setup"]
  }
];

const bothArchitectures: Architecture[] = ["x86_64", "aarch64"];

export const officialSources: OfficialSourceDefinition[] = [
  {
    product: officialProducts[0]!,
    platform: "windows",
    architectures: bothArchitectures,
    originUrl: "https://claude.ai/install.ps1",
    interpreter: "powershell",
    args: []
  },
  {
    product: officialProducts[0]!,
    platform: "macos",
    architectures: bothArchitectures,
    originUrl: "https://claude.ai/install.sh",
    interpreter: "bash",
    args: []
  },
  {
    product: officialProducts[0]!,
    platform: "linux",
    architectures: bothArchitectures,
    originUrl: "https://claude.ai/install.sh",
    interpreter: "bash",
    args: []
  },
  {
    product: officialProducts[1]!,
    platform: "windows",
    architectures: bothArchitectures,
    originUrl: "https://openclaw.ai/install.ps1",
    interpreter: "powershell",
    args: ["-NoOnboard"]
  },
  {
    product: officialProducts[1]!,
    platform: "macos",
    architectures: bothArchitectures,
    originUrl: "https://openclaw.ai/install.sh",
    interpreter: "bash",
    args: ["--no-onboard"]
  },
  {
    product: officialProducts[1]!,
    platform: "linux",
    architectures: bothArchitectures,
    originUrl: "https://openclaw.ai/install.sh",
    interpreter: "bash",
    args: ["--no-onboard"]
  },
  {
    product: officialProducts[2]!,
    platform: "windows",
    architectures: bothArchitectures,
    originUrl: "https://hermes-agent.nousresearch.com/install.ps1",
    interpreter: "powershell",
    args: ["-SkipSetup", "-NonInteractive"]
  },
  {
    product: officialProducts[2]!,
    platform: "macos",
    architectures: bothArchitectures,
    originUrl: "https://hermes-agent.nousresearch.com/install.sh",
    interpreter: "bash",
    args: ["--skip-setup", "--non-interactive"]
  },
  {
    product: officialProducts[2]!,
    platform: "linux",
    architectures: bothArchitectures,
    originUrl: "https://hermes-agent.nousresearch.com/install.sh",
    interpreter: "bash",
    args: ["--skip-setup", "--non-interactive"]
  }
];

export function findOfficialProduct(
  productId: string
): ProductDefinition | undefined {
  return officialProducts.find((product) => product.id === productId);
}
