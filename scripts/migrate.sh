#!/usr/bin/env bash
# Minimal, dependency-free migration runner (psql-based).
#
#   pnpm migrate up      apply every unapplied supabase/migrations/NNN_*.sql
#                        in sorted order, recording each in schema_migrations.
#   pnpm migrate status  show applied vs pending.
#
# Idempotent: re-running `up` is a no-op. Uses ON_ERROR_STOP so a failing
# statement aborts the run (and that migration is NOT recorded, so a fix +
# re-run resumes cleanly). Each migration file is applied inside a single
# transaction (-1) so a partial failure rolls back.
#
# Connection: set DATABASE_URL, e.g.
#   postgres://postgres:postgres@localhost:54322/nbe_theta
set -euo pipefail

CMD="${1:-up}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG_DIR="$ROOT/supabase/migrations"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "migrate: DATABASE_URL is not set" >&2
  exit 2
fi

psql_do() { psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -qtA "$@"; }

ensure_ledger() {
  psql_do -c "create table if not exists schema_migrations (
    version text primary key,
    applied_at timestamptz not null default now()
  );" >/dev/null
}

applied_versions() {
  psql_do -c "select version from schema_migrations order by version;"
}

list_files() {
  # NNN_*.sql sorted lexicographically (zero-padded numbers sort correctly).
  find "$MIG_DIR" -maxdepth 1 -name '[0-9]*_*.sql' -printf '%f\n' | sort
}

cmd_status() {
  ensure_ledger
  local applied
  applied="$(applied_versions || true)"
  echo "applied:"
  echo "${applied:-  (none)}" | sed 's/^/  /'
  echo "pending:"
  local any_pending=0
  while IFS= read -r f; do
    local v="${f%.sql}"
    if ! grep -qxF "$v" <<<"$applied"; then
      echo "  $f"
      any_pending=1
    fi
  done < <(list_files)
  [[ "$any_pending" == "0" ]] && echo "  (none)"
}

cmd_up() {
  ensure_ledger
  local applied
  applied="$(applied_versions || true)"
  local n=0
  while IFS= read -r f; do
    local v="${f%.sql}"
    if grep -qxF "$v" <<<"$applied"; then
      continue
    fi
    echo "→ applying $f"
    # -1 wraps the file in a single transaction; ON_ERROR_STOP aborts on error.
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -1 -f "$MIG_DIR/$f"
    psql_do -c "insert into schema_migrations (version) values ('$v');" >/dev/null
    n=$((n + 1))
  done < <(list_files)
  echo "migrate up: applied $n migration(s)"
}

case "$CMD" in
  up)     cmd_up ;;
  status) cmd_status ;;
  *)
    echo "usage: migrate.sh [up|status]" >&2
    exit 2
    ;;
esac
