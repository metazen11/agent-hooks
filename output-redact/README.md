# output-redact hook

PostToolUse hook that redacts secrets from **Bash tool output** before the
agent ever sees the raw value.

## Why this exists

Behavioral "never echo secrets" lessons have failed repeatedly — the agent
rationalizes per-case ("this one is fine because…") and the rationalization
step *is* the leak. A mechanical filter at the harness layer cuts the loop: the
raw value never reaches the model, so there is nothing to rationalize.

## What it does

Reads the Bash tool's stdout/stderr from the PostToolUse JSON on stdin, masks
known sensitive patterns inline, and writes the redacted JSON back to stdout.
Wired under `PostToolUse` with matcher `Bash`.

## Install

```bash
cd output-redact
node install.js            # symlink + PostToolUse(Bash) settings entry
node install.js --uninstall
```

Idempotent — re-running reports "already in settings.json" rather than
duplicating the entry.

## Tests

```bash
node output-redact/test/…      # see the test/ directory
```

## Related

- Global lesson: never surface passwords, API keys, tokens, or private keys in
  conversation or tool output.
- `env-guard` — the complementary PreToolUse hook that blocks Reads of secret
  files (`.env`, `wp-config.php`, …) in the first place.
