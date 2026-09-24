## Branching contract

This repo enforces a branching contract: work lands on `dev`, and `dev`
reaches `main` only through a reviewed pull request. Direct pushes to `main`
are refused.

**One-time setup, per machine** (not per clone):

```bash
~/_CODING/hooks/repo-contract/bootstrap.sh
```

After that, every future clone on this machine activates its own hooks
automatically. Working in a single repo, or prefer to do it by hand:

```bash
git config core.hooksPath .githooks
```

Without this step the local pre-push hook is inert — git will not let a clone
activate its own hooks, since that would run a stranger's code on clone.
Server-side branch protection and the `trunk-drift` check still apply
regardless of local setup.

Full contract, including the emergency override: [CONTRIBUTING.md](CONTRIBUTING.md).
