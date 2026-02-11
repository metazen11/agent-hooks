#!/usr/bin/env node
/**
 * Memory Context Hook - SessionStart
 *
 * Queries claude-mem SQLite database for the 3 most recent observations
 * matching the current project folder and injects them as session context.
 *
 * LOCATION: ~/.claude/hooks/memory-context.js
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(process.env.HOME, '.claude-mem', 'claude-mem.db');

function readHookInput() {
    try {
        const stdin = fs.readFileSync(0, 'utf8');
        if (stdin) return JSON.parse(stdin);
    } catch (e) {}
    return {};
}

function getProjectName(cwd) {
    // Use the last component of the cwd as the project name
    return path.basename(cwd);
}

function queryRecentMemories(project) {
    if (!fs.existsSync(DB_PATH)) return [];

    try {
        // Query 3 most recent observations for this project
        const query = `SELECT id, title, type, substr(created_at, 1, 19) as ts FROM observations WHERE project = '${project.replace(/'/g, "''")}' ORDER BY created_at DESC LIMIT 3;`;
        const result = execSync(`sqlite3 -json "${DB_PATH}" "${query}"`, {
            encoding: 'utf8',
            timeout: 5000
        });
        return JSON.parse(result || '[]');
    } catch (e) {
        return [];
    }
}

function formatMemories(memories) {
    if (memories.length === 0) return null;

    // Reverse to show chronological order (oldest first)
    const chronological = memories.reverse();
    const lines = chronological.map((m, i) => {
        const date = m.ts.replace('T', ' ');
        const type = m.type ? `[${m.type}]` : '';
        return `  ${i + 1}. ${date} ${type} ${m.title}`;
    });

    return `Recent memory (${memories.length} entries):\n${lines.join('\n')}\n\nTip: Use the claude-mem MCP tools (mcp__plugin_claude-mem_mcp-search__search, timeline, get_observations) to look up more context from past sessions.`;
}

// Main
const hookInput = readHookInput();
const cwd = hookInput.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();

// Skip on 'clear' reason
if (hookInput.reason === 'clear') {
    console.log(JSON.stringify({}));
    process.exit(0);
}

const project = getProjectName(cwd);
const memories = queryRecentMemories(project);
const context = formatMemories(memories);

const output = {};

if (context) {
    output.systemMessage = context;
    // Also write to stderr so it's visible in verbose mode (Ctrl+O)
    console.error(`[memory-context] ${context.replace(/\n/g, '\n[memory-context] ')}`);
}

console.log(JSON.stringify(output));
process.exit(0);
