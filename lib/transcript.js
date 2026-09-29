'use strict';
/**
 * transcript.js — shared transcript reading for hooks.
 *
 * Extracted because three copies of this logic existed (iron-rules,
 * context-primer, and the self-update turn counter that never shipped), and
 * a bug fixed in one did NOT propagate: iron-rules stopped counting tool
 * results as user turns; context-primer kept counting them for another week.
 * Per the DRY rule, the third occurrence becomes a function.
 *
 * Two problems are fixed here, not one:
 *
 * 1. CORRECTNESS. Claude Code writes every TOOL RESULT as a `"type":"user"`
 *    line, and injects `isMeta` lines of its own. Counting them overcounts
 *    real prompts ~9x and NON-UNIFORMLY, because the excess tracks however
 *    many tools the previous turn used. A throttle built on that fires in
 *    bursts: measured, three turns in a row then silence for 31.
 *
 * 2. MEMORY. The old code did `readFileSync(whole file).split('\n')` on every
 *    UserPromptSubmit — 277MB RSS on a 51MB transcript, and both hooks fire
 *    on the same turn, so a long session paid ~550MB of transient allocation
 *    per turn. Time was never the risk (133ms against a 5s timeout); memory
 *    was.
 *
 * Strategy: stream the file in chunks so nothing holds the whole thing, and
 * cache the count keyed by (inode, size) so an unchanged file costs a stat
 * and a growing one costs only the appended bytes. A transcript that SHRANK
 * or changed inode was rewritten (compaction) — that falls back to a full
 * re-count, because an incremental count over rewritten content is wrong.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const CACHE_DIR = path.join(os.homedir(), '.claude', 'state', 'transcript-count');
const CHUNK = 1 << 20; // 1 MiB

/** Does this JSONL line represent a real user turn? */
function isUserTurn(line) {
    // Cheap pre-filter before JSON.parse — most lines are not user lines.
    if (line.indexOf('"type":"user"') === -1 && line.indexOf('"type": "user"') === -1) {
        return false;
    }
    let o;
    try {
        o = JSON.parse(line);
    } catch {
        return false; // malformed / partial line
    }
    if (o.type !== 'user') return false;
    if (o.toolUseResult !== undefined) return false; // a tool result, not a turn
    if (o.isMeta) return false;                      // harness-injected
    return true;
}

/**
 * Count user turns in [start, end) of `fd`, streaming in CHUNK-sized reads.
 * Returns {count, consumed} where `consumed` is the offset just past the last
 * COMPLETE line — a trailing partial line is left for the next call.
 */
function countRange(fd, start, end) {
    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = start;
    let carry = '';
    let count = 0;
    let consumed = start;

    while (pos < end) {
        const want = Math.min(CHUNK, end - pos);
        const got = fs.readSync(fd, buf, 0, want, pos);
        if (got <= 0) break;
        pos += got;

        const text = carry + buf.toString('utf8', 0, got);
        const lines = text.split('\n');
        carry = lines.pop();            // possibly-incomplete trailing line

        for (const line of lines) {
            if (isUserTurn(line)) count++;
        }
        // Everything before the carry is fully consumed.
        consumed = pos - Buffer.byteLength(carry, 'utf8');
    }

    return { count, consumed };
}

/**
 * A cheap fingerprint of the first and last bytes of the already-counted
 * prefix. (inode, size) alone is NOT enough: a transcript rewritten in place
 * to the same length keeps both, and the cached count would be stale. Reading
 * 64 bytes from each end is far cheaper than re-counting and catches any
 * realistic rewrite.
 */
function headSignature(file, consumed) {
    if (consumed <= 0) return '0';
    let fd;
    try {
        fd = fs.openSync(file, 'r');
        const n = Math.min(64, consumed);
        const head = Buffer.allocUnsafe(n);
        fs.readSync(fd, head, 0, n, 0);
        const tail = Buffer.allocUnsafe(n);
        fs.readSync(fd, tail, 0, n, Math.max(0, consumed - n));
        return `${consumed}:${head.toString('base64')}:${tail.toString('base64')}`;
    } catch {
        return null;   // unreadable -> cache miss -> full re-count
    } finally {
        try { if (fd !== undefined) fs.closeSync(fd); } catch { /* ignore */ }
    }
}


function cacheFile(transcriptPath) {
    // Key by path so two transcripts never collide; hash keeps it filesystem-safe.
    let h = 0;
    for (let i = 0; i < transcriptPath.length; i++) {
        h = (h * 31 + transcriptPath.charCodeAt(i)) | 0;
    }
    return path.join(CACHE_DIR, `${(h >>> 0).toString(36)}.json`);
}

function readCache(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

function writeCache(file, data) {
    try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, file);       // atomic; concurrent hooks cannot tear it
    } catch {
        /* the cache is an optimisation, never a requirement */
    }
}

/**
 * Count real user turns in a transcript.
 *
 * Returns 0 when the file is missing or unreadable, which makes callers a
 * no-op rather than firing on every turn.
 */
function countUserTurns(transcriptPath, opts = {}) {
    if (!transcriptPath) return 0;

    const useCache = opts.cache !== false;
    let st;
    try {
        st = fs.statSync(transcriptPath);
    } catch {
        return 0;
    }
    if (!st.isFile()) return 0;

    const cf = cacheFile(transcriptPath);
    const cached = useCache ? readCache(cf) : null;

    let start = 0;
    let base = 0;
    if (
        cached &&
        cached.ino === st.ino &&
        cached.consumed <= st.size &&
        typeof cached.count === 'number' &&
        cached.head === headSignature(transcriptPath, cached.consumed)
    ) {
        // Same file, not shrunk, and the prefix we already counted is still
        // byte-identical: count only what was appended.
        start = cached.consumed;
        base = cached.count;
    }
    // Otherwise: new file, it shrank, changed inode, or was REWRITTEN IN PLACE
    // (compaction can produce the same inode AND the same size — a regression
    // test caught exactly that returning a stale count). Start over; an
    // incremental count over rewritten content is wrong.

    if (start === st.size) return base; // unchanged since last call: stat only

    let fd;
    try {
        fd = fs.openSync(transcriptPath, 'r');
    } catch {
        return base;
    }
    try {
        const { count, consumed } = countRange(fd, start, st.size);
        const total = base + count;
        if (useCache) {
            writeCache(cf, {
                ino: st.ino,
                consumed,
                count: total,
                size: st.size,
                head: headSignature(transcriptPath, consumed),
            });
        }
        return total;
    } catch {
        return base;
    } finally {
        try { fs.closeSync(fd); } catch { /* ignore */ }
    }
}

module.exports = { countUserTurns, isUserTurn };
