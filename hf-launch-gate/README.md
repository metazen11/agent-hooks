# hf-launch-gate

Strict-block PreToolUse hook that **refuses a paid Hugging Face Jobs launch**
unless process preconditions are met. Enforces **AC6 on
[metazen11/agent-memory#55](https://github.com/metazen11/agent-memory/issues/55)**.

## Why

An agent nearly launched a paid GPU job on Hugging Face Jobs with **no
originating issue** and **no auditor PASS**, on self-certification. The
standing rule: *any time we violate a rule, figure out how to
deterministically enforce it.* Behavioral "don't launch without approval"
instructions have failed before — the per-case rationalization step is the
leak. This hook converts the rule into a mechanical, auditable gate at
tool-call time.

## What it blocks (paid launch)

Every `Bash` tool call is inspected. The hook **denies** when a command
segment is a paid HF Jobs launch:

- `hf jobs run …`
- `hf jobs uv run …`
- a launcher script invoked **with `--launch`**, e.g.
  `./launch_pilot_4b.sh --launch`, `bash run_hf_job.sh --launch`,
  `scripts/launch_pilot_4b.sh --launch --gpu a10g`

Segment splitting is quote-aware and handles `&&`, `||`, `|`, `;` — a
launcher hidden behind `cd /tmp && ./launch_pilot_4b.sh --launch` is still
caught. Leading `VAR=val` prefixes and interpreters (`bash`, `sh`, `env`,
`nohup`, …) are stripped before classification.

## What it allows (never a paid launch)

- a launcher script **without** `--launch` (a dry-run / plan)
- read-only / control subcommands:
  `hf jobs logs | inspect | ls | ps | status | cancel | top`
- any other `hf …` command (`hf whoami`, `hf download`, `hf upload`, …)
- any unrelated Bash command (`git push`, `echo`, …)
- any non-`Bash` tool call

## Preconditions for a paid launch

Both are required before you authorize:

1. An **approved originating GitHub issue** exists for this launch, with
   explicit, testable acceptance criteria.
2. An **auditor PASS** has been recorded against that issue — from a
   **separate context**. Self-certification does not count.

## Override (auditable)

Once both gates are **green**, a human authorizes the launch by either
(mirrors `reconcile-gate`'s `--force-anyway` convention — intentionally loud
so it shows up in transcripts and audits):

- append **`--force-anyway`** anywhere in the command, **or**
- prefix **`HF_LAUNCH_APPROVED=<issue#>`**, e.g.

  ```bash
  HF_LAUNCH_APPROVED=55 hf jobs uv run --flavor a10g train.py
  ```

`HF_LAUNCH_APPROVED` must name a positive integer (a leading `#` is
tolerated). An empty or non-numeric value is treated as **not approved** and
the launch is still blocked. The env var is read either as an inline
`VAR=val` prefix in the command or from the hook process environment. Every
authorized launch also writes an `AUTHORIZED …` line to stderr for the audit
trail.

## Fail-safe (deliberate deviation from sibling hooks)

`reconcile-gate` and `dispatch-gate` **fail open** on error. This hook
**fails SAFE**: a paid GPU job is the blast radius, so if the hook throws
while a matched paid-launch command is pending, or encounters an `hf jobs`
command it cannot positively classify as safe, it **denies**. It only allows
input it can positively classify as *not* a paid launch. (A garbled hook
payload with no command to block is the one allow-on-error case — there is
nothing to deny meaningfully, and in normal operation a real launch re-enters
with a parseable payload.)

## Install

Following the `dispatch-gate` convention, the installer **symlinks only** by
default and does **not** touch `settings.json` — wiring a strict-block gate
is an operator decision, and mutating `settings.json` mid-session could
change hook behavior underneath a running agent.

```bash
cd hf-launch-gate
node install.js          # symlink into ~/.claude/hooks/ (available, INACTIVE)
node install.js --wire   # also add the PreToolUse(Bash) settings entry
node install.js --uninstall
```

After `--wire`, **restart Claude Code** to activate. The wired entry is:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "node ~/.claude/hooks/hf-launch-gate.js", "timeout": 5 }
        ]
      }
    ]
  }
}
```

The hook fast-paths everything that isn't an `hf jobs` / launcher command, so
overhead on unrelated Bash calls is negligible.

## Self-test

```bash
./hf-launch-gate/test-hf-launch-gate.sh
```

Runs 25 cases (block: `hf jobs run`, `hf jobs uv run`, launcher `--launch`,
launch behind `&&`, unknown `hf jobs` subcmd; allow: dry-runs, read-only
subcommands, unrelated commands, non-Bash, and both override forms; plus
empty/non-numeric approval still blocks). The test **never submits a real
job** — it only feeds synthetic payloads to the hook.

## Decision matrix

| Command | Decision |
|---|---|
| `hf jobs run …` | **deny** |
| `hf jobs uv run …` | **deny** |
| `./launch_pilot_4b.sh --launch` | **deny** |
| `bash run_hf_job.sh --launch` | **deny** |
| `cd /tmp && ./launch_pilot_4b.sh --launch` | **deny** |
| `hf jobs <unknown-subcmd>` | **deny** (fail-safe) |
| `./launch_pilot_4b.sh` (no `--launch`) | allow (dry-run) |
| `hf jobs logs\|inspect\|ls\|ps\|cancel …` | allow |
| `hf whoami`, `hf download …` | allow |
| `hf jobs run … --force-anyway` | allow (override) |
| `HF_LAUNCH_APPROVED=55 hf jobs run …` | allow (override) |
| `HF_LAUNCH_APPROVED=` / `=yes` + `hf jobs run …` | **deny** (invalid) |
| `git push`, `echo …` | allow |
| Anything not a `Bash` tool call | allow |

## Related

- **metazen11/agent-memory#55** — AC6, the acceptance criterion this hook satisfies
- `reconcile-gate/` — the `--force-anyway` override convention this mirrors
- `dispatch-gate/` — the symlink-only / `--wire` install convention this mirrors
