<!-- pre-commit-hook-start -->
## Pre-Commit Quality Gate

Before running `git_commit` or any bash command containing `git commit`, you MUST run the pre-commit quality check:

```bash
bash "{{PRECOMMIT_PATH}}"
```

Rules:
- If the script exits with code 1 (errors found), fix all errors before committing
- If only warnings are reported (exit code 0), review them but proceed with the commit
- Never bypass the check unless the user explicitly requests it
- Run the check against the project workspace directory
<!-- pre-commit-hook-end -->
