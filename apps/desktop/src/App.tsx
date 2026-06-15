import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { animate, stagger } from "animejs";
import { gsap } from "gsap";
import {
  Activity,
  BadgeCheck,
  BookOpen,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Code2,
  Download,
  ExternalLink,
  FolderOpen,
  HardDriveDownload,
  Info,
  KeyRound,
  LoaderCircle,
  PackageOpen,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Terminal,
  Trash2,
  WandSparkles,
  X
} from "lucide-react";
import { backend, officialCatalog } from "./api";
import { parseJsonObject } from "./config-input";
import type {
  ConfigInput,
  ConfigPreview,
  DiagnosticResult,
  InstallProgress,
  LicenseStatus,
  ManifestSummary,
  ProductInstallOption,
  RuntimeConfig,
  SystemInfo
} from "./types";

const defaultClaudeMd = `# 项目工作规则

## 开发流程
- 修改前先阅读相关代码，理解现有结构和约定。
- 只修改当前任务需要的内容，不随意重构无关代码。
- 完成后运行项目已有的测试和检查。

## 安全要求
- 不要读取、打印、提交或上传密钥和隐私文件。
- 执行删除数据、修改数据库或基础设施操作前先询问。
`;

const defaultSettings = {
  $schema: "https://json.schemastore.org/claude-code-settings.json",
  permissions: {
    deny: [
      "Read(./.env)",
      "Read(./.env.*)",
      "Read(./secrets/**)",
      "Read(./**/*.pem)",
      "Read(./**/*.key)"
    ]
  }
};

const ccSwitchRelease = {
  version: "3.16.2",
  releaseUrl: "https://github.com/farion1231/cc-switch/releases/tag/v3.16.2",
  downloads: {
    macos: {
      url: "https://github.com/farion1231/cc-switch/releases/download/v3.16.2/CC-Switch-v3.16.2-macOS.dmg",
      label: "下载 macOS 通用版",
      sha256: "004a28e79f60f34840e32ed54c394c1ffdb55f25e90dfdf8cc5c3435fb987d8b"
    },
    windows: {
      url: "https://github.com/farion1231/cc-switch/releases/download/v3.16.2/CC-Switch-v3.16.2-Windows.msi",
      label: "下载 Windows 安装版",
      sha256: "bb22096a39ec00502e25129a966f16fe55da85f4b006064abfbaf06f3fd14d75"
    }
  }
} as const;

