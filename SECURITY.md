# Security Policy

## Secrets

Never commit manifest signing keys, license signing keys, administrator tokens, database credentials, updater private keys, or Claude credentials.

Production releases must pass:

```bash
node scripts/release-check.mjs
```

The public API must listen only behind an HTTPS reverse proxy. Bind Docker to
`127.0.0.1`, expose only `/health` and `/v1/activate`, and access administrator
routes through an SSH tunnel or private VPN. Public routes are limited to
`/live`, `/health`, `/v1/activate`, and `/v1/renew`.

The public API must not receive the manifest signing private key or object
storage write credentials. Publish installer sources from the local
administrator CLI.

## Installer Trust

The desktop application accepts only HTTPS resources referenced by a valid Ed25519-signed manifest. It verifies the declared byte length and SHA-256 digest before execution.

Changing a package requires publishing a new signed manifest through the administrator CLI. Do not distribute a build with the repository's development public keys.

Desktop updates use a separate minisign key. The updater private key must stay
in `.secrets`; only the public key is embedded in `tauri.conf.json`. Publish
`latest.json` and updater artifacts through `desktop publish-update`.

## Privacy

Activation transmits only the redemption code, a random installation UUID, a
SHA-256 machine fingerprint, and the assistant version. Raw hardware
identifiers are not transmitted. The service must not log request bodies.
Claude credentials, project files, command history, and local diagnostic
output stay on the device.
