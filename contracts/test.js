#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// test.js — Unit tests for the contracts hook
// Zero dependencies beyond node stdlib. Matches plan-refiner/test.js style.
// ─────────────────────────────────────────────────────────────

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
    passed++;
  } else {
    console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
    failed++;
  }
}

// Assert a check result is allow (allow: true, no reason).
function assertAllow(result, msg) {
  const ok = result && result.allow === true;
  assert(ok, msg);
  if (!ok) {
    console.log(`      got: ${JSON.stringify(result)}`);
  }
}

// Assert a check result is deny and its reason contains all substrings.
function assertDeny(result, substrs, msg) {
  const list = Array.isArray(substrs) ? substrs : [substrs];
  const denied = result && result.allow === false && typeof result.reason === 'string';
  const allPresent = denied && list.every((s) => result.reason.includes(s));
  assert(allPresent, msg);
  if (!allPresent) {
    console.log(`      got: ${JSON.stringify(result)}`);
    console.log(`      expected reason to include: ${JSON.stringify(list)}`);
  }
}

console.log('\n\x1b[1mContracts Hook — Test Suite\x1b[0m');

// ═════════════════════════════════════════════════════════════
// s1-no-hardcoding
// ═════════════════════════════════════════════════════════════

console.log('\ns1-no-hardcoding:');

const s1 = require('./checks/s1-no-hardcoding.js');

// ALLOW: Write to a test file with localhost URL (exempt path)
assertAllow(
  s1.check('Write', {
    file_path: '/repo/tests/api.test.py',
    content: 'BASE = "http://localhost:8080/health"',
  }),
  'allows Write to test file with localhost URL (path exemption)'
);

// ALLOW: Write to `.env` file with credentials (exempt name)
assertAllow(
  s1.check('Write', {
    file_path: '/repo/.env',
    content: 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nBEARER=Bearer abcdefghijklmnopqrstuvwx',
  }),
  'allows Write to .env with credentials (name exemption)'
);

// ALLOW: Write to `.md` file with paths (exempt extension)
assertAllow(
  s1.check('Write', {
    file_path: '/repo/docs/setup.md',
    content: 'Install to "/Users/mz/tools/thing" and hit http://localhost:3000',
  }),
  'allows Write to .md file with paths (extension exemption)'
);

// ALLOW: Write to a .py file with only imports (no hardcoded values)
assertAllow(
  s1.check('Write', {
    file_path: '/repo/src/module.py',
    content: 'import os\nimport sys\nfrom pathlib import Path\n\ndef main():\n    return None\n',
  }),
  'allows .py file with only imports (no violations)'
);

// DENY: Write to `.py` with `http://localhost:8080`
assertDeny(
  s1.check('Write', {
    file_path: '/repo/src/api.py',
    content: 'URL = "http://localhost:8080/v1"',
  }),
  ['§1', 'localhost-port'],
  'denies python file with localhost:8080 URL'
);

// DENY: Write to `.ts` with `/Users/mz/secret/token.txt` in a string
assertDeny(
  s1.check('Write', {
    file_path: '/repo/src/loader.ts',
    content: 'const p = "/Users/mz/secret/token.txt";',
  }),
  ['§1', 'absolute-home-path'],
  'denies .ts file with absolute /Users/mz path'
);

// DENY: Write with AWS access key
assertDeny(
  s1.check('Write', {
    file_path: '/repo/src/aws.py',
    content: 'KEY = "AKIAIOSFODNN7EXAMPLE"',
  }),
  ['§1', 'aws-access-key'],
  'denies file containing AWS access key'
);

// DENY: Write with PEM private key header
assertDeny(
  s1.check('Write', {
    file_path: '/repo/src/keys.js',
    content: 'const KEY = `-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBALZ...`;',
  }),
  ['§1', 'private-key-pem'],
  'denies file with PEM private key header'
);

// ALLOW: Non-Write/Edit tool call (Bash) — check returns allow
assertAllow(
  s1.check('Bash', { command: 'echo hello' }),
  'allows non-Write/Edit tool call (Bash)'
);

// ═════════════════════════════════════════════════════════════
// s3-no-symptom-suppression
// ═════════════════════════════════════════════════════════════

