#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// env-write.js  —  Set a key=value in a .env file safely
// ─────────────────────────────────────────────────────────────
//
//  Usage:  node env-write.js <file> <KEY> <VALUE>
//
//  - If KEY exists  → replaces that line
//  - If KEY is new  → appends it
//  - Output: confirmation only (never prints the value)
//
// ─────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');

// ── Parse args ───────────────────────────────────────────────

const [,, filePath, key, ...valueParts] = process.argv;
const value = valueParts.join(' ');

if (!filePath || !key) {
  console.error('Usage: node env-write.js <file> <KEY> <VALUE>');
  process.exit(1);
}

if (!fs.existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

// ── Read → update → write ────────────────────────────────────

const lines   = fs.readFileSync(filePath, 'utf8').split('\n');
const pattern  = new RegExp(`^${key}=`);
let   replaced = false;

const updated = lines.map((line) => {
  if (pattern.test(line)) {
    replaced = true;
    return `${key}=${value}`;
  }
  return line;
});

// Append if key didn't exist yet
if (!replaced) {
  const last = updated[updated.length - 1];
  if (last === '') {
    updated.splice(updated.length - 1, 0, `${key}=${value}`);
  } else {
    updated.push(`${key}=${value}`);
  }
}

fs.writeFileSync(filePath, updated.join('\n'), 'utf8');

// ── Confirm (no value shown) ─────────────────────────────────

const action   = replaced ? 'updated' : 'added';
const filename = path.basename(filePath);
console.log(`OK: ${key} ${action} in ${filename} (${value.length} chars)`);
