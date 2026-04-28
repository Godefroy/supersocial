#!/usr/bin/env bash
# Wrapper cron generique pour les commandes supersocial.
# Usage: scripts/cron.sh <args passes a `npm run dev --`>
# Exemples:
#   scripts/cron.sh linkedin outbox:send
#   scripts/cron.sh linkedin posts:sync:latest
#
# - Verrou global: une seule commande supersocial a la fois (le profil Chrome
#   `.chrome-profile/` ne supporte pas deux launchPersistentChrome paralleles).
# - Log par job dans data/.state/cron/<job>.log (job derive des args).
# - PATH explicite pour cron (qui n'herite pas du shell interactif).

set -u

if [ $# -eq 0 ]; then
  echo "Usage: $0 <args passes a 'npm run dev --'>" >&2
  exit 2
fi

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="$REPO_DIR/data/.state/cron"
LOCK_FILE="$STATE_DIR/lock"

# Job name: args joints par '-', ':' remplaces par '-'. Ex: 'linkedin outbox:send' -> 'linkedin-outbox-send'.
JOB_NAME="$(printf '%s-' "$@" | sed 's/:/-/g; s/-$//')"
LOG_FILE="$STATE_DIR/$JOB_NAME.log"

mkdir -p "$STATE_DIR"

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*" >> "$LOG_FILE"; }

# Verrou atomique via noclobber. Stocke le PID; si stale (process mort), on prend la main.
acquire_lock() {
  if ( set -o noclobber; echo $$ > "$LOCK_FILE" ) 2>/dev/null; then
    return 0
  fi
  local pid
  pid=$(cat "$LOCK_FILE" 2>/dev/null || true)
  if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
    log "skip: lock global tenu par PID $pid"
    return 1
  fi
  log "lock global perime (PID ${pid:-?} mort), reprise"
  rm -f "$LOCK_FILE"
  if ( set -o noclobber; echo $$ > "$LOCK_FILE" ) 2>/dev/null; then
    return 0
  fi
  log "echec acquisition verrou global"
  return 1
}

acquire_lock || exit 0
trap 'rm -f "$LOCK_FILE"' EXIT

log "=== $JOB_NAME start (PID $$) ==="
cd "$REPO_DIR" || { log "echec cd $REPO_DIR"; exit 1; }

# Stale-lock Chrome: si un run precedent a laisse un orphelin Chrome, le SingletonLock
# pointe vers un PID mort. Le supprimer pour ne pas faire echouer 40 messages d'affilee.
SINGLETON_LOCK="$REPO_DIR/.chrome-profile/SingletonLock"
if [ -L "$SINGLETON_LOCK" ]; then
  target=$(readlink "$SINGLETON_LOCK" 2>/dev/null || true)
  chrome_pid="${target##*-}"
  if [ -n "${chrome_pid:-}" ] && ! kill -0 "$chrome_pid" 2>/dev/null; then
    log "SingletonLock perime (Chrome PID $chrome_pid mort), suppression"
    rm -f "$SINGLETON_LOCK" "$REPO_DIR/.chrome-profile/SingletonCookie" "$REPO_DIR/.chrome-profile/SingletonSocket"
  fi
fi

npm run --silent dev -- "$@" >> "$LOG_FILE" 2>&1
status=$?

log "=== $JOB_NAME end (exit $status) ==="
exit $status