export default function App() {
  const motionRootRef = useRef<HTMLElement>(null);
  const [runtime, setRuntime] = useState<RuntimeConfig | null>(null);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [license, setLicense] = useState<LicenseStatus | null>(null);
  const [manifest, setManifest] = useState<ManifestSummary | null>(null);
  const [activationCode, setActivationCode] = useState("");
  const [busy, setBusy] = useState<string | null>("startup");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  const [activeProduct, setActiveProduct] = useState<string | null>(null);
  const [setupProductId, setSetupProductId] = useState("claude-code");
  const [detailProduct, setDetailProduct] =
    useState<ProductInstallOption | null>(null);
  const [diagnostics, setDiagnostics] = useState<
    Record<string, DiagnosticResult[]>
  >({});
  const [projectDir, setProjectDir] = useState("");
  const [claudeMd, setClaudeMd] = useState(defaultClaudeMd);
  const [settingsText, setSettingsText] = useState(
    JSON.stringify(defaultSettings, null, 2)
  );
  const [mcpText, setMcpText] = useState("{}");
  const [previews, setPreviews] = useState<ConfigPreview[]>([]);
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const [updateProgress, setUpdateProgress] = useState<number | null>(null);
  const motionReady = busy !== "startup";

  useEffect(() => {
    let disposed = false;
    const startup = async () => {
      try {
        const config = (await fetch("/runtime-config.json").then((response) =>
          response.json()
        )) as RuntimeConfig;
        if (disposed) return;
        setRuntime(config);
        const [systemInfo, licenseStatus] = await Promise.all([
          backend.getSystemInfo(),
          backend.getLicenseStatus()
        ]);
        if (disposed) return;
        setSystem(systemInfo);
        let effectiveLicense = licenseStatus;
        if (
          licenseStatus.canRenew &&
          (licenseStatus.renewalRecommended || !licenseStatus.active)
        ) {
          try {
            effectiveLicense = await backend.renew(config.activationApiUrl);
          } catch (reason) {
            if (!licenseStatus.active) throw reason;
            setError(`自动续期暂时失败：${messageOf(reason)}`);
          }
        }
        if (disposed) return;
        setLicense(effectiveLicense);
        if (effectiveLicense.active) {
          setManifest(await backend.fetchManifest(config.manifestUrl));
        }
        if ("__TAURI_INTERNALS__" in window) {
          void checkAppUpdate(true);
        }
      } catch (reason) {
        setError(messageOf(reason));
      } finally {
        setBusy(null);
      }
    };
    startup();
    const unlisten = listen<InstallProgress>("install-progress", (event) => {
      setProgress(event.payload);
    }).catch(() => () => {});
    return () => {
      disposed = true;
      void unlisten.then((dispose) => dispose());
    };
  }, []);

  useEffect(() => {
    if (!detailProduct) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDetailProduct(null);
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [detailProduct]);

  useEffect(() => {
    setPreviews([]);
  }, [projectDir, claudeMd, settingsText, mcpText]);

  useEffect(() => {
    const root = motionRootRef.current;
    if (!motionReady || !root) return;
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    if (reducedMotion) return;

    const context = gsap.context(() => {
      gsap.fromTo(
        ".motion-reveal",
        { autoAlpha: 0, y: 28, rotateX: -5 },
        {
          autoAlpha: 1,
          y: 0,
          rotateX: 0,
          duration: 0.72,
          stagger: 0.07,
          ease: "power3.out"
        }
      );
      gsap.fromTo(
        ".hero-orbit",
        { rotate: -8, scale: 0.92 },
        {
          rotate: 8,
          scale: 1.04,
          duration: 5,
          repeat: -1,
          yoyo: true,
          ease: "sine.inOut"
        }
      );
    }, root);

    const iconAnimation = animate(root.querySelectorAll(".status-card svg"), {
      scale: [0.65, 1],
      rotate: [-12, 0],
      opacity: [0, 1],
      delay: stagger(85),
      duration: 620,
      ease: "out(3)"
    });

    const tilted = Array.from(
      root.querySelectorAll<HTMLElement>("[data-tilt]")
    );
    const cleanups = tilted.map((element) => {
      const move = (event: PointerEvent) => {
        const bounds = element.getBoundingClientRect();
        const rotateY = ((event.clientX - bounds.left) / bounds.width - 0.5) * 7;
        const rotateX =
          ((event.clientY - bounds.top) / bounds.height - 0.5) * -7;
        gsap.to(element, {
          rotateX,
          rotateY,
          y: -3,
          duration: 0.35,
          transformPerspective: 900,
          ease: "power2.out"
        });
      };
      const leave = () =>
        gsap.to(element, {
          rotateX: 0,
          rotateY: 0,
          y: 0,
          duration: 0.5,
          ease: "power3.out"
        });
      element.addEventListener("pointermove", move);
      element.addEventListener("pointerleave", leave);
      return () => {
        element.removeEventListener("pointermove", move);
        element.removeEventListener("pointerleave", leave);
      };
    });

    return () => {
      cleanups.forEach((cleanup) => cleanup());
      iconAnimation.revert();
      context.revert();
    };
  }, [motionReady]);

  const targetLabel = useMemo(() => {
    if (!system) return "检测中";
    return `${system.platform} / ${system.architecture}`;
  }, [system]);

  const installedCount =
    system?.tools.filter((tool) => tool.version).length ?? 0;
  const isDevelopmentMode = license?.mode === "development";
  const publishedOfficialCount =
    manifest?.products.filter((product) =>
      officialCatalog.some(
        (catalogProduct) => catalogProduct.productId === product.productId
      )
    ).length ?? 0;
  const displayProducts = useMemo(
    () => {
      const official = officialCatalog.map((catalogProduct) => {
        const published = manifest?.products.find(
          (product) => product.productId === catalogProduct.productId
        );
        if (published) return published;
        const installed = system?.tools.find(
          (tool) => tool.productId === catalogProduct.productId
        );
        return {
          productId: catalogProduct.productId,
          productName: catalogProduct.productName,
          productDescription: catalogProduct.productDescription,
          homepageUrl: catalogProduct.homepageUrl,
          installedPath: installed?.path ?? null,
          installedVersion: installed?.version ?? null,
          selected: null
        } satisfies ProductInstallOption;
      });
      const custom =
        manifest?.products.filter(
          (product) =>
            !officialCatalog.some(
              (catalogProduct) =>
                catalogProduct.productId === product.productId
            )
        ) ?? [];
      return [...official, ...custom];
    },
    [manifest, system]
  );

  async function runAction<T>(
    name: string,
    action: () => Promise<T>
  ): Promise<T | undefined> {
    setBusy(name);
    setError(null);
    try {
      return await action();
    } catch (reason) {
      setError(messageOf(reason));
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  async function refreshProducts() {
    const systemInfo = await backend.getSystemInfo();
    setSystem(systemInfo);
    if (!runtime) return;
    try {
      setManifest(await backend.fetchManifest(runtime.manifestUrl));
    } catch (reason) {
      setUpdateMessage(
        `本机状态已刷新，服务器安装清单暂时不可用：${messageOf(reason)}`
      );
    }
  }

  async function activate() {
    if (!runtime || !activationCode.trim()) return;
    const result = await runAction("activate", () =>
      backend.activate(runtime.activationApiUrl, activationCode.trim())
    );
    if (result) {
      setLicense(result);
      const refreshed = await runAction("manifest", () =>
        Promise.all([
          backend.getSystemInfo(),
          backend.fetchManifest(runtime.manifestUrl)
        ])
      );
      if (refreshed) {
        setSystem(refreshed[0]);
        setManifest(refreshed[1]);
      } else {
        setManifest({ revision: 0, products: [] });
      }
      setActivationCode("");
    }
  }

  async function renewLicense() {
    if (!runtime) return;
    const result = await runAction("renew", () =>
      backend.renew(runtime.activationApiUrl)
    );
    if (result) setLicense(result);
  }

  async function checkAppUpdate(silent = false) {
    setBusy("check-update");
    if (!silent) setUpdateMessage(null);
    try {
      const update = await check({ timeout: 15_000 });
      setAvailableUpdate(update);
      setUpdateMessage(
        update
          ? `发现新版本 ${update.version}`
          : silent
            ? null
            : "当前已经是最新版本"
      );
    } catch (reason) {
      setUpdateMessage(`检查更新失败：${messageOf(reason)}`);
      if (!silent) {
        setError(`检查更新失败：${messageOf(reason)}`);
      }
    } finally {
      setBusy(null);
    }
  }

  async function installAppUpdate() {
    if (!availableUpdate) return;
    setBusy("install-update");
    setError(null);
    let downloaded = 0;
    let total: number | undefined;
    try {
      await availableUpdate.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength;
          setUpdateProgress(total ? 0 : 10);
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          setUpdateProgress(
            total ? Math.min(99, Math.round((downloaded / total) * 100)) : 50
          );
        } else {
          setUpdateProgress(100);
        }
      });
      setUpdateMessage("更新安装完成，正在重启");
      await relaunch();
    } catch (reason) {
      setError(`安装更新失败：${messageOf(reason)}`);
      setUpdateProgress(null);
      setBusy(null);
    }
  }

  async function install(product: ProductInstallOption) {
    if (!runtime || !product.selected) return;
    setActiveProduct(product.productId);
    setProgress({ stage: "starting", percent: 0, message: "准备安装" });
    const result = await runAction(`install:${product.productId}`, () =>
      backend.install(runtime.manifestUrl, product.selected!.id)
    );
    if (result) {
      setProgress({ stage: "complete", percent: 100, message: result });
      await refreshProducts();
    }
  }

  async function openExternal(label: string, url: string) {
    const result = await runAction(`open:${label}`, async () => {
      await openUrl(url);
      return true;
    });
    if (result) {
      setUpdateMessage(`已在浏览器打开${label}`);
    }
  }

  function openCcSwitchDownload() {
    const target =
      system?.platform === "windows"
        ? ccSwitchRelease.downloads.windows
        : ccSwitchRelease.downloads.macos;
    void openExternal(`CC Switch ${ccSwitchRelease.version}`, target.url);
  }

  function configInput(): ConfigInput {
    return {
      projectDir,
      claudeMd,
      settings: parseJsonObject(settingsText, ".claude/settings.json"),
      mcp: parseJsonObject(mcpText, ".mcp.json")
    };
  }

  async function chooseProject() {
    const selected = await open({ directory: true, multiple: false });
    if (selected) setProjectDir(selected);
  }

  async function previewConfiguration() {
    const result = await runAction("preview", () =>
      backend.previewConfig(configInput())
    );
    if (result) setPreviews(result);
  }

  async function applyConfiguration() {
    const result = await runAction("apply-config", () =>
      backend.applyConfig(configInput())
    );
    if (result) setPreviews(result);
  }

  if (busy === "startup") {
    return (
      <main className="splash">
        <LoaderCircle className="spin" size={34} />
        <strong>正在检查本机环境</strong>
      </main>
    );
  }

  return (
    <main className="app-shell" ref={motionRootRef}>
      <div className="ambient-grid" aria-hidden="true" />
      <header className="hero motion-reveal">
        <div className="hero-copy">
          <div className="eyebrow">
            <WandSparkles size={15} /> AI DEPLOYMENT CONSOLE
          </div>
          <h1>AI 工具部署助手</h1>
          <p>一个正式版控制台，完成签名安装、环境诊断、模型接入和客户交付。</p>
          <div className="hero-trust">
            <span><ShieldCheck /> Ed25519 签名清单</span>
            <span><Activity /> 本地诊断</span>
            <span><KeyRound /> 激活码授权</span>
          </div>
        </div>
        <div className="hero-visual" aria-hidden="true">
          <div className="hero-orbit orbit-one" />
          <div className="hero-orbit orbit-two" />
          <div className="hero-core">
            <Code2 />
            <span>READY</span>
          </div>
          <div className="target-pill">
            <span>当前设备</span>
            <strong>{targetLabel}</strong>
          </div>
        </div>
      </header>

      {error && (
        <div className="alert error">
          <CircleAlert size={18} />
          <span>{error}</span>
          <button onClick={() => setError(null)}>关闭</button>
        </div>
      )}

      {isDevelopmentMode && (
        <div className="alert development">
          <Info size={18} />
          <div>
            <strong>当前是测试模式</strong>
            <span>
              Debug 版本无需兑换码，方便你调试。正式发布版会自动恢复激活验证。
            </span>
          </div>
        </div>
      )}

      {availableUpdate && (
        <div className="alert update">
          <Download size={18} />
          <div>
            <strong>助手新版本 {availableUpdate.version} 可用</strong>
            <span>
              {availableUpdate.body || "更新包已签名，安装完成后应用会自动重启。"}
            </span>
            {updateProgress !== null && (
              <span>下载与安装进度：{updateProgress}%</span>
            )}
          </div>
          <button
            className="primary"
            onClick={installAppUpdate}
            disabled={busy === "install-update"}
          >
            {busy === "install-update" ? (
              <LoaderCircle className="spin" />
            ) : (
              <HardDriveDownload />
            )}
            安装更新
          </button>
        </div>
      )}

      <section className="status-grid motion-reveal">
        <StatusCard
          icon={<KeyRound />}
          title="运行权限"
          value={
            isDevelopmentMode
              ? "测试模式"
              : license?.active
                ? license.daysRemaining !== undefined
                  ? `剩余 ${license.daysRemaining} 天`
                  : "已激活"
                : "尚未激活"
          }
          tone={license?.active ? "good" : "warn"}
        />
        <StatusCard
          icon={<PackageOpen />}
          title="已发布来源"
          value={`${publishedOfficialCount} / ${officialCatalog.length} 款`}
          tone={publishedOfficialCount ? "good" : "warn"}
        />
        <StatusCard
          icon={<HardDriveDownload />}
          title="已检测安装"
          value={`${installedCount} 款`}
          tone={installedCount ? "good" : "neutral"}
        />
      </section>

      {!license?.active ? (
        <section className="panel activation-panel motion-reveal" data-tilt>
          <div className="panel-title">
            <KeyRound />
            <div>
              <h2>输入兑换码</h2>
              <p>每个兑换码绑定一台设备，允许管理员重置一次。</p>
            </div>
          </div>
          <div className="inline-form">
            <input
              value={activationCode}
              onChange={(event) => setActivationCode(event.target.value)}
              placeholder="ADA-XXXXX-XXXXX-XXXXX-XXXXX"
              autoComplete="off"
            />
            <button
              className="primary"
              onClick={activate}
              disabled={busy === "activate" || !activationCode.trim()}
            >
              {busy === "activate" ? (
                <LoaderCircle className="spin" />
              ) : (
                <BadgeCheck />
              )}
              激活
            </button>
          </div>
          {license?.canRenew && (
            <div className="button-row">
              <button
                onClick={renewLicense}
                disabled={busy === "renew"}
              >
                {busy === "renew" ? (
                  <LoaderCircle className="spin" />
                ) : (
                  <RefreshCw />
                )}
                使用本机许可证联网续期
              </button>
            </div>
          )}
          <p className="privacy-note">
            激活仅发送兑换码、随机设备 ID、不可逆设备指纹和助手版本，不发送硬件原始标识、工具账号、项目内容或命令历史。
          </p>
        </section>
      ) : (
        <>
          {license.renewalRecommended && !isDevelopmentMode && (
            <div className="alert development">
              <RefreshCw size={18} />
              <div>
                <strong>许可证即将到期</strong>
                <span>
                  当前还可离线使用 {license.daysRemaining ?? 0} 天，建议现在联网续期。
                </span>
              </div>
              <button onClick={renewLicense} disabled={busy === "renew"}>
                立即续期
              </button>
            </div>
          )}
          <section className="system-recommendation motion-reveal">
            <ShieldCheck />
            <div>
              <strong>系统检测完成，已自动匹配安装版本</strong>
              <span>
                {system
                  ? `${friendlyPlatform(system.platform)} ${system.osVersion} / ${friendlyArchitecture(system.architecture)}`
                  : "正在读取系统信息"}
                。下方只会提供适配当前设备的已签名版本。
              </span>
            </div>
          </section>

          <section className="panel motion-reveal">
            <div className="panel-title">
              <Download />
              <div>
                <h2>选择要部署的工具</h2>
                <p>
                  安装来源由签名清单固定版本、大小和 SHA-256。完整离线包
                  不访问产品官网；官方安装脚本可能联网下载运行依赖。
                </p>
              </div>
            </div>

            {(manifest?.products.length ?? 0) === 0 && (
              <div className="publish-notice">
                <CircleAlert />
                <div>
                  <strong>安装包尚在准备中</strong>
                  <span>
                    当前系统还没有可用的签名安装来源。用户仍可查看产品详情和官网，但暂时不能一键安装。
                  </span>
                  {isDevelopmentMode && (
                    <code>npm run admin -- source publish-bundle --help</code>
                  )}
                </div>
              </div>
            )}

            <div className="product-grid">
              {displayProducts.map((product) => (
                <ProductCard
                  key={product.productId}
                  product={product}
                  busy={busy}
                  diagnostics={diagnostics[product.productId] ?? []}
                  onDetails={() => setDetailProduct(product)}
                  onInstall={() => install(product)}
                  onOfficial={() =>
                    void openExternal(`${product.productName} 官网`, product.homepageUrl)
                  }
                  onOrigin={() =>
                    product.selected &&
                    void openExternal(
                      `${product.productName} 来源页面`,
                      product.selected.originUrl
                    )
                  }
                  onDiagnostics={() => {
                    void runAction(`diagnostics:${product.productId}`, async () => {
                      const result = await backend.diagnostics(product.productId);
                      setDiagnostics((current) => ({
                        ...current,
                        [product.productId]: result
                      }));
                    });
                  }}
                  onTerminal={() =>
                    runtime &&
                    product.selected &&
                    runAction(`terminal:${product.productId}`, () =>
                      backend.openTerminal(
                        runtime.manifestUrl,
                        product.selected!.id
                      )
                    )
                  }
                  onUninstall={() => {
                    if (
                      !window.confirm(
                        `确认卸载由助手管理的 ${product.productName}？用户配置会保留。`
                      )
                    ) {
                      return;
                    }
                    void runAction(
                      `uninstall:${product.productId}`,
                      async () => {
                        setActiveProduct(product.productId);
                        setProgress({
                          stage: "uninstall",
                          percent: 10,
                          message: `正在卸载 ${product.productName}`
                        });
                        const result = await backend.uninstall(product.productId);
                        await refreshProducts();
                        setDiagnostics((current) => {
                          const next = { ...current };
                          delete next[product.productId];
                          return next;
                        });
                        setProgress({
                          stage: "uninstall",
                          percent: 100,
                          message: result
                        });
                      }
                    );
                  }}
                />
              ))}
            </div>

            <CompanionPanel
              system={system}
              onDownload={openCcSwitchDownload}
              onRelease={() =>
                void openExternal("CC Switch 发布页", ccSwitchRelease.releaseUrl)
              }
            />

            {progress && (
              <div className="progress-block">
                <div>
                  <span>
                    {activeProduct
                      ? `${productName(manifest, activeProduct)}：`
                      : ""}
                    {progress.message}
                  </span>
                  <strong>{progress.percent}%</strong>
                </div>
                <div className="progress-track">
                  <span style={{ width: `${progress.percent}%` }} />
                </div>
              </div>
            )}
          </section>

          <section className="panel motion-reveal">
            <div className="panel-title">
              <Settings2 />
              <div>
                <h2>工具初始化向导</h2>
                <p>每款工具有自己的配置方式，请先选择要初始化的工具。</p>
              </div>
            </div>
            <div className="setup-tabs" role="tablist" aria-label="选择初始化工具">
              {displayProducts
                .filter((product) =>
                  officialCatalog.some(
                    (catalog) => catalog.productId === product.productId
                  )
                )
                .map((product) => (
                  <button
                    key={product.productId}
                    role="tab"
                    aria-selected={setupProductId === product.productId}
                    className={
                      setupProductId === product.productId ? "active" : ""
                    }
                    onClick={() => {
                      setSetupProductId(product.productId);
                      setPreviews([]);
                    }}
                  >
                    <span>{product.productName.slice(0, 1)}</span>
                    {product.productName}
                  </button>
                ))}
            </div>

            {setupProductId === "claude-code" ? (
              <>
                <ModelConnectionGuide
                  productId="claude-code"
                  onCcSwitch={openCcSwitchDownload}
                />
                <div className="setup-explanation">
                  <strong>Claude Code 项目配置</strong>
                  <span>
                    为一个项目生成工作规则、权限设置和 MCP 配置；写入前可预览差异，并自动备份原文件。
                  </span>
                </div>
                <label className="field">
                  <span>项目目录</span>
                  <div className="path-picker">
                    <input
                      value={projectDir}
                      readOnly
                      placeholder="选择一个项目目录"
                    />
                    <button onClick={chooseProject}>
                      <FolderOpen /> 选择
                    </button>
                  </div>
                </label>
                <label className="field">
                  <span>Claude Code 工作规则</span>
                  <small>
                    这些内容会写入 CLAUDE.md，Claude Code
                    在这个项目中工作时会长期遵守。
                  </small>
                  <textarea
                    value={claudeMd}
                    onChange={(event) => setClaudeMd(event.target.value)}
                  />
                </label>
                <div className="editor-grid">
                  <label className="field">
                    <span>.claude/settings.json</span>
                    <textarea
                      className="code-editor"
                      value={settingsText}
                      onChange={(event) => setSettingsText(event.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>.mcp.json</span>
                    <textarea
                      className="code-editor"
                      value={mcpText}
                      onChange={(event) => setMcpText(event.target.value)}
                    />
                  </label>
                </div>
                <div className="button-row">
                  <button onClick={previewConfiguration} disabled={!projectDir}>
                    <Code2 /> 预览更改
                  </button>
                  <button
                    className="primary"
                    onClick={applyConfiguration}
                    disabled={!projectDir || previews.length === 0}
                  >
                    <CheckCircle2 /> 应用并备份
                  </button>
                </div>
                {previews.length > 0 && (
                  <div className="preview-list">
                    {previews.map((preview) => (
                      <details key={preview.path} open={preview.changed}>
                        <summary>
                          <span>{preview.path}</span>
                          <strong>{preview.changed ? "将修改" : "无变化"}</strong>
                        </summary>
                        <div className="diff-columns">
                          <pre>{preview.before || "（新文件）"}</pre>
                          <ChevronRight />
                          <pre>{preview.after}</pre>
                        </div>
                      </details>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <TerminalSetup
                product={
                  displayProducts.find(
                    (product) => product.productId === setupProductId
                  )!
                }
                busy={busy}
                onOfficial={() => {
                  const product = displayProducts.find(
                    (item) => item.productId === setupProductId
                  );
                  if (product) {
                    void openExternal(
                      `${product.productName} 官网`,
                      product.homepageUrl
                    );
                  }
                }}
                onDiagnostics={() => {
                  const product = displayProducts.find(
                    (item) => item.productId === setupProductId
                  );
                  if (!product) return;
                  void runAction(`diagnostics:${product.productId}`, async () => {
                    const result = await backend.diagnostics(product.productId);
                    setDiagnostics((current) => ({
                      ...current,
                      [product.productId]: result
                    }));
                  });
                }}
                onTerminal={() => {
                  const product = displayProducts.find(
                    (item) => item.productId === setupProductId
                  );
                  if (!runtime || !product?.selected) return;
                  void runAction(`terminal:${product.productId}`, () =>
                    backend.openTerminal(
                      runtime.manifestUrl,
                      product.selected!.id
                    )
                    );
                }}
                onCcSwitch={openCcSwitchDownload}
              />
            )}
          </section>

          <section className="panel compact-panel motion-reveal">
            <div className="panel-title">
              <BookOpen />
              <div>
                <h2>教程与备用下载</h2>
                <p>教程和备用包可以跳转到你配置的网站。</p>
              </div>
            </div>
            <div className="button-row">
              <button
                onClick={() =>
                  runtime && void openExternal("使用教程", runtime.tutorialUrl)
                }
              >
                <BookOpen /> 打开教程 <ExternalLink />
              </button>
              <button
                onClick={() =>
                  runtime &&
                  void openExternal("备用下载页面", runtime.backupDownloadUrl)
                }
              >
                <FolderOpen /> 备用下载 <ExternalLink />
              </button>
            </div>
          </section>
        </>
      )}

      <section className="panel compact-panel update-panel motion-reveal">
        <div className="panel-title">
          <RefreshCw />
          <div>
            <h2>助手更新</h2>
            <p>{updateMessage ?? "从签名更新源检查桌面助手的新版本。"}</p>
          </div>
        </div>
        <div className="button-row">
          <button
            onClick={() => checkAppUpdate(false)}
            disabled={busy === "check-update" || busy === "install-update"}
          >
            {busy === "check-update" ? (
              <LoaderCircle className="spin" />
            ) : (
              <RefreshCw />
            )}
            检查更新
          </button>
        </div>
      </section>

      <footer>
        本工具不是 Anthropic、OpenClaw 或 Nous Research 官方产品，不提供账号、密钥、代理或地区限制绕过。来源与再分发授权由发布者负责。
      </footer>

      {detailProduct && (
        <ProductDetailDialog
          product={detailProduct}
          busy={busy}
          onClose={() => setDetailProduct(null)}
          onOfficial={() =>
            void openExternal(
              `${detailProduct.productName} 官网`,
              detailProduct.homepageUrl
            )
          }
          onOrigin={() =>
            detailProduct.selected &&
            void openExternal(
              `${detailProduct.productName} 来源页面`,
              detailProduct.selected.originUrl
            )
          }
          onInstall={() => {
            setDetailProduct(null);
            void install(detailProduct);
          }}
        />
      )}
    </main>
  );
}

function ProductCard({
  product,
  busy,
  diagnostics,
  onDetails,
  onInstall,
  onOfficial,
  onOrigin,
  onDiagnostics,
  onTerminal,
  onUninstall
}: {
  product: ProductInstallOption;
  busy: string | null;
  diagnostics: DiagnosticResult[];
  onDetails: () => void;
  onInstall: () => void;
  onOfficial: () => void;
  onOrigin: () => void;
  onDiagnostics: () => void;
  onTerminal: () => void;
  onUninstall: () => void;
}) {
  const isInstalling = busy === `install:${product.productId}`;
  const isUninstalling = busy === `uninstall:${product.productId}`;
  return (
    <article className="product-card" data-tilt>
      <div className="product-heading">
        <div className="product-mark">
          {product.productName.slice(0, 1).toUpperCase()}
        </div>
        <div>
          <h3>{product.productName}</h3>
          <p>{product.productDescription}</p>
        </div>
      </div>
      <div className="product-meta">
        {product.selected ? (
          <>
            <span className="recommended-label">推荐版本</span>
            <span>{formatInstallType(product.selected.installType)}</span>
            <span>{product.selected.version}</span>
            <span>{formatBytes(product.selected.size)}</span>
          </>
        ) : (
          <span className="unpublished-label">当前系统暂无安装包</span>
        )}
      </div>
      <div className={`install-state ${product.installedVersion ? "ready" : ""}`}>
        {product.installedVersion ? (
          <>
            <CheckCircle2 />
            <div>
              <strong>已检测到安装</strong>
              <span>{product.installedVersion}</span>
            </div>
          </>
        ) : (
          <>
            <CircleAlert />
            <div>
              <strong>尚未检测到</strong>
              <span>
                {product.selected
                  ? (product.recommendationReason ??
                    "已按当前系统和架构匹配安装包")
                  : "暂未提供一键安装，可先查看详情"}
              </span>
            </div>
          </>
        )}
      </div>
      <button
        className="primary product-install"
        onClick={onInstall}
        disabled={Boolean(busy) || !product.selected}
      >
        {isInstalling ? <LoaderCircle className="spin" /> : <Download />}
        {!product.selected
          ? "暂未开放安装"
          : product.installedVersion
            ? "重新安装 / 修复"
            : "开始安装"}
      </button>
      <div className="product-actions">
        <button className="product-details" onClick={onDetails}>
          <Info /> 查看详情
        </button>
        <button onClick={onOfficial}>
          <ExternalLink /> 官网
        </button>
        <button
          onClick={product.selected ? onOrigin : onDetails}
          className={!product.selected ? "explain-disabled" : undefined}
        >
          <ExternalLink /> 来源页面
        </button>
        <button
          onClick={onDiagnostics}
          disabled={Boolean(busy)}
        >
          <Activity /> 诊断
        </button>
        <button
          onClick={product.selected ? onTerminal : onDetails}
          disabled={Boolean(busy)}
          className={!product.selected ? "explain-disabled" : undefined}
        >
          <Terminal /> 打开终端
        </button>
        <button
          className="danger-text product-uninstall"
          onClick={onUninstall}
          disabled={Boolean(busy)}
        >
          {isUninstalling ? <LoaderCircle className="spin" /> : <Trash2 />}
          {isUninstalling ? "正在卸载" : "卸载"}
        </button>
      </div>
      {diagnostics.length > 0 && (
        <div className="diagnostics">
          {diagnostics.map((item) => (
            <div className={`diagnostic ${item.status}`} key={item.name}>
              {item.status === "ok" ? <CheckCircle2 /> : <CircleAlert />}
              <div>
                <strong>{item.name}</strong>
                <span>{item.summary}</span>
                {item.details && <pre>{item.details}</pre>}
              </div>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

function TerminalSetup({
  product,
  busy,
  onOfficial,
  onDiagnostics,
  onTerminal,
  onCcSwitch
}: {
  product: ProductInstallOption;
  busy: string | null;
  onOfficial: () => void;
  onDiagnostics: () => void;
  onTerminal: () => void;
  onCcSwitch: () => void;
}) {
  const isOpenClaw = product.productId === "openclaw";
  const command = isOpenClaw ? "openclaw onboard" : "hermes setup";
  const prerequisites = isOpenClaw
    ? ["Node 24 与 OpenClaw 运行依赖", "模型服务或消息平台账号", "可用的终端环境"]
    : ["Python、Node、ripgrep 与 ffmpeg", "Hermes 虚拟环境", "合法可用的模型服务配置"];
  return (
    <div className="terminal-setup">
      <ModelConnectionGuide
        productId={product.productId}
        onCcSwitch={onCcSwitch}
      />
      <div className="setup-explanation">
        <strong>{product.productName} 初始化</strong>
        <span>
          {isOpenClaw
            ? "安装完成后运行官方 onboard 向导，配置模型服务、消息平台和个人助手信息。"
            : "安装完成后运行 setup 向导，检查运行依赖并配置模型服务。"}
        </span>
      </div>
      <div className="setup-command">
        <span>初始化命令</span>
        <code>{command}</code>
      </div>
      <div className="setup-checklist">
        <strong>开始前确认</strong>
        {prerequisites.map((item) => (
          <div key={item}>
            <CheckCircle2 />
            <span>{item}</span>
          </div>
        ))}
      </div>
      <div
        className={`install-state ${
          product.installedVersion ? "ready" : ""
        }`}
      >
        {product.installedVersion ? <CheckCircle2 /> : <CircleAlert />}
        <div>
          <strong>
            {product.installedVersion ? "工具已安装" : "尚未检测到安装"}
          </strong>
          <span>
            {product.installedVersion ??
              (product.selected
                ? "请先完成安装，再运行初始化向导"
                : "管理员发布适配当前系统的安装包后才能继续")}
          </span>
        </div>
      </div>
      <div className="button-row">
        <button onClick={onOfficial}>
          <ExternalLink /> 查看官方文档
        </button>
        <button
          onClick={onDiagnostics}
          disabled={busy === `diagnostics:${product.productId}`}
        >
          <Activity /> 检查运行环境
        </button>
        <button
          className="primary"
          onClick={onTerminal}
          disabled={
            !product.selected ||
            !product.installedVersion ||
            busy === `terminal:${product.productId}`
          }
        >
          <Terminal /> 打开初始化终端
        </button>
      </div>
      <p className="privacy-note">
        初始化在系统终端中由用户操作，部署助手不会读取模型密钥、OAuth
        Token 或账号信息。
      </p>
    </div>
  );
}

function CompanionPanel({
  system,
  onDownload,
  onRelease
}: {
  system: SystemInfo | null;
  onDownload: () => void;
  onRelease: () => void;
}) {
  const target =
    system?.platform === "windows"
      ? ccSwitchRelease.downloads.windows
      : ccSwitchRelease.downloads.macos;
  return (
    <section className="companion-panel" data-tilt>
      <div className="companion-brand">
        <div className="companion-logo">CC</div>
        <div>
          <span className="section-kicker">三款工具共用配套</span>
          <h3>CC Switch {ccSwitchRelease.version}</h3>
          <p>
            同一个可视化工具管理 Claude Code、OpenClaw 和 Hermes
            的模型供应商、API 地址与密钥切换。
          </p>
        </div>
      </div>
      <div className="companion-actions">
        <span>官方文件 SHA-256</span>
        <code title={target.sha256}>{target.sha256.slice(0, 18)}...</code>
        <div>
          <button onClick={onRelease}>
            <ExternalLink /> 查看开源项目
          </button>
          <button className="primary" onClick={onDownload}>
            <Download /> {target.label}
          </button>
        </div>
      </div>
    </section>
  );
}

function ModelConnectionGuide({
  productId,
  onCcSwitch
}: {
  productId: string;
  onCcSwitch: () => void;
}) {
  const guide = modelConnectionGuide(productId);
  return (
    <section className="model-guide">
      <div className="model-guide-heading">
        <div>
          <span className="section-kicker">零基础模型接入</span>
          <h3>{guide.title}</h3>
          <p>{guide.summary}</p>
        </div>
        <button onClick={onCcSwitch}>
          <Download /> 下载 CC Switch
        </button>
      </div>
      <div className="guide-steps">
        {guide.steps.map((step, index) => (
          <article key={step.title}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <div>
              <strong>{step.title}</strong>
              <p>{step.description}</p>
              {step.command && <code>{step.command}</code>}
            </div>
          </article>
        ))}
      </div>
      <div className="guide-note">
        <ShieldCheck />
        <span>
          API Key 只在 CC Switch 或官方终端向导中填写。部署助手不读取、不保存，也不会上传密钥。
        </span>
      </div>
    </section>
  );
}

function ProductDetailDialog({
  product,
  busy,
  onClose,
  onOfficial,
  onOrigin,
  onInstall
}: {
  product: ProductInstallOption;
  busy: string | null;
  onClose: () => void;
  onOfficial: () => void;
  onOrigin: () => void;
  onInstall: () => void;
}) {
  const guidance = productGuidance(product.productId);
  const isInstalling = busy === `install:${product.productId}`;
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="product-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="product-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div className="product-mark">
            {product.productName.slice(0, 1).toUpperCase()}
          </div>
          <div>
            <span className="dialog-kicker">产品详情</span>
            <h2 id="product-dialog-title">{product.productName}</h2>
            <p>{product.productDescription}</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭详情">
            <X />
          </button>
        </header>

        <div className="detail-callout">
          <strong>{product.selected ? "当前可以安装" : "当前暂未提供安装包"}</strong>
          <span>
            {product.selected
              ? `推荐 ${product.selected.version}：${product.recommendationReason ?? "适配当前系统和架构"}。安装助手会从服务器下载并校验文件。`
              : "管理员发布适配当前系统的签名离线包后，这里会自动出现安装按钮。"}
          </span>
        </div>

        <dl className="detail-list">
          <div>
            <dt>主要用途</dt>
            <dd>{guidance.purpose}</dd>
          </div>
          <div>
            <dt>安装后怎么做</dt>
            <dd>{guidance.afterInstall}</dd>
          </div>
          <div>
            <dt>当前安装状态</dt>
            <dd>
              {product.installedVersion
                ? `已检测到：${product.installedVersion}`
                : "尚未检测到安装"}
            </dd>
          </div>
          <div>
            <dt>安装来源</dt>
            <dd>
              {product.selected
                ? `${formatInstallType(product.selected.installType)}，推荐版本 ${product.selected.version}，${formatBytes(product.selected.size)}`
                : "当前系统没有已发布的签名来源"}
            </dd>
          </div>
        </dl>

        <div className="detail-warning">
          <CircleAlert />
          <span>{guidance.notice}</span>
        </div>

        <div className="dialog-actions">
          <button onClick={onOfficial}>
            <ExternalLink /> 查看官网
          </button>
          <button onClick={onOrigin} disabled={!product.selected}>
            <ExternalLink /> 查看来源说明
          </button>
          <button
            className="primary"
            onClick={onInstall}
            disabled={!product.selected || Boolean(busy)}
          >
            {isInstalling ? <LoaderCircle className="spin" /> : <Download />}
            {product.selected ? "安装这个工具" : "暂未开放安装"}
          </button>
        </div>
      </section>
    </div>
  );
}

function StatusCard({
  icon,
  title,
  value,
  tone
}: {
  icon: React.ReactNode;
  title: string;
  value: string;
  tone: "good" | "warn" | "neutral";
}) {
  return (
    <article className={`status-card ${tone}`}>
      <div>{icon}</div>
      <span>{title}</span>
      <strong>{value}</strong>
    </article>
  );
}

function productName(
  manifest: ManifestSummary | null,
  productId: string
): string {
  return (
    manifest?.products.find((product) => product.productId === productId)
      ?.productName ?? productId
  );
}

function messageOf(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  return JSON.stringify(reason);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatInstallType(value: string): string {
  return {
    standalone_binary: "独立可执行文件",
    native_installer: "系统安装包",
    script: "官网安装脚本",
    archive_bundle: "国内离线包"
  }[value] ?? value;
}

function friendlyPlatform(value: SystemInfo["platform"]): string {
  return {
    windows: "Windows",
    macos: "macOS",
    linux: "Linux",
    unsupported: "不支持的系统"
  }[value];
}

function friendlyArchitecture(value: SystemInfo["architecture"]): string {
  return {
    x86_64: "x64",
    aarch64: "ARM64",
    unsupported: "不支持的架构"
  }[value];
}

function productGuidance(productId: string): {
  purpose: string;
  afterInstall: string;
  notice: string;
} {
  const guidance = {
    "claude-code": {
      purpose: "在终端中阅读、修改和运行代码，帮助完成软件开发任务。",
      afterInstall: "打开终端运行 claude，并按照 Anthropic 官方提示完成登录。",
      notice:
        "本助手只负责下载安装，不提供账号、代理或地区限制绕过；登录与服务可用性以 Anthropic 官方政策为准。"
    },
    openclaw: {
      purpose: "部署开源个人 AI 助手，并连接它支持的消息和自动化能力。",
      afterInstall: "打开终端运行 openclaw onboard，按照向导完成初始化。",
      notice:
        "离线包可以解决安装依赖下载问题，但你配置的模型服务和消息平台仍可能需要网络连接。"
    },
    "hermes-agent": {
      purpose: "运行 Nous Research 的开源智能体工具和相关自动化能力。",
      afterInstall: "打开终端运行 hermes setup，按照提示完成模型和运行环境配置。",
      notice:
        "安装包可以包含 Python、Node、ffmpeg 等运行依赖，但模型服务本身仍需由用户合法配置。"
    }
  } as const;
  return (
    guidance[productId as keyof typeof guidance] ?? {
      purpose: "通过签名安装源部署这个终端工具。",
      afterInstall: "安装完成后按照产品官网文档进行初始化。",
      notice: "请确认安装资源来源合法，并遵守产品官方服务条款。"
    }
  );
}

function modelConnectionGuide(productId: string): {
  title: string;
  summary: string;
  steps: ReadonlyArray<{
    title: string;
    description: string;
    command?: string;
  }>;
} {
  const guides = {
    "claude-code": {
      title: "Claude Code 接入大模型",
      summary:
        "推荐用 CC Switch 可视化管理供应商；使用 Anthropic 官方账号时，也可以直接在终端登录。",
      steps: [
        {
          title: "先安装 Claude Code",
          description: "在上方完成安装并运行一次诊断，确认 claude 命令可用。",
          command: "claude --version"
        },
        {
          title: "打开 CC Switch",
          description: "选择 Claude Code 标签，点击新增供应商。"
        },
        {
          title: "填写三项信息",
          description: "粘贴供应商给你的 API Base URL、API Key，并选择模型。"
        },
        {
          title: "启用后开始使用",
          description: "点击启用供应商，再打开终端进入项目目录。",
          command: "claude"
        }
      ]
    },
    openclaw: {
      title: "OpenClaw 接入大模型",
      summary:
        "OpenClaw 自带 onboard 向导；CC Switch 也支持 OpenClaw，适合以后频繁切换模型服务。",
      steps: [
        {
          title: "确认安装完成",
          description: "先运行本页的环境检查，确保 openclaw 命令存在。",
          command: "openclaw --version"
        },
        {
          title: "首次运行官方向导",
          description: "在终端选择模型提供商，并按提示填写 API Key。",
          command: "openclaw onboard"
        },
        {
          title: "需要切换时用 CC Switch",
          description: "进入 OpenClaw 标签，新增供应商并启用对应模型。"
        },
        {
          title: "重启 OpenClaw 会话",
          description: "配置切换后重新启动相关终端或服务，使新模型生效。"
        }
      ]
    },
    "hermes-agent": {
      title: "Hermes Agent 接入大模型",
      summary:
        "Hermes 自带 setup/model 向导；CC Switch 已支持 Hermes，可统一管理供应商和模型。",
      steps: [
        {
          title: "检查 Hermes 环境",
          description: "确认 hermes 命令和运行依赖已经安装。",
          command: "hermes --version"
        },
        {
          title: "运行首次设置",
          description: "跟随官方设置向导选择模型供应商并填写凭据。",
          command: "hermes setup"
        },
        {
          title: "用 CC Switch 管理多供应商",
          description: "进入 Hermes 标签添加 API 地址、密钥和默认模型。"
        },
        {
          title: "启动新会话验证",
          description: "关闭旧会话后重新运行 Hermes，发送简单问题确认模型可用。",
          command: "hermes"
        }
      ]
    }
  } as const;
  return (
    guides[productId as keyof typeof guides] ?? {
      title: "接入大模型",
      summary: "按照工具官方文档填写合法获得的模型服务配置。",
      steps: []
    }
  );
}
