#!/usr/bin/env node
/**
 * worktree-cap — PreToolUse gate: refuse to open another worktree while the
 * repo already holds CAP worktrees with unlanded work.
 *
 * WHY: reviewed work that never lands. Agents kept opening fresh worktrees
 * while earlier ones sat reviewed-but-unmerged. A hard ceiling on unlanded
 * worktrees forces landing (or deleting) before starting more.
 *
 * Triggers: Bash `git worktree add ...`, and Agent/Task dispatch with
 * isolation=worktree. Counts worktrees under .worktrees/ and .claude/worktrees/
 * whose HEAD has commits not in the integration trunk (origin/dev else
 * origin/main|master).
 *
 * CAP (see lib.resolveCap): persisted in <repo>/.worktree-cap, baselined at
 * unlanded+3 on first sight and RATCHETED DOWN only (commit the file so it is
 * durable). WORKTREE_CAP env overrides without persisting.
 * Bypass (logged to stderr): WORKTREE_CAP_DISABLE=true.
 * Fails OPEN on internal errors / non-git directories (a hook bug must not
 * brick the session); the cap itself is deterministic.
 */
'use strict';
const path = require('path');
const lib = require('./lib');

const { worktreeAddTargets } = require('./parse-git');

function blockMsg(root, cap, s) {
    return `worktree-cap: ${s.unlanded.length} unlanded worktrees open, cap is ${cap}. Refusing to open another.\n\n` +
        lib.format(s) + '\n\n' +
        `NEXT STEP: land one with /reconcile (or delete it if abandoned) before creating a new worktree.\n` +
        `The cap only ratchets down as you clean up; to raise it deliberately edit ${path.join(root, lib.CAP_FILE)} or set WORKTREE_CAP=<n>.`;
}

function decide(input) {
    const tool = input.tool_name;
    const ti = input.tool_input || {};
    const cwd = input.cwd || process.cwd();
    let targets;
    if (tool === 'Bash') {
        if (typeof ti.command !== 'string') return null;
        const r = worktreeAddTargets(ti.command, cwd);
        if (!r.targets.length) return null;
        if (r.unresolved) {
            return 'worktree-cap: cannot statically resolve which repo this `git worktree add` targets ($VAR, backticks or $(...) in -C/cd path). Failing closed: use a literal path, or `cli.js add <repo> ...`.';
        }
        targets = r.targets;
    } else if ((tool === 'Agent' || tool === 'Task') && ti.isolation === 'worktree') {
        targets = [cwd];
    } else {
        return null;
    }
    for (const t of new Set(targets)) {
        const root = lib.repoRoot(t);
        if (!root) continue;
        const s = lib.scan(root);
        let cap;
        try { cap = lib.resolveCap(root, s.unlanded.length); } catch (e) {
            if (e instanceof lib.CapFileError) return `worktree-cap: ${e.message}`;
            throw e;
        }
        if (s.unlanded.length >= cap) return blockMsg(root, cap, s);
    }
    return null;
}

function main() {
    if (process.env.WORKTREE_CAP_DISABLE === 'true') {
        process.stderr.write('[worktree-cap] bypassed via WORKTREE_CAP_DISABLE\n');
        return;
    }
    let input;
    try { input = JSON.parse(require('fs').readFileSync(0, 'utf8')); } catch (e) {
        process.stderr.write(`[worktree-cap] stdin parse error: ${e.message}\n`);
        return;
    }
    let reason;
    try { reason = decide(input); } catch (e) {
        process.stderr.write(`[worktree-cap] internal error, failing open: ${e.message}\n`);
        return;
    }
    if (reason) {
        process.stdout.write(JSON.stringify({
            hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
        }));
    }
}

if (require.main === module) main();
module.exports = { decide };
