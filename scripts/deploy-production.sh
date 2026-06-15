#!/bin/sh
set -eu

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 license.example.com [--force]" >&2
  exit 1
fi

DOMAIN=$1
shift

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
mkdir -p .data

PREVIOUS_ENV=.data/pre-deploy.env
MIGRATION_SQL=.data/rotate-postgres-password.sql
rm -f "$PREVIOUS_ENV" "$MIGRATION_SQL"
trap 'rm -f "$PREVIOUS_ENV" "$MIGRATION_SQL"' EXIT HUP INT TERM

if [ -f .env ]; then
  cp .env "$PREVIOUS_ENV"
  chmod 600 "$PREVIOUS_ENV"
fi

node scripts/configure-production.mjs --domain "$DOMAIN" "$@"
node scripts/release-check.mjs

if [ -f "$PREVIOUS_ENV" ]; then
  node - "$PREVIOUS_ENV" .env "$MIGRATION_SQL" <<'NODE'
const fs = require("node:fs");
const [oldPath, newPath, outputPath] = process.argv.slice(2);
function readEnv(file) {
  return Object.fromEntries(
    fs.readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((line) => line && !line.trimStart().startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      })
  );
}
const previous = readEnv(oldPath).POSTGRES_PASSWORD;
const next = readEnv(newPath).POSTGRES_PASSWORD;
if (previous && next && previous !== next) {
  fs.writeFileSync(
    outputPath,
    `ALTER ROLE installer WITH PASSWORD '${next.replaceAll("'", "''")}';\n`,
    { mode: 0o600 }
  );
}
NODE
fi

if [ -f "$MIGRATION_SQL" ]; then
  docker compose --env-file "$PREVIOUS_ENV" up -d postgres
  docker compose --env-file "$PREVIOUS_ENV" exec -T postgres \
    sh -c 'until pg_isready -U installer >/dev/null 2>&1; do sleep 1; done'
  docker compose --env-file "$PREVIOUS_ENV" exec -T postgres \
    psql --username=installer --dbname=installer < "$MIGRATION_SQL"
fi

docker compose up -d --build --remove-orphans
docker compose ps

echo "Deployment started. Verify: https://$DOMAIN/health"
