#!/usr/bin/env bash
#
# Install git hooks from the hooks/ directory
#
# Usage: ./hooks/install.sh
#

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
GIT_HOOKS_DIR="$PROJECT_ROOT/.git/hooks"

echo "Installing git hooks..."

if [[ ! -d "$GIT_HOOKS_DIR" ]]; then
  echo "Error: .git/hooks directory not found"
  echo "Make sure you're in a git repository"
  exit 1
fi

# Install each hook
for hook in "$SCRIPT_DIR"/*; do
  hook_name=$(basename "$hook")

  # Skip install.sh and README
  if [[ "$hook_name" == "install.sh" ]] || [[ "$hook_name" == "README.md" ]]; then
    continue
  fi

  # Copy and make executable
  cp "$hook" "$GIT_HOOKS_DIR/$hook_name"
  chmod +x "$GIT_HOOKS_DIR/$hook_name"
  echo "  Installed: $hook_name"
done

echo ""
echo "Git hooks installed successfully!"
echo ""
echo "Hooks will run automatically on git operations."
echo "To bypass a hook: git commit --no-verify"
