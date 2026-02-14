# agent-memory

**Moved to standalone repo:** https://github.com/metazen11/agent-memory

## Install

```bash
git clone https://github.com/metazen11/agent-memory.git
cd agent-memory
node install.js
```

The installer handles everything: Python venv, dependencies, model downloads, Docker, MCP registration, hooks, and skills.

## Commands

```bash
node install.js              # Full setup
node install.js --status     # Check status
node install.js --start      # Start services
node install.js --stop       # Stop services
node install.js --uninstall  # Remove everything
```
