# iron-rules

Injects non-negotiable engineering rules into model context — once at session
start, then every Nth user turn.

Markdown in `CLAUDE.md` is advisory and gets skipped on autopilot. A hook fires
deterministically.

## Install

```bash
node install.js                # symlink + wire (default)
node install.js --every 20     # ... with a 20-turn cadence
node install.js --no-wire      # symlink only, review settings.json yourself
node install.js --uninstall    # remove cleanly
```

Restart Claude Code afterwards. Requires Node (any version with `fs`/`path` —
no dependencies).

## Editing the rules

The rules text is **not** in the code. It lives in [`IRON-RULES.md`](IRON-RULES.md).

The hook parses the `## Digest` section — every line starting `- ` becomes one
injected rule. The `## Detail` section below it is for humans and is ignored by
the parser. Edit the file; no code change, no reinstall.

## Cadence

| Setting | Effect |
|---|---|
| default | every 10 user turns |
| `IRON_RULES_EVERY=20` | every 20 turns |
| `IRON_RULES_EVERY=1` | every turn (noisy; useful for testing) |

`install.js --every N` writes `env.IRON_RULES_EVERY` into `~/.claude/settings.json`.

## Wiring

| Event | Invocation | Behaviour |
|---|---|---|
| `SessionStart` | `--session-start` | inject once |
| `UserPromptSubmit` | `--user-prompt` | inject on turns N, 2N, 3N… silent otherwise |

## Guarantees

- **Always exits 0.** A reminder must never block a turn.
- **Degrades to silence** on every failure: missing/corrupt transcript,
  unreadable or empty `IRON-RULES.md`, malformed stdin.
- **Never blocks a tool call.** It only appends context — unlike the strict
  gates (`reconcile-gate`, `hf-launch-gate`), it cannot refuse anything.

## Verify

```bash
node iron-rules.js --session-start          # should print the rules
echo '{}' | node iron-rules.js --user-prompt  # silent (turn 0)
```