console.log('\ns3-no-symptom-suppression:');

const s3 = require('./checks/s3-no-symptom-suppression.js');

// ALLOW: Normal `git commit -m "fix"`
assertAllow(
  s3.check('Bash', { command: 'git commit -m "fix"' }),
  'allows normal git commit'
);

// ALLOW: `git commit -S -m "signed"` (not a bypass)
assertAllow(
  s3.check('Bash', { command: 'git commit -S -m "signed"' }),
  'allows signed commit (-S is not -n)'
);

// ALLOW: `.py` file with proper `except ValueError:`
assertAllow(
  s3.check('Write', {
    file_path: '/repo/src/mod.py',
    content: 'try:\n    x = int(s)\nexcept ValueError:\n    x = 0\n',
  }),
  'allows python file with specific exception handling'
);

// DENY: `git commit --no-verify -m "..."`
assertDeny(
  s3.check('Bash', { command: 'git commit --no-verify -m "quick"' }),
  ['§3', 'git-no-verify'],
  'denies git commit --no-verify'
);

// DENY: `git commit -n -m "..."`
assertDeny(
  s3.check('Bash', { command: 'git commit -n -m "quick"' }),
  ['§3'],
  'denies git commit -n'
);

// DENY: `git push --no-verify`
assertDeny(
  s3.check('Bash', { command: 'git push --no-verify origin main' }),
  ['§3'],
  'denies git push --no-verify'
);

// DENY: Write to `.py` with `except: pass`
assertDeny(
  s3.check('Write', {
    file_path: '/repo/src/bad.py',
    content: 'try:\n    do()\nexcept:\n    pass\n',
  }),
  ['bare-except-pass'],
  'denies python file with bare except: pass'
);

// DENY: Write to `.ts` with `// @ts-ignore` (no issue ref)
assertDeny(
  s3.check('Write', {
    file_path: '/repo/src/thing.ts',
    content: '// @ts-ignore\nconst x: number = "oops";\n',
  }),
  ['ts-ignore-orphan'],
  'denies .ts file with orphan @ts-ignore'
);

// ALLOW: `.ts` with `// @ts-ignore  // tracked in #123`
assertAllow(
  s3.check('Write', {
    file_path: '/repo/src/thing.ts',
    content: '// @ts-ignore  // tracked in #123\nconst x: number = "oops";\n',
  }),
  'allows @ts-ignore with issue reference (#123)'
);

// DENY: Write to `.py` with `# noqa` (no rule code)
assertDeny(
  s3.check('Write', {
    file_path: '/repo/src/mod.py',
    content: 'x = 1  # noqa\n',
  }),
  ['noqa-orphan'],
  'denies python file with orphan # noqa'
);

// ALLOW: `.py` with `# noqa: E501`
assertAllow(
  s3.check('Write', {
    file_path: '/repo/src/mod.py',
    content: 'x = "a very long line that would otherwise trip up flake8"  # noqa: E501\n',
  }),
  'allows # noqa with rule code (E501)'
);

// ═════════════════════════════════════════════════════════════
// s6-no-ai-attribution
// ═════════════════════════════════════════════════════════════

console.log('\ns6-no-ai-attribution:');

const s6 = require('./checks/s6-no-ai-attribution.js');

// ALLOW: Normal commit message
assertAllow(
  s6.check('Bash', { command: 'git commit -m "fix: bug"' }),
  'allows normal commit message'
);

// ALLOW: File content with regular author line
assertAllow(
  s6.check('Write', {
    file_path: '/repo/AUTHORS.md',
    content: 'Co-Authored-By: Jane Doe <jane@example.com>\n',
  }),
  'allows regular Co-Authored-By line (non-AI)'
);

// DENY: Commit with Co-Authored-By Claude
assertDeny(
  s6.check('Bash', {
    command: 'git commit -m "fix\n\nCo-Authored-By: Claude <noreply@anthropic.com>"',
  }),
  ['§6'],
  'denies commit with Co-Authored-By: Claude'
);

// DENY: Commit with 🤖 Generated with Claude Code
assertDeny(
  s6.check('Bash', {
    command: 'git commit -m "🤖 Generated with Claude Code"',
  }),
  ['§6'],
  'denies commit with 🤖 Generated with Claude Code'
);

