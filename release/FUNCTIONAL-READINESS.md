# Functional Readiness

Audit date: 2026-06-12

## Production status

- Customer activation, renewal, device binding, reset limits, disable/enable,
  administration, and audit logging are deployed over HTTPS.
- The Windows server upgrade package is deployed on Alibaba Cloud and preserves
  the database and production secrets.
- The macOS ARM64 desktop application is built as version 1.0.0, installed, and
  activated in customer mode.
- The source manifest, installer files, updater manifest, and updater artifact
  are publicly available from OSS and protected by signatures and SHA-256.
- `/health`, `/live`, `/tutorial`, `/downloads`, the administration page, and
  the Tauri activation CORS preflight are working.
- The desktop updater was exercised against OSS and reports version 1.0.0 as
  current.
- Public access to port 8080 times out; the application is reached through the
  HTTPS reverse proxy.

## Remaining distribution blockers

- The macOS application is ad-hoc signed. Public customer distribution still
  needs an Apple Developer ID certificate and notarization to avoid Gatekeeper
  warnings.
- Windows desktop packages still need Authenticode signing to avoid SmartScreen
  warnings.
- The updater currently publishes only `darwin-aarch64`. Each supported Windows
  or additional macOS target needs its own signed updater artifact.
- A备案 custom production domain should replace the temporary `sslip.io` host
  before commercial public launch.

## Product coverage gaps

- Claude Code 2.1.172 has a complete offline bundle for Windows x64 and macOS
  ARM64. Other CPU and operating-system targets are not published.
- OpenClaw and Hermes Agent use signed official installation scripts on macOS;
  they are not complete offline packages and still depend on upstream network
  availability.
- Linux, Intel Mac, Windows ARM, and complete offline OpenClaw/Hermes packages
  are not available.
- OpenClaw and Hermes Agent installation has not been exercised end to end on a
  clean customer machine.

## Operational gaps

- The Windows release is an upgrade package, not a fully independent fresh
  server bootstrap installer.
- The SQLite database has upgrade-time backups but no scheduled encrypted
  off-host backup and restore drill.
- The administration page cannot edit an existing code's label, expiry, or
  reset limit, and code/audit export is not implemented.
- A redundant Alibaba Cloud security-group rule for port 8080 should be removed
  even though the service is not externally reachable on that port.
- Frontend tests cover parsing and backend tests cover the API, but there is no
  automated desktop end-to-end test suite or cloud deployment CI.

## Verification

- Node tests: 34 passed across desktop, shared, API, and admin CLI.
- Rust tests: 16 passed.
- Type checking passes for every workspace.
- Release configuration and signed source-manifest checks pass.
- The updater manifest and macOS ARM64 artifact return HTTP 200 from OSS.
- The administration CLI authenticates through the production HTTPS endpoint.
