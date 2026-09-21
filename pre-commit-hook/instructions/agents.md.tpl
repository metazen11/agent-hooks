<!-- pre-commit-hook-start -->
## Pre-Commit Quality Gate

Before running `git commit`, you MUST run the pre-commit quality check:

```bash
bash "{{PRECOMMIT_PATH}}"
```

Rules:
- If the script exits with code 1 (errors found), fix all errors before committing
- If only warnings are reported (exit code 0), review them but proceed with the commit
- Never use `git commit --no-verify` to bypass unless the user explicitly requests it
- Run the check against the same working directory where git is operating
<!-- pre-commit-hook-end -->
