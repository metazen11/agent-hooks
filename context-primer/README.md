# context-primer

Forces the required instruction files into context **before** Claude starts any
work, and gates work-performing tool calls until those files are loaded.

## Why

Instructions in `CLAUDE.md` say what to do, but the agent *can* skip reading
project files and start editing unprimed. This hook makes priming deterministic
and **time-based** — it primes at session start and refreshes on a turn cadence,
rather than nagging on every edit:

- **SessionStart** injects the content of the relevant instruction files directly
  into context (`hookSpecificOutput.additionalContext`) and marks the session
  primed. Unskippable, zero friction.
- **UserPromptSubmit** counts user turns from the transcript and re-injects the
  files every **50 turns** (turns 50, 100, 150…) so a long session doesn't drift
  from the contracts. Every other turn is a near-instant no-op.
- **PreToolUse** (`Edit|Write|NotebookEdit|Bash`) is a **one-time safety net**,
  not a per-edit gate. It fires only if a session performs work but never got the
  SessionStart injection (hook added mid-session, or a launch path that skipped
  it). In that one case it denies the first work call with the Read list, then
  goes silent for the rest of the session. Once SessionStart has primed a
  session, this gate never fires.

Read-only tools (Read, Grep, Glob, LS, Task…) are never gated — investigation
stays unblocked.

The reprime cadence is `REPRIME_EVERY` at the top of `context-primer.js`
(default 50).

## Required files

Discovered relative to the project root (nearest `.git` ancestor) and the cwd:

- **Project instruction files:** `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`
- **Coding requirements:** `coding_requirements.md`, `CONTRIBUTING.md`,
  `docs/coding-standards.md`, `.autonomous.json`
- **Autonomous-agents contracts (global, always):** `~/.claude/CLAUDE.md`

Only files that exist are required. Each file is clipped to 24 KB in the
injection (the full file is still on disk to Read).

## Install

```sh
node install.js            # symlink + wire SessionStart and PreToolUse entries
node install.js --uninstall
```

Restart Claude Code to activate. Coexists with the other hooks
(git-session, reconcile-gate, env-guard, worktree-write-guard…).

## Behavior notes

- **Fails open.** Any internal error allows the call / injects nothing rather than
  blocking the session. This is a guardrail, not a tripwire.
- **Deny-once, and only unprimed.** The PreToolUse gate fires at most once, and
  only for a session that never got the SessionStart injection. It does not nag
  on every edit. The hard guarantee that content is in-context comes from the
  SessionStart + every-50-turn injections.
- **Per-session state** lives in `$TMPDIR/context-primer/`, keyed by session id
  (or a cwd hash as fallback). It records a single `primed` flag once
  SessionStart runs; the gate keys off that flag.

## Test

```sh
# SessionStart injection
echo '{"hook_event_name":"SessionStart","cwd":"'"$PWD"'"}' \
  | node context-primer.js --session-start

# PreToolUse gate (fresh session denies once, then allows)
echo '{"hook_event_name":"PreToolUse","tool_name":"Edit","cwd":"'"$PWD"'"}' \
  | node context-primer.js
```
