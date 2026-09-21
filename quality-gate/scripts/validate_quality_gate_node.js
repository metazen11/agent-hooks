#!/usr/bin/env node
/**
 * validate_quality_gate_node.js — Node.js fallback validator
 *
 * Validates quality gate JSON output against the schema + business rules.
 * No npm dependencies — uses inline schema validation.
 *
 * Usage:
 *   node scripts/validate_quality_gate_node.js path/to/plan.json
 *   cat plan.json | node scripts/validate_quality_gate_node.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const SCHEMA_PATH = path.resolve(__dirname, '..', 'schemas', 'quality-gate-output.schema.json');

// ── Minimal JSON Schema Draft-7 validator (no deps) ─────────
// Validates required fields, types, enums, minItems, minLength, const, conditional

function validateSchema(data, schema, pathStr) {
  const errors = [];
  pathStr = pathStr || '(root)';

  if (schema.type === 'object' && typeof data !== 'object') {
    errors.push(`SCHEMA: ${pathStr} — expected object, got ${typeof data}`);
    return errors;
  }
  if (schema.type === 'array' && !Array.isArray(data)) {
    errors.push(`SCHEMA: ${pathStr} — expected array, got ${typeof data}`);
    return errors;
  }
  if (schema.type === 'string' && typeof data !== 'string') {
    errors.push(`SCHEMA: ${pathStr} — expected string, got ${typeof data}`);
    return errors;
  }
  if (schema.type === 'integer' && (!Number.isInteger(data))) {
    errors.push(`SCHEMA: ${pathStr} — expected integer, got ${typeof data}`);
    return errors;
  }
  if (schema.type === 'boolean' && typeof data !== 'boolean') {
    errors.push(`SCHEMA: ${pathStr} — expected boolean, got ${typeof data}`);
    return errors;
  }

  // const
  if (schema.const !== undefined && data !== schema.const) {
    errors.push(`SCHEMA: ${pathStr} — must be ${JSON.stringify(schema.const)}`);
  }

  // enum
  if (schema.enum && !schema.enum.includes(data)) {
    errors.push(`SCHEMA: ${pathStr} — must be one of: ${schema.enum.join(', ')}`);
  }

  // minLength
  if (schema.minLength && typeof data === 'string' && data.length < schema.minLength) {
    errors.push(`SCHEMA: ${pathStr} — minimum length ${schema.minLength}, got ${data.length}`);
  }

  // minItems
  if (schema.minItems && Array.isArray(data) && data.length < schema.minItems) {
    errors.push(`SCHEMA: ${pathStr} — minimum ${schema.minItems} items, got ${data.length}`);
  }

  // required fields
  if (schema.required && schema.type === 'object' && typeof data === 'object') {
    for (const field of schema.required) {
      if (data[field] === undefined) {
        errors.push(`SCHEMA: ${pathStr}.${field} — required field missing`);
      }
    }
  }

  // properties
  if (schema.properties && typeof data === 'object') {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (data[key] !== undefined) {
        errors.push(...validateSchema(data[key], propSchema, `${pathStr}.${key}`));
      }
    }
  }

  // array items
  if (schema.items && Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) {
      errors.push(...validateSchema(data[i], schema.items, `${pathStr}[${i}]`));
    }
  }

  // conditional: if/then
  if (schema.if && schema.then) {
    const ifProps = schema.if.properties || {};
    let conditionMet = true;
    for (const [key, cond] of Object.entries(ifProps)) {
      if (cond.const !== undefined && data[key] !== cond.const) {
        conditionMet = false;
      }
    }
    if (conditionMet && schema.then.required) {
      for (const field of schema.then.required) {
        if (!data[field] || (typeof data[field] === 'string' && !data[field].trim())) {
          errors.push(`SCHEMA: ${pathStr}.${field} — required when verdict is '${data.verdict}'`);
        }
      }
    }
  }

  return errors;
}

// ── Business rules ──────────────────────────────────────────

const BUSINESS_RULES = [
  {
    name: 'blocked_verdict_requires_reason',
    check: (d) => d.verdict !== 'blocked' || (d.block_reason && d.block_reason.trim().length > 0),
    message: "Verdict is 'blocked' but block_reason is empty.",
  },
  {
    name: 'no_empty_security_risks',
    check: (d) => d.security_review.risks.every((r) => r.trim().length > 5),
    message: 'Security risks contain empty or trivially short entries (>5 chars required).',
  },
  {
    name: 'canonical_names_present',
    check: (d) => d.refined_plan.canonical_names && Object.keys(d.refined_plan.canonical_names).length > 0,
    message: 'Refined plan is missing canonical_names mapping.',
  },
  {
    name: 'all_acceptance_testable',
    check: (d) => d.acceptance_criteria.every((ac) => ac.testable === true),
    message: 'All acceptance criteria must have testable: true.',
  },
  {
    name: 'minimum_acceptance_criteria',
    check: (d) => d.acceptance_criteria.length >= 3,
    message: 'Need at least 3 acceptance criteria for a production plan.',
  },
  {
    name: 'source_reference_real_id',
    check: (d) => d.source_reference.id.trim().length > 0 && d.source_reference.id.trim().toUpperCase() !== 'TBD',
    message: "source_reference.id is empty or 'TBD'. Must reference a real issue/task.",
  },
  {
    name: 'definition_of_done_not_generic',
    check: (d) => !d.definition_of_done.some((item) => item.toLowerCase().trim() === 'all tests pass'),
    message: "definition_of_done contains generic entries like 'all tests pass'. Be specific.",
  },
  {
    name: 'non_goals_are_specific',
    check: (d) => d.refined_plan.non_goals.every((ng) => ng.trim().length > 5),
    message: 'non_goals contain empty or trivially short entries.',
  },
  {
    name: 'failure_modes_have_recovery',
    check: (d) => d.failure_modes.every((fm) => fm.recovery.trim().length > 5),
    message: 'All failure modes must have a specific recovery strategy.',
  },
];

// ── Main ────────────────────────────────────────────────────

function validate(data) {
  const errors = [];

  // Load schema
  let schema;
  try {
    schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  } catch (e) {
    errors.push(`SCHEMA: Cannot load schema — ${e.message}`);
    return errors;
  }

  // Schema validation
  errors.push(...validateSchema(data, schema, '(root)'));

  // Business rules (only if schema passed)
  if (errors.length === 0) {
    for (const rule of BUSINESS_RULES) {
      try {
        if (!rule.check(data)) {
          errors.push(`RULE [${rule.name}]: ${rule.message}`);
        }
      } catch (e) {
        errors.push(`RULE [${rule.name}]: Check failed — ${e.message}`);
      }
    }
  }

  return errors;
}

function main() {
  let raw, label;

  if (process.argv[2]) {
    const filepath = process.argv[2];
    if (!fs.existsSync(filepath)) {
      process.stderr.write(`ERROR: File not found: ${filepath}\n`);
      process.exit(1);
    }
    raw = fs.readFileSync(filepath, 'utf8');
    label = filepath;
  } else {
    // Read from stdin
    raw = '';
    const chunks = [];
    const buf = Buffer.alloc(4096);
    let n;
    try {
      while ((n = fs.readSync(0, buf, 0, buf.length, null)) > 0) {
        chunks.push(buf.slice(0, n).toString());
      }
    } catch {}
    raw = chunks.join('');
    label = 'stdin';
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`FAIL [${label}]: Invalid JSON — ${e.message}\n`);
    process.exit(1);
  }

  const errors = validate(data);

  if (errors.length > 0) {
    process.stderr.write(`FAIL [${label}] — ${errors.length} violation(s):\n\n`);
    for (const err of errors) {
      process.stderr.write(`  * ${err}\n`);
    }
    process.exit(1);
  } else {
    const verdict = data.verdict || 'unknown';
    console.log(`PASS [${label}] — verdict: ${verdict}`);
    if (verdict === 'needs_refinement') {
      const gaps = (data.gaps_found || []).length;
      console.log(`  Needs refinement — ${gaps} gap(s) identified.`);
    }
    process.exit(0);
  }
}

main();