// DENY: gh pr create with attribution in body
assertDeny(
  s6.check('Bash', {
    command: 'gh pr create --body "Generated with Claude Code"',
  }),
  ['§6'],
  'denies gh pr create with "Generated with Claude Code" body'
);

// DENY: Write to file containing Co-Authored-By Claude
assertDeny(
  s6.check('Write', {
    file_path: '/repo/COMMIT_EDITMSG',
    content: 'fix: something\n\nCo-Authored-By: Claude <x@y>',
  }),
  ['§6'],
  'denies Write with Co-Authored-By: Claude in content'
);

// DENY: Content with `Generated by GitHub Copilot`
assertDeny(
  s6.check('Write', {
    file_path: '/repo/CHANGELOG.txt',
    content: 'Some notes.\nGenerated by GitHub Copilot\n',
  }),
  ['§6'],
  'denies content with "Generated by GitHub Copilot"'
);

// DENY: Content with `Generated by Cursor`
assertDeny(
  s6.check('Write', {
    file_path: '/repo/CHANGELOG.txt',
    content: 'Some notes.\nGenerated by Cursor\n',
  }),
  ['§6'],
  'denies content with "Generated by Cursor"'
);

// ═════════════════════════════════════════════════════════════
// s7-reversibility-gate
// ═════════════════════════════════════════════════════════════

console.log('\ns7-reversibility-gate:');

const s7 = require('./checks/s7-reversibility-gate.js');

// ALLOW: `rm somefile.txt` (single file, no -rf)
assertAllow(
  s7.check('Bash', { command: 'rm somefile.txt' }),
  'allows rm of a single file (no -rf)'
);

// ALLOW: `git commit`, `git push`, `git pull` (non-destructive)
assertAllow(
  s7.check('Bash', { command: 'git commit -m "wip"' }),
  'allows plain git commit'
);
assertAllow(
  s7.check('Bash', { command: 'git push origin main' }),
  'allows plain git push'
);
assertAllow(
  s7.check('Bash', { command: 'git pull --rebase' }),
  'allows plain git pull'
);

// ALLOW: `SELECT * FROM users` (read-only SQL)
assertAllow(
  s7.check('Bash', { command: 'psql -c "SELECT * FROM users"' }),
  'allows read-only SELECT'
);

// DENY: `rm -rf /tmp/foo`
assertDeny(
  s7.check('Bash', { command: 'rm -rf /tmp/foo' }),
  ['§7', 'rm-rf'],
  'denies rm -rf'
);

// DENY: `rm -fr node_modules`
assertDeny(
  s7.check('Bash', { command: 'rm -fr node_modules' }),
  ['§7'],
  'denies rm -fr'
);

// DENY: `git reset --hard HEAD~3`
assertDeny(
  s7.check('Bash', { command: 'git reset --hard HEAD~3' }),
  ['git-reset-hard'],
  'denies git reset --hard'
);

// DENY: `git push --force origin main`
assertDeny(
  s7.check('Bash', { command: 'git push --force origin main' }),
  ['git-push-force'],
  'denies git push --force'
);

// DENY: `git push --force-with-lease` (still deny)
assertDeny(
  s7.check('Bash', { command: 'git push --force-with-lease origin main' }),
  ['git-push-force'],
  'denies git push --force-with-lease (still a force push)'
);

// DENY: `git branch -D feature`
assertDeny(
  s7.check('Bash', { command: 'git branch -D feature' }),
  ['git-branch-delete-force'],
  'denies git branch -D'
);

// DENY: `psql -c "DROP TABLE users"`
assertDeny(
  s7.check('Bash', { command: 'psql -c "DROP TABLE users"' }),
  ['sql-drop-table'],
  'denies DROP TABLE'
);

// DENY: `psql -c "TRUNCATE users"`
assertDeny(
  s7.check('Bash', { command: 'psql -c "TRUNCATE users"' }),
  ['sql-truncate'],
  'denies TRUNCATE'
);

// DENY: `psql -c "DELETE FROM users;"`
assertDeny(
  s7.check('Bash', { command: 'psql -c "DELETE FROM users;"' }),
  ['sql-delete-no-where'],
  'denies DELETE FROM users; (no WHERE)'
);

