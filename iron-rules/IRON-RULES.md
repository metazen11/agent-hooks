# Iron Rules

Non-negotiable engineering rules. The `iron-rules` hook injects the **Digest**
below into context at session start and every N user turns thereafter.

Edit this file to change what gets injected — the hook parses the Digest
section, so no code change is needed. Keep each line on ONE line, starting
with `- `, in `NAME — text` form.

## Digest

- ROOT CAUSE — fix the cause, never the symptom. Name the mechanism (line/key/column/missing guard). Never widen a limit, swallow an exception, or skip a test to make things green.
- TDD — write the test first and SEE IT RED against the unfixed code. A guard never seen red proves nothing.
- DRY — extract, do not repeat. Third occurrence becomes a function.
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
