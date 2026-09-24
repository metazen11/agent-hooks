#!/usr/bin/env bash
# install-template.sh — one command per MACHINE.
#
#   ./install-template.sh           # install + point git at it
#   ./install-template.sh --check   # report status only
#   ./install-template.sh --uninstall
#
# Installs a git template whose post-checkout hook auto-activates a repo's
# versioned .githooks/ on clone. After this, every FUTURE clone on this machine
# wires itself up — no per-repo step.
#
# It does NOT retrofit clones you already have: run ./activate-all.sh for those.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/git-template"
DEST="${GIT_TEMPLATE_DIR:-$HOME/.git-template}"

case "${1:-}" in
  --check)
    echo "  template dir:        $DEST $([ -d "$DEST" ] && echo '(present)' || echo '(MISSING)')"
    echo "  post-checkout hook:  $([ -x "$DEST/hooks/post-checkout" ] && echo 'present, executable' || echo 'MISSING')"
    echo "  init.templateDir:    $(git config --global --get init.templateDir || echo '(unset — NOT active)')"
    exit 0 ;;
  --uninstall)
    git config --global --unset init.templateDir 2>/dev/null || true
    rm -f "$DEST/hooks/post-checkout"
    echo "  ✓ removed post-checkout and unset init.templateDir"
    echo "    (existing repos keep their own core.hooksPath; unset per-repo if desired)"
    exit 0 ;;
esac

mkdir -p "$DEST/hooks"
cp "$SRC/hooks/post-checkout" "$DEST/hooks/post-checkout"
chmod +x "$DEST/hooks/post-checkout"
git config --global init.templateDir "$DEST"

echo "  ✓ $DEST/hooks/post-checkout"
echo "  ✓ git config --global init.templateDir $DEST"
echo
echo "  Every FUTURE clone on this machine now activates .githooks automatically."
echo "  For clones that already exist:  ./activate-all.sh ~/_CODING"
