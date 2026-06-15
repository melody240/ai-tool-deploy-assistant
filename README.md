# AI 工具部署助手

一个非官方的 Windows、macOS、Linux 图形部署助手。首批内置产品目录包括：

- [Claude Code](https://code.claude.com/docs/en/setup)
- [OpenClaw](https://docs.openclaw.ai/install)
- [Hermes Agent](https://hermes-agent.nousresearch.com/docs/)

程序不内置这些工具本体。国内交付优先由发布者通过管理 CLI 上传自己确认有权使用的完整离线包。客户端只执行经过 Ed25519 清单签名、文件大小和 SHA-256 校验的资源。

## 工程组成

- `apps/desktop`：Tauri 2 + React 桌面端。
- `tools/admin-cli`：同步官网来源、发布自定义安装包、签署清单和管理兑换码。
- `services/api`：Fastify + PostgreSQL 激活服务。
- `packages/shared`：安装清单、许可证和 API 共享协议。

支持四种安装类型：

- `standalone_binary`：复制独立可执行文件到用户目录并配置 PATH。
- `native_installer`：Windows EXE/MSI、macOS PKG、Linux DEB/RPM。
- `script`：使用清单指定的 PowerShell、CMD、Bash 或 SH 执行。
- `archive_bundle`：解压完整 ZIP/TAR.GZ 离线包，保留随包 Node、Python 和其他依赖。

## 本地开发

要求 Node.js 22+、Rust 1.96+ 和对应平台的 Tauri 系统依赖。

```bash
npm install
npm run typecheck
npm test
npm run build

cd apps/desktop/src-tauri
cargo test
cargo clippy --all-targets -- -D warnings
```

启动浏览器预览：

```bash
npm run dev:desktop
```

浏览器模式使用三款工具的模拟数据。真实系统安装能力只在 Tauri 窗口中启用。

开发时运行的 Debug 构建会明确显示“测试模式”，无需兑换码即可测试安装流程；这个放行逻辑由 Rust 的 `debug_assertions` 控制。正式 Release 构建不会包含测试放行，仍然必须使用有效兑换码。

## 首次生产配置

### 1. 生成生产配置与签名密钥

```bash
npm run configure:production -- --domain license.example.com
```

该命令会生成或保留许可证、清单签名密钥，生成数据库密码、管理员
Token 和兑换码 HMAC Secret，把公钥同步到桌面端，并把激活地址改成真实
HTTPS 域名。配置文件与私钥权限会设为 `0600`。

私钥不得进入 Git、桌面安装包或对象存储。把公钥写入客户端：

```bash
cp .secrets/manifest-public.raw.b64 \
  apps/desktop/src-tauri/resources/manifest-public-key.b64
cp .secrets/license-public.raw.b64 \
  apps/desktop/src-tauri/resources/license-public-key.b64
```

独立的 Tauri updater 私钥位于 `.secrets/updater-private.key`，只用于桌面
安装包签名，不能与许可证或来源清单密钥复用。

### 2. 配置阿里云 OSS

从模板创建管理 CLI 配置：

```bash
cp tools/admin-cli/.env.example tools/admin-cli/.env
```

填写杭州 OSS：

```dotenv
STORAGE_ENDPOINT=https://s3.oss-cn-hangzhou.aliyuncs.com
STORAGE_REGION=cn-hangzhou
STORAGE_BUCKET=你的Bucket名称
STORAGE_ACCESS_KEY_ID=你的RAM用户AccessKey
STORAGE_SECRET_ACCESS_KEY=你的RAM用户Secret
STORAGE_PUBLIC_BASE_URL=https://你的Bucket名称.oss-cn-hangzhou.aliyuncs.com
STORAGE_FORCE_PATH_STYLE=true
STORAGE_MANIFEST_KEY=manifests/source-manifest.json
STORAGE_UPDATER_KEY=updates/latest.json
```

RAM 用户只授予该 Bucket 的上传和覆盖权限，不要使用阿里云主账号 AccessKey。

管理 CLI 可使用任意 S3 兼容对象存储和 CDN。生产检查：

```bash
node scripts/release-check.mjs
```

### 3. 启动激活服务

```bash
scripts/deploy-production.sh license.example.com
```

Compose 会同时启动 PostgreSQL、API 和 Caddy。API 只绑定服务器的
`127.0.0.1:8080`，公网反向代理只开放：

```text
/live
/health
/v1/activate
/v1/renew
```

客户端的 `activationApiUrl` 必须改为该域名的 HTTPS 地址。正式客户端会
拒绝公网 HTTP。

公网 API 不持有清单签名私钥和 OSS 写凭据。离线包继续通过本机管理 CLI
发布。管理兑换码前建立 SSH 隧道：

```bash
ssh -N -L 8080:127.0.0.1:8080 user@你的服务器
```

然后把 `tools/admin-cli/.env` 的 `ADMIN_API_URL` 设为
`http://127.0.0.1:8080`。如需网页管理后台，也只在建立隧道后打开
`http://127.0.0.1:8080/admin`。

完整兑换码只会在生成时显示一次；数据库长期保存不可逆 HMAC 哈希。
许可证绑定不可逆机器指纹，默认租约为 30 天。桌面端会在最后 7 天自动
使用本机已签名许可证续期，不需要再次输入兑换码。停用兑换码后无法继续
续期，现有许可证在租约到期时失效。

升级到许可证协议 v2 后，旧版永久许可证需要重新激活一次。

### 已有服务器升级

使用 `scripts/deploy-production.sh license.example.com --force` 轮换数据库
密码、`ADMIN_TOKEN` 和 `CODE_HMAC_SECRET`。脚本会先用旧环境启动
PostgreSQL，在数据库内修改角色密码，再切换到新环境，避免已有数据卷失联。
OSS RAM AccessKey 需要在云控制台单独轮换。

部署新版本后确认：

```bash
curl https://你的API域名/health
curl -I http://服务器公网IP:8080/health # 应连接失败
npm run release:check
```

已对外发出的旧兑换码如曾保存在明文文件或经 HTTP 传输，应停用并重新生成。

数据库备份与恢复：

```bash
scripts/backup-database.sh
scripts/restore-database.sh .data/backups/installer-TIMESTAMP.dump
```

### Windows Server / 阿里云 ECS

Windows 单机正式部署使用 Node.js 自带 SQLite，不需要安装 Docker 或
PostgreSQL。生产环境会拒绝内存存储、短管理员 Token 和永久管理员激活码。

在开发机生成只包含编译产物的服务器包：

```bash
npm run package:windows-server
```

将 `.data/releases/ai-tool-server-1.0.0-windows.zip` 上传到服务器后，在
管理员 PowerShell 中执行：

```powershell
.\install-windows-release.ps1 `
  -PackagePath C:\Temp\ai-tool-server-1.0.0-windows.zip `
  -ExpectedSha256 <打包命令显示的SHA256>
```

脚本会：

- 停止并重建 `AIToolAPI` 计划任务；
- 备份旧版本到 `C:\ai-tool-installer-backups`；
- 保留现有许可证私钥并校验它与正式客户端公钥一致；
- 把 API 绑定到 `127.0.0.1:8080`；
- 使用 `C:\ai-tool-installer\.data\license.sqlite3` 持久化兑换码；
- 首次部署生成管理员 Token 和兑换码 HMAC Secret，后续升级保留它们；
- 停服后把 SQLite 数据库副本写入本次版本备份目录；
- 删除永久管理员激活码，健康检查失败时自动回滚。

管理员凭据保存在
`C:\ai-tool-installer\.secrets\admin-token.txt`，仅 `SYSTEM` 和本机管理员
可读。

公网前置 HTTPS 可运行包内的 `install-caddy-windows.ps1`。阿里云安全组只
开放 TCP 80/443，正式验证完成后删除公网 TCP 8080 规则。管理后台不要暴露
到公网。

`C:\ai-tool-installer-backups` 是升级前的本机恢复点，不等于异地灾备。
正式运营仍需定期把 SQLite 数据库、`CODE_HMAC_SECRET` 和许可证私钥加密
备份到另一台设备或受控存储；缺少其中任意一项都会影响旧兑换码或许可证续期。

## 准备完整离线包

买家的安装过程不会访问产品官网。离线包必须包含工具运行所需的全部文件，不能只放一个仍会连接 npm、PyPI 或 GitHub 的安装脚本。

推荐目录结构：

```text
# Windows ZIP
bin/
  claude.exe
runtime/
  ...

# macOS TAR.GZ
bin/
  claude
runtime/
  ...
```

`--executable-path` 指向归档内真正的启动文件，例如 `bin/claude`。入口脚本如果引用随包运行时，应根据自身真实路径定位 `runtime/`。

可选的 `--min-os-version` 会写入签名清单。客户端激活成功后会重新读取本机系统版本，只推荐满足系统、架构和最低版本要求的来源。例如：

```bash
--min-os-version 13.0          # macOS 13 或更高
--min-os-version 10.0.17763    # Windows 10 1809 或更高的内核版本
```

发布前必须在对应系统上解压测试：

- Claude Code：确认原生文件来源和再分发许可。
- OpenClaw：包含 Node 24、OpenClaw 包及完整 npm 依赖。
- Hermes Agent：包含所需 Python/Node、虚拟环境、ripgrep、ffmpeg 和 Hermes 文件。

## 发布六个国内离线来源

首版目标是 Windows x64 和 Mac ARM。假设文件放在 `offline-bundles/`。

Claude Code：

```bash
npm run admin -- source publish-bundle \
  --product claude-code \
  --file ./offline-bundles/claude-code-windows-x64.zip \
  --platform windows \
  --arch x86_64 \
  --version 2.1.0 \
  --executable-path bin/claude.exe \
  --origin-url https://code.claude.com/docs/en/setup

npm run admin -- source publish-bundle \
  --product claude-code \
  --file ./offline-bundles/claude-code-macos-arm64.tar.gz \
  --platform macos \
  --arch aarch64 \
  --version 2.1.0 \
  --executable-path bin/claude \
  --origin-url https://code.claude.com/docs/en/setup
```

OpenClaw：

```bash
npm run admin -- source publish-bundle \
  --product openclaw \
  --file ./offline-bundles/openclaw-windows-x64.zip \
  --platform windows \
  --arch x86_64 \
  --version 1.8.2 \
  --executable-path bin/openclaw.cmd \
  --origin-url https://docs.openclaw.ai/install

npm run admin -- source publish-bundle \
  --product openclaw \
  --file ./offline-bundles/openclaw-macos-arm64.tar.gz \
  --platform macos \
  --arch aarch64 \
  --version 1.8.2 \
  --executable-path bin/openclaw \
  --origin-url https://docs.openclaw.ai/install
```

Hermes Agent：

```bash
npm run admin -- source publish-bundle \
  --product hermes-agent \
  --file ./offline-bundles/hermes-agent-windows-x64.zip \
  --platform windows \
  --arch x86_64 \
  --version 2026.06.10 \
  --executable-path bin/hermes.cmd \
  --origin-url https://hermes-agent.nousresearch.com/docs/getting-started/installation

npm run admin -- source publish-bundle \
  --product hermes-agent \
  --file ./offline-bundles/hermes-agent-macos-arm64.tar.gz \
  --platform macos \
  --arch aarch64 \
  --version 2026.06.10 \
  --executable-path bin/hermes \
  --origin-url https://hermes-agent.nousresearch.com/docs/getting-started/installation
```

每次命令都会上传归档、计算 SHA-256、更新 Ed25519 签名清单并上传清单到 OSS。发布后检查：

```bash
npm run admin -- source list
```

客户端完整流程是：

1. 用户输入兑换码，服务端签发绑定当前设备的许可证。
2. 客户端重新检测操作系统、系统版本和 CPU 架构。
3. 客户端下载并验证签名清单，只展示适配当前设备的推荐版本。
4. 用户点击一键安装，客户端从清单中的服务器地址下载文件。
5. 文件大小和 SHA-256 校验通过后才会解压或执行安装。

当前签名清单已经把 Claude Code 2.1.172 的 Windows x64 与 macOS ARM64
完整离线 CLI 镜像到杭州 OSS。现有 OpenClaw 伴侣 GUI、仅含 npm 源码的
tarball，以及仅含 Hermes 本体的 wheel 都不是完整离线 CLI 包，不能直接
发布；必须先补齐对应平台的 Node/Python 运行时和全部依赖。未准备好的产品
会在客户端明确显示为不可安装。

`source sync-official` 只镜像官网入口脚本，不保证脚本后续依赖可在国内访问，因此不作为国内离线交付方式。

管理来源：

```bash
npm run admin -- source list
npm run admin -- source disable SOURCE_ID
npm run admin -- source rollback REVISION
```

## 管理兑换码

```bash
npm run admin -- codes create --count 20
npm run admin -- codes create --count 20 --batch ORDER-2026-06 --label 客户名称 --max-resets 2 --expires-at 2027-01-01T00:00:00Z
npm run admin -- codes list
npm run admin -- codes stats
npm run admin -- codes audit
npm run admin -- codes reset CODE_OR_ID
npm run admin -- codes disable CODE_OR_ID
npm run admin -- codes enable CODE_OR_ID
```

兑换码使用 `ADA-` 前缀。每个兑换码绑定随机设备 UUID 和不可逆机器指纹，
可按订单批次设置标签、兑换/续期截止时间和 0-20 次设备重置。生产模式禁止
配置可重复使用的管理员永久激活码。管理网页只通过 SSH 隧道访问。

## 桌面端打包

正式包会同时生成 Tauri updater 产物和 `.sig`：

```bash
npm run package:desktop
```

在对应平台构建后发布更新，可重复传入多个目标：

```bash
npm run admin -- desktop publish-update \
  --version 1.0.1 \
  --notes-file release-notes.md \
  --artifact darwin-aarch64=apps/desktop/src-tauri/target/release/bundle/macos/AI工具部署助手.app.tar.gz \
  --artifact windows-x86_64=path/to/AI工具部署助手_1.0.1_x64-setup.nsis.zip
```

每个产物旁必须存在 Tauri 生成的同名 `.sig`。命令会上传产物并刷新
`updates/latest.json`。桌面端启动时静默检查更新，也允许用户手动检查、
查看进度、验签安装并自动重启。

Windows Authenticode 和 macOS Developer ID/notarization 仍应在公开分发前
配置，否则系统会显示 SmartScreen 或 Gatekeeper 警告；Tauri updater
签名、来源清单签名和安装包哈希不能关闭。

## 安全边界

- 客户端不接受买家临时输入任意下载 URL。
- 清单和许可证都在 Rust 后端验签。
- 安装前验证 HTTPS、文件大小和 SHA-256，失败文件会被删除。
- 安装参数、诊断参数和终端初始化参数均来自签名清单。
- 不读取或上传 OAuth Token、API Key、项目内容、命令历史或诊断日志。
- Claude 配置向导拒绝真实密钥和 `bypassPermissions`。
- 百度网盘只作为教程或备用包入口，不参与自动安装。
- 发布者负责确认安装包来源、再分发权和各产品的地区及服务条款。