// ALLOW: `psql -c "DELETE FROM users WHERE id = 1"` (has WHERE)
assertAllow(
  s7.check('Bash', { command: 'psql -c "DELETE FROM users WHERE id = 1"' }),
  'allows DELETE FROM users WHERE id = 1'
);

// ═════════════════════════════════════════════════════════════
// dispatcher integration (contracts-hook.js)
// ═════════════════════════════════════════════════════════════

console.log('\ndispatcher integration:');

const dispatcherPath = path.join(__dirname, 'contracts-hook.js');

if (!fs.existsSync(dispatcherPath)) {
  console.log('  \x1b[33m-\x1b[0m dispatcher not yet built — skipping integration tests');
} else {
  function runHook(input) {
    try {
      const result = execSync(`node "${dispatcherPath}"`, {
        input: JSON.stringify(input),
        timeout: 10000,
        encoding: 'utf8',
      });
      return JSON.parse(result);
    } catch (e) {
      if (e.stdout) {
        try { return JSON.parse(e.stdout); } catch (_) { /* fall through */ }
      }
      throw e;
    }
  }

  function decision(res) {
    // Support both hookSpecificOutput.permissionDecision (Claude Code shape)
    // and a flat { allow } shape returned by the check modules.
    if (res && res.hookSpecificOutput && res.hookSpecificOutput.permissionDecision) {
      return res.hookSpecificOutput.permissionDecision;
    }
    if (res && typeof res.allow === 'boolean') return res.allow ? 'allow' : 'deny';
    return null;
  }

  // s1 — allow (exempt path)
  const d1a = runHook({
    tool_name: 'Write',
    tool_input: {
      file_path: '/repo/tests/api.test.py',
      content: 'BASE = "http://localhost:8080"',
    },
  });
  assert(decision(d1a) === 'allow', 'dispatcher: s1 allows test file with localhost');

  // s1 — deny (localhost in .py)
  const d1d = runHook({
    tool_name: 'Write',
    tool_input: {
      file_path: '/repo/src/api.py',
      content: 'URL = "http://localhost:8080"',
    },
  });
  assert(decision(d1d) === 'deny', 'dispatcher: s1 denies localhost in .py');

  // s3 — allow
  const d3a = runHook({
    tool_name: 'Bash',
    tool_input: { command: 'git commit -m "fix"' },
  });
  assert(decision(d3a) === 'allow', 'dispatcher: s3 allows normal git commit');

  // s3 — deny (--no-verify)
  const d3d = runHook({
    tool_name: 'Bash',
    tool_input: { command: 'git commit --no-verify -m "x"' },
  });
  assert(decision(d3d) === 'deny', 'dispatcher: s3 denies --no-verify');

  // s6 — allow
  const d6a = runHook({
    tool_name: 'Bash',
    tool_input: { command: 'git commit -m "fix: bug"' },
  });
  assert(decision(d6a) === 'allow', 'dispatcher: s6 allows clean commit message');

  // s6 — deny (Claude attribution)
  const d6d = runHook({
    tool_name: 'Bash',
    tool_input: { command: 'git commit -m "fix\n\nCo-Authored-By: Claude <noreply@anthropic.com>"' },
  });
  assert(decision(d6d) === 'deny', 'dispatcher: s6 denies Claude attribution');

  // s7 — allow
  const d7a = runHook({
    tool_name: 'Bash',
    tool_input: { command: 'rm somefile.txt' },
  });
  assert(decision(d7a) === 'allow', 'dispatcher: s7 allows rm of single file');

  // s7 — deny (rm -rf)
  const d7d = runHook({
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf /tmp/foo' },
  });
  assert(decision(d7d) === 'deny', 'dispatcher: s7 denies rm -rf');
}

// ═════════════════════════════════════════════════════════════
// Summary
// ═════════════════════════════════════════════════════════════

console.log(`\n${'─'.repeat(48)}`);
console.log(`  Total: \x1b[32m${passed} passed\x1b[0m, \x1b[${failed > 0 ? '31' : '32'}m${failed} failed\x1b[0m`);
console.log('');

process.exit(failed > 0 ? 1 : 0);
