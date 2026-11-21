# Iron Rules

Non-negotiable engineering rules. The `iron-rules` hook injects the **Digest**
below into context at session start and every N user turns thereafter.

Edit this file to change what gets injected — the hook parses the Digest
section, so no code change is needed. Keep each line on ONE line, starting
with `- `, in `NAME — text` form.

## Digest

- ROOT CAUSE — fix the cause, never the symptom. Name the mechanism (line/key/column/missing guard). Never widen a limit, swallow an exception, or skip a test to make things green.
- TDD — write the test first and SEE IT RED against the unfixed code. A guard never seen red proves nothing.
- DRY — extract, do not repeat. Third occurrence becomes a function. One owner per concept, one canonical name — grep before inventing; a second spelling is a second implementation.
- CANONICAL — always simplify and use the canonical name (DRY + ponytail). Shortest working diff, stdlib-first, no alias/synonym that hides the owner.
- OPTIMIZE — always optimize tests and token usage. Same-level suite, per-worktree DB, no duplicate fixtures, shortest prompts that still carry evidence.
- SIMPLEST — the simplest thing that actually works. No speculative abstraction, no unused flexibility.
- RIGHT THE FIRST TIME — do it properly now; shortcuts cost more later than they save today.
- SENIOR BAR — production-finished, not demo-finished: errors handled, inputs validated, docs updated.
- VERIFY — done means measured against the live end state with evidence, not "the code is written".
- PUSH BACK — say so plainly when the approach is wrong, then the USER HAS FINAL SAY. Once they reaffirm, build it in full.

## Detail

### ROOT CAUSE
A change that makes the symptom disappear while the cause survives is not a fix,
it is a disguise — and it makes the next occurrence harder to find than the
first. Before calling anything fixed, answer: what is the mechanism (the
specific line, config key, schema column, env var, or missing guard)? Why did it
reach production? Where else does the same cause live (grep before closing)?
What prevents recurrence?

Never ship as a "fix": widening a limit/threshold/timeout so a real failure
stops tripping it; swallowing an exception to make output green; skipping or
`xfail`-ing a test that legitimately caught something; editing the INSTALLED
copy of an artifact whose SOURCE lives in a repo; patching a generated file
instead of its generator.

Prefer eliminating the *class*: impossible > compile-time error > test failure
> runtime alarm > documentation > convention.

### TDD
Run the new test against the UNFIXED code and watch it FAIL, then against the
fix and watch it pass. Freezing a clock or stubbing a dependency can quietly
turn a real assertion into a tautology — a test that has never been red proves
nothing about the bug it claims to guard.

### DRY
Extract shared logic rather than copying it. Two occurrences is a coincidence;
the third means it becomes a function. But do not abstract across things that
merely *look* alike — coincidental similarity that diverges later is worse than
duplication.

### CANONICAL
Always simplify and use the canonical name. This is contractual: one concept → one implementation → one spelling, in code, docs, and configs. Before adding a helper, flag, or table, grep for the concept; if it exists, import and reuse it exactly as spelled. If it exists but is wrong, fix the owner — never fork or alias it. A second name hides drift, and drift has changed verdicts (buy_and_hold_pct short inversion, L026 → UNG alpha −58pp; fold cutting L021). Ponytail's lean rule is the same: deletion beats addition, shortest working diff that is still readable, stdlib-first, no wrapper/alias/option/config for later. A violation is a defect, not style.

### SIMPLEST
Build the simplest thing that actually solves the stated problem. No
speculative generality, no configuration nobody asked for, no abstraction layer
for a second implementation that does not exist.

### RIGHT THE FIRST TIME
Doing it properly now is cheaper than doing it twice. This is not a licence to
gold-plate: "right" means correct, handled, and tested — not maximal.

### SENIOR BAR
Production-finished, not demo-finished. Errors handled and surfaced, inputs
validated at boundaries, docs updated alongside the code. Code without updated
docs is not done.

### OPTIMIZE
Always optimize tests and token usage. This is contractual: keep the suite at same-level (no coverage cut, no heavy/crypto skip) but make it fast via per-worktree DB isolation, deletion of superseded legacy tests (shim kept for helpers), and terse prompts that carry evidence (links, not dumps). Token and time are cost; ponytail's lean rule is the same — shortest working diff that is still readable. A slow suite that still runs is not optimized.

### VERIFY
"I made the change" is not done. "It should work" is not done. Done means the
live end state was queried, curled, or measured, and the output proves the
acceptance criteria. Verify the END STATE, not the action: after a migration
query the DB; after a deploy confirm the running system reflects the new code;
after a config change read the live config back. Never round PARTIAL up to DONE.

### PUSH BACK
State the concern plainly in a sentence or two when the approach looks wrong —
then the user decides. Once they reaffirm, treat it as settled and build the
full thing under stated assumptions. Do not re-litigate, and do not quietly
narrow the scope instead of arguing for it.
