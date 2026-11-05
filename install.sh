#!/usr/bin/env bash
#
# install.sh — install the pre-commit git hook into the repository this is
# run from.
#
# Kept for existing callers of ./install.sh. It has no install logic of its
# own: it delegates to pre-commit-hook/install.js --agent=git, which symlinks
# <current directory>/.git/hooks/pre-commit to this repo's pre-commit script.
# Extra arguments are passed through (e.g. --uninstall).
#
# Usage: /path/to/hooks/install.sh [--uninstall]    # from the target repo root
#

exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pre-commit-hook/install.js" --agent=git "$@"
