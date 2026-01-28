# env-guard

Prevents AI agents from surfacing `.env` secrets in conversations.

When an agent tries to **Read** a `.env` file, the hook blocks the read and returns a sanitized view with variable names visible but values masked. When an agent tries to **Edit** a `.env` file, the hook blocks the edit and directs it to use `env-write.js` instead.

---

## What it does

| Agent action | Hook response |
|---|---|
| `Read .env.local` | **Block** — returns variable names with values shown as `******* (N chars)` |
| `Edit .env.local` | **Block** — redirects to `env-write.js` helper |
| `Read any other file` | **Allow** — passes through normally |

### Protected files

- `.env`, `.env.local`, `.env.production`, `.env.hardened`, etc.
- `config.json` files in paths containing `etl`, `database`, or `credential`

### JSON support

JSON config files are sanitized with structure preserved — keys with names matching `pwd`, `pass`, `secret`, `token`, `key`, `auth` are masked, as are any string values over 40 characters.

---

## Prerequisites

- **Node.js** (any version with `fs`, `path`, `os` — no external dependencies)
- **Claude Code** installed (`~/.claude/` directory exists)

---

## Install

```bash
cd ~/Dropbox/_CODING/hooks/env-guard
node install.js
```

This does three things:

1. **Symlinks** `env-guard.js` and `env-write.js` into `~/.claude/hooks/`
2. **Patches** `~/.claude/settings.json` — adds a `PreToolUse` hook entry for `Read|Edit`
3. **Prints** a summary of what was installed

Restart Claude Code to activate.

### What gets added to settings.json

The installer adds this entry to `hooks.PreToolUse[]` in your **user-level** settings (`~/.claude/settings.json`):

```json
{
  "matcher": "Read|Edit",
  "hooks": [
    {
      "type": "command",
      "command": "node ~/.claude/hooks/env-guard.js",
      "timeout": 10
    }
  ]
}
```

This is a **user-level** setting — it applies to all projects, all sessions. You do not need to add anything to project-level `.claude/settings.json` files.

### Manual install (if you prefer)

1. Copy `env-guard.js` and `env-write.js` to `~/.claude/hooks/`
2. Add the JSON block above to your `~/.claude/settings.json` under `hooks.PreToolUse`

---

## Uninstall

```bash
node install.js --uninstall
```

Removes the symlinks and the settings entry. Your `.env` files return to normal agent access.

---

## Usage

### Reading .env files

Once installed, any agent Read of a `.env` file is blocked and returns output like:

```
BLOCKED: Secret file — values are masked.

────────────────────────────────────────────────────────
  .env.hardened
────────────────────────────────────────────────────────

# Port configuration
GEOSERVER_PORT=******* (4 chars)

# Admin credentials
GEOSERVER_ADMIN_USER=******* (5 chars)
GEOSERVER_ADMIN_PASSWORD=******* (11 chars)

────────────────────────────────────────────────────────
  Write: node ~/.claude/hooks/env-write.js "/path/to/.env.hardened" KEY VALUE
────────────────────────────────────────────────────────
```

### Writing .env values

The agent uses the helper script via Bash:

```bash
node ~/.claude/hooks/env-write.js "/path/to/.env" MY_KEY "my-value"
```

Output (value never shown):

```
OK: MY_KEY updated in .env (8 chars)
```

---

## Extending to other agents

The installer uses a `TARGETS` map in `install.js`:

```js
const TARGETS = {
  claude: {
    hooksDir:     '~/.claude/hooks/',
    settingsFile: '~/.claude/settings.json',
    hookEntry:    { ... }
  },
  // Add your own agents here:
  // myAgent: { hooksDir: '...', settingsFile: '...' },
};
```

Each target defines where hooks live and how to register them. The install/uninstall logic handles symlinks and settings patching for each target automatically.

---

## Files

| File | Purpose |
|---|---|
| `env-guard.js` | PreToolUse hook — intercepts Read/Edit, returns masked output |
| `env-write.js` | CLI helper — writes KEY=VALUE to .env without surfacing the value |
| `install.js` | Installer — symlinks files, patches settings |
| `package.json` | Package metadata (no dependencies) |

---

## Testing

```bash
# Should block and show masked values
echo '{"tool_name":"Read","tool_input":{"file_path":"test.env"}}' | node env-guard.js

# Should block with redirect message
echo '{"tool_name":"Edit","tool_input":{"file_path":"test.env"}}' | node env-guard.js

# Should allow
echo '{"tool_name":"Read","tool_input":{"file_path":"app.js"}}' | node env-guard.js
```
