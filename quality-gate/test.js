#!/usr/bin/env node
/**
 * test.js — Unit tests for quality-gate validators
 *
 * Tests both Python and Node.js validators against valid/invalid plan JSON.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execSync } = require('child_process');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m  ${msg}`);
    passed++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m  ${msg}`);
    failed++;
  }
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'quality-gate-test-'));
}

// ── Fixtures ────────────────────────────────────────────────

const VALID_PLAN = {
  verdict: 'approved',
  source_reference: { system: 'github', id: 'GH-142', url: 'https://github.com/org/repo/issues/142' },
  summary: 'Add NERIS ingestion pipeline for wildfire incident data from the national database.',
  gaps_found: [],
  refined_plan: {
    objective: 'Build a NERIS data ingestion pipeline that pulls incident records nightly.',
    scope: 'ETL pipeline from NERIS API to local PostgreSQL with deduplication.',
    non_goals: ['Real-time streaming ingestion', 'UI changes for NERIS data display'],
    canonical_names: {
      service: 'neris-ingestion-etl',
      table: 'neris_incidents',
      script: 'scripts/ingest_neris.py',
      config: 'config/neris.yaml',
    },
    system_boundaries: [
      { boundary: 'NERIS API', integration_point: 'REST API with API key auth' },
    ],
    steps: [
      { step_number: 1, action: 'Create neris_incidents table migration', owner: 'dev', deliverable: 'SQL migration file' },
      { step_number: 2, action: 'Implement ETL script', owner: 'dev', deliverable: 'scripts/ingest_neris.py' },
      { step_number: 3, action: 'Add cron schedule', owner: 'dev', deliverable: 'crontab entry', depends_on: [2] },
    ],
  },
  acceptance_criteria: [
    { criterion: 'ETL pulls at least 1000 records from NERIS API in test run', testable: true, verification_method: 'Run script, count rows' },
    { criterion: 'Duplicate records are detected and skipped by incident_id', testable: true, verification_method: 'Insert same batch twice, verify count unchanged' },
    { criterion: 'Failed API calls retry 3 times with exponential backoff', testable: true, verification_method: 'Mock API failure, verify retry logs' },
  ],
  testing_plan: {
    unit: ['Test deduplication logic with duplicate incident_ids'],
    integration: ['Test full ETL pipeline against NERIS sandbox API'],
    e2e: ['Run nightly cron simulation end-to-end'],
    negative: ['Test with invalid API key — verify graceful error'],
    regression: ['N/A — new feature'],
  },
  security_review: {
    risks: ['NERIS API key stored in environment — could leak in logs'],
    controls: ['API key loaded from env var, never logged, rotated quarterly'],
    secrets_handling: 'API key in NERIS_API_KEY env var, never in code or config files',
    auth_requirements: 'NERIS API requires Bearer token auth',
    least_privilege: 'ETL service account has INSERT-only on neris_incidents table',
  },
  compliance_review: {
    applicable_frameworks: ['CJIS'],
    requirements: ['Incident data must be stored in CJIS-compliant database'],
    audit_trail: 'All ETL runs logged with timestamp, record count, and status',
  },
  edge_cases: [
    { case: 'NERIS API returns empty dataset', expected_behavior: 'Log warning, exit 0, no table changes' },
    { case: 'Network timeout during pagination', expected_behavior: 'Retry current page 3 times, then fail gracefully' },
  ],
  failure_modes: [
    { failure: 'NERIS API is down', degradation: 'Skip ingestion, alert on-call', recovery: 'Automatic retry on next cron run, manual trigger available' },
    { failure: 'Database connection lost mid-ingestion', degradation: 'Transaction rollback, no partial data', recovery: 'Reconnect and retry full batch on next run' },
  ],
  observability: {
    logs: ['ETL start/end with duration', 'Per-batch record counts', 'Error details with stack trace'],
    metrics: ['neris_etl_records_ingested', 'neris_etl_duration_seconds', 'neris_etl_errors_total'],
    alerts: ['neris_etl_errors_total > 0 for 2 consecutive runs'],
    traces: [],
    error_messages: ['NERIS ingestion failed: {error}. Manual retry: python scripts/ingest_neris.py --force'],
  },
  deployment: {
    steps: ['Run migration: alembic upgrade head', 'Deploy ETL script to cron host', 'Add crontab entry'],
    rollback: ['Remove crontab entry', 'Run migration: alembic downgrade -1', 'Remove ETL script'],
    backward_compatibility: 'No impact — new table and script only',
    migration: 'New table neris_incidents, no existing data affected',
  },
  definition_of_done: [
    'ETL script ingests NERIS data successfully in staging environment',
    'Deduplication verified with repeated batch import',
    'Cron schedule fires on time in staging for 3 consecutive runs',
    'Monitoring dashboard shows metrics for neris_etl namespace',
  ],
  documentation: {
    updates_needed: ['README: add NERIS ingestion section', 'RUNBOOK: add ETL troubleshooting steps'],
    changelog_entry: 'Added NERIS incident data ingestion pipeline',
    ticket_notes: 'Closes GH-142',
  },
  improvements: {
    docs_to_update: ['docs/agents.md — add NERIS API patterns'],
    proposed_ci_checks: ['Lint ETL scripts for SQL injection patterns'],
    agents_md_additions: ['NERIS API uses pagination with max 500 records/page'],
  },
};

function writeFixture(dir, name, data) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

// ── Node.js validator tests ─────────────────────────────────

console.log('\nNode.js validator:');

const nodeValidator = path.join(__dirname, 'scripts', 'validate_quality_gate_node.js');
const dir1 = tmpDir();

function runNodeValidator(file) {
  try {
    execSync(`node "${nodeValidator}" "${file}"`, { encoding: 'utf8', stdio: 'pipe' });
    return { pass: true, output: '' };
  } catch (e) {
    return { pass: false, output: (e.stderr || '').toString() };
  }
}

// Valid plan passes
const validFile = writeFixture(dir1, 'valid.json', VALID_PLAN);
const r1 = runNodeValidator(validFile);
assert(r1.pass === true, 'valid plan passes');

// Missing required field
const missingVerdict = { ...VALID_PLAN };
delete missingVerdict.verdict;
const f2 = writeFixture(dir1, 'no-verdict.json', missingVerdict);
const r2 = runNodeValidator(f2);
assert(r2.pass === false, 'missing verdict rejected');

// Blocked without reason
const blockedNoReason = { ...VALID_PLAN, verdict: 'blocked' };
delete blockedNoReason.block_reason;
const f3 = writeFixture(dir1, 'blocked-no-reason.json', blockedNoReason);
const r3 = runNodeValidator(f3);
assert(r3.pass === false, 'blocked without reason rejected');

// Blocked with reason passes
const blockedWithReason = { ...VALID_PLAN, verdict: 'blocked', block_reason: 'Dangerous migration without rollback plan' };
const f4 = writeFixture(dir1, 'blocked-with-reason.json', blockedWithReason);
const r4 = runNodeValidator(f4);
assert(r4.pass === true, 'blocked with reason passes');

// TBD source reference
const tbdRef = JSON.parse(JSON.stringify(VALID_PLAN));
tbdRef.source_reference.id = 'TBD';
const f5 = writeFixture(dir1, 'tbd-ref.json', tbdRef);
const r5 = runNodeValidator(f5);
assert(r5.pass === false, 'TBD source_reference.id rejected');
assert(r5.output.includes('source_reference_real_id'), 'error names the rule');

// Generic definition of done
const genericDod = JSON.parse(JSON.stringify(VALID_PLAN));
genericDod.definition_of_done = ['all tests pass', 'code reviewed', 'deployed'];
const f6 = writeFixture(dir1, 'generic-dod.json', genericDod);
const r6 = runNodeValidator(f6);
assert(r6.pass === false, 'generic DoD rejected');

// Missing canonical names
const noCanonical = JSON.parse(JSON.stringify(VALID_PLAN));
delete noCanonical.refined_plan.canonical_names;
const f7 = writeFixture(dir1, 'no-canonical.json', noCanonical);
const r7 = runNodeValidator(f7);
assert(r7.pass === false, 'missing canonical_names rejected');

// Untestable acceptance criteria
const untestable = JSON.parse(JSON.stringify(VALID_PLAN));
untestable.acceptance_criteria[0].testable = false;
const f8 = writeFixture(dir1, 'untestable.json', untestable);
const r8 = runNodeValidator(f8);
assert(r8.pass === false, 'untestable AC rejected');

// Too few acceptance criteria
const fewAC = JSON.parse(JSON.stringify(VALID_PLAN));
fewAC.acceptance_criteria = [fewAC.acceptance_criteria[0]];
const f9 = writeFixture(dir1, 'few-ac.json', fewAC);
const r9 = runNodeValidator(f9);
assert(r9.pass === false, 'fewer than 3 AC rejected');

// Invalid JSON
fs.writeFileSync(path.join(dir1, 'bad.json'), '{not valid json');
const r10 = runNodeValidator(path.join(dir1, 'bad.json'));
assert(r10.pass === false, 'invalid JSON rejected');

// ── Python validator tests (if available) ───────────────────

let hasPython = false;
try {
  execSync('python3 -c "import jsonschema"', { stdio: 'pipe' });
  hasPython = true;
} catch {}

if (hasPython) {
  console.log('\nPython validator:');

  const pyValidator = path.join(__dirname, 'scripts', 'validate_quality_gate.py');

  function runPyValidator(file) {
    try {
      execSync(`python3 "${pyValidator}" "${file}"`, { encoding: 'utf8', stdio: 'pipe' });
      return { pass: true };
    } catch (e) {
      return { pass: false, output: (e.stderr || '').toString() };
    }
  }

  const pr1 = runPyValidator(validFile);
  assert(pr1.pass === true, 'valid plan passes (Python)');

  const pr2 = runPyValidator(f2);
  assert(pr2.pass === false, 'missing verdict rejected (Python)');

  const pr3 = runPyValidator(f3);
  assert(pr3.pass === false, 'blocked without reason rejected (Python)');

  const pr4 = runPyValidator(f4);
  assert(pr4.pass === true, 'blocked with reason passes (Python)');

  const pr5 = runPyValidator(f5);
  assert(pr5.pass === false, 'TBD reference rejected (Python)');

  const pr6 = runPyValidator(f6);
  assert(pr6.pass === false, 'generic DoD rejected (Python)');

  const pr7 = runPyValidator(f7);
  assert(pr7.pass === false, 'missing canonical_names rejected (Python)');

  const pr8 = runPyValidator(f8);
  assert(pr8.pass === false, 'untestable AC rejected (Python)');
} else {
  console.log('\nPython validator: SKIPPED (jsonschema not installed)');
}

// ── Install wizard tests ────────────────────────────────────

console.log('\ninstall wizard:');

const testRepo = tmpDir();
execSync('git init', { cwd: testRepo, stdio: 'pipe' });
fs.writeFileSync(path.join(testRepo, 'CLAUDE.md'), '# My Project\n');

const installScript = path.join(__dirname, 'install.js');

// Install git + claude
execSync(`node "${installScript}" --project="${testRepo}" --target=git,claude --all`, { stdio: 'pipe' });

assert(fs.existsSync(path.join(testRepo, 'schemas', 'quality-gate-output.schema.json')), 'schema copied');
assert(fs.existsSync(path.join(testRepo, 'scripts', 'validate_quality_gate_node.js')), 'node validator copied');
assert(fs.existsSync(path.join(testRepo, 'plans', '.gitkeep')), 'plans/ created');

const claudeMd = fs.readFileSync(path.join(testRepo, 'CLAUDE.md'), 'utf8');
assert(claudeMd.includes('quality-gate-start'), 'CLAUDE.md has quality gate fragment');

// Idempotent
execSync(`node "${installScript}" --project="${testRepo}" --target=claude`, { stdio: 'pipe' });
const claudeMd2 = fs.readFileSync(path.join(testRepo, 'CLAUDE.md'), 'utf8');
const count = (claudeMd2.match(/quality-gate-start/g) || []).length;
assert(count === 1, 'idempotent install (no duplicate)');

// Uninstall
execSync(`node "${installScript}" --project="${testRepo}" --target=git,claude --uninstall`, { stdio: 'pipe' });
assert(!fs.existsSync(path.join(testRepo, 'schemas', 'quality-gate-output.schema.json')), 'schema removed');
const claudeMd3 = fs.readFileSync(path.join(testRepo, 'CLAUDE.md'), 'utf8');
assert(!claudeMd3.includes('quality-gate-start'), 'CLAUDE.md fragment removed');

// ── Summary ─────────────────────────────────────────────────

console.log(`\n${'─'.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('');

// Cleanup
fs.rmSync(dir1, { recursive: true, force: true });
fs.rmSync(testRepo, { recursive: true, force: true });

process.exit(failed > 0 ? 1 : 0);
