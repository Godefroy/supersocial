#!/usr/bin/env bash
# Gestion du crontab utilisateur pour supersocial.
# Merge les lignes de scripts/crontab.txt entre des marqueurs, sans toucher
# aux autres jobs cron de l'utilisateur.
#
# Usage:
#   scripts/crontab.sh install    # ajoute ou rafraichit le bloc supersocial
#   scripts/crontab.sh uninstall  # retire le bloc supersocial
#   scripts/crontab.sh status     # affiche le bloc actuellement installe
#   scripts/crontab.sh preview    # affiche ce qui serait installe (sans toucher au crontab)

set -eu

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$REPO_DIR/scripts/crontab.txt"
MARKER_START="# >>> supersocial >>>"
MARKER_END="# <<< supersocial <<<"

cmd="${1:-}"

read_current() {
  crontab -l 2>/dev/null || true
}

# Crontab utilisateur sans le bloc supersocial (entre marqueurs inclus).
strip_block() {
  awk -v s="$MARKER_START" -v e="$MARKER_END" '
    $0 == s {skip=1; next}
    $0 == e {skip=0; next}
    !skip {print}
  '
}

# Bloc avec __REPO__ substitue par le vrai chemin.
render_block() {
  if [ ! -f "$TEMPLATE" ]; then
    echo "Template introuvable: $TEMPLATE" >&2
    exit 1
  fi
  sed "s|__REPO__|$REPO_DIR|g" "$TEMPLATE"
}

case "$cmd" in
  install)
    rendered=$(render_block)
    current=$(read_current)
    base=$(printf '%s\n' "$current" | strip_block)
    {
      # Garder le crontab existant, ajouter une ligne vide si besoin, puis le bloc.
      if [ -n "$base" ]; then
        printf '%s\n' "$base"
        # Si le crontab existant ne se termine pas deja par une ligne vide, en ajouter une.
        if [ "$(printf '%s' "$base" | tail -c1)" != "" ]; then
          echo
        fi
      fi
      echo "$MARKER_START"
      printf '%s\n' "$rendered"
      echo "$MARKER_END"
    } | crontab -
    echo "Installe. Verifier avec: crontab -l"
    ;;
  uninstall)
    current=$(read_current)
    if ! printf '%s\n' "$current" | grep -qF "$MARKER_START"; then
      echo "Bloc supersocial absent du crontab, rien a faire."
      exit 0
    fi
    printf '%s\n' "$current" | strip_block | crontab -
    echo "Desinstalle."
    ;;
  status)
    current=$(read_current)
    if ! printf '%s\n' "$current" | grep -qF "$MARKER_START"; then
      echo "Bloc supersocial absent du crontab."
      exit 0
    fi
    printf '%s\n' "$current" | awk -v s="$MARKER_START" -v e="$MARKER_END" '
      $0 == s {inblock=1; next}
      $0 == e {inblock=0; next}
      inblock {print}
    '
    ;;
  preview)
    render_block
    ;;
  *)
    echo "Usage: $0 {install|uninstall|status|preview}" >&2
    exit 2
    ;;
esac
