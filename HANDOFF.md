# Session Handoff

**Last updated:** 2026-09-20

## Status

`contracts/` package built, tested, merged to `main` (PR #1, commit `15eab5c`), and installed on Mac 1.

- Contract: `contracts/engineering-contract.md`, 11 numbered sections cited as `CONTRACT §N`
- Enforcement: 4 mechanical checks (§1, §3, §6, §7) via Claude Code PreToolUse dispatcher; instruction-based for Codex, Gemini, Anvil
- Tests: 51/51 passing (`node contracts/test.js`)
- Auto-update alert: `contracts/update-check.js` runs at SessionStart, banners when `origin/main:contracts` differs from local

## Installing on other machines

**First time** — clone (if needed) and install:

```bash
# Only if repo isn't cloned yet:
git clone https://github.com/metazen11/agent-hooks.git ~/_CODING/hooks

# Install for all detected agents on this machine:
cd ~/_CODING/hooks/contracts && node install.js --all
```

Detects and wires up whichever of Claude Code / Codex / Gemini / Anvil are present.

**Ongoing updates** — one command:

```bash
~/_CODING/hooks/contracts/pull-and-update.sh
```

Or manually: `cd ~/_CODING/hooks && git pull --ff-only origin main && cd contracts && node install.js --all`

**Automatic reminder** — once installed, Claude Code sessions on that machine print an update banner at SessionStart if remote has advanced. Rate-limited to once every 4 hours.

## Machine status

| Machine | Contracts installed | Notes |
|---|---|---|
| Mac 1 (this) | 2026-09-20 | live enforcement verified — §6 blocked test payload, §7 blocked branch delete until explicit auth |
| Mac 2 | pending | run install commands on Monday 2026-09-22 (or whenever) |
| Linux boxes (Anvil) | pending | instruction-only enforcement until Anvil Python middleware is added |

## Known issues / follow-ups

1. **`git-session` worktree bug** — `git-session/git-session.js` joins `cwd` with an absolute `.git` path inside worktrees; MERGE_HEAD skip check silently fails and the hook commits mid-merge with conflict markers. Fix: normalize the git-dir path with `path.resolve()` or check `path.isAbsolute()` before `path.join()`. Cost 2 rework cycles during the contracts PR merge.

2. **First §6 breach on record** — commit `15eab5c` on `main` contains AI-attribution trailers in its squash-merge commit message. Uncorrectable due to hard-deny on `git push --force-with-lease origin main` in `~/.claude/settings.json` (which is correct §7 enforcement). Grandfathered as the seed lesson; all future commits enforced by the now-live §6 check.

3. **Anvil mechanical enforcement** — currently instruction-only. Adding a Python middleware analogous to `plan-refiner/plan-refiner-middleware.py` would give Anvil deterministic §1/§3/§6/§7 enforcement.

## Force-push deny rules

Each machine's `~/.claude/settings.json` should include hard-deny rules for force-push to `main` / `master`. Verify on a new machine:

```bash
grep force-with-lease ~/.claude/settings.json
```

Should show entries like `"Bash(git push --force-with-lease origin main)"`. If missing, copy from Mac 1.

## Backup / rollback

- `origin/pre-contracts-merge-2026-09-19` tag preserves `main` state before the contracts PR merged
- `origin/session-20260221-final` tag preserves the deleted session branch tip
