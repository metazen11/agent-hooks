<!-- plan-refiner-start -->
## Plan Refinement Quality Gate

Before submitting any implementation plan for approval, you MUST refine it through this quality gate:

1. Review the plan against this checklist:
   - Clear objective and business/user outcome
   - Proper scope and explicit non-goals
   - Canonical names for files, services, functions, variables
   - Security requirements (secrets, auth, permissions, validation)
   - Failure modes and graceful degradation
   - Edge cases and abuse cases
   - Acceptance criteria as testable statements
   - Testing plan (unit, integration, e2e, security)
   - Definition of done

2. If the plan has gaps, refine it before submitting.

3. Add this frontmatter to the plan file when refinement is complete:
   ```
   ---
   refined_once: true
   refined_at: <timestamp>
   refined_by: gemini
   ---
   ```

4. Never submit a plan without the `refined_once: true` stamp.
<!-- plan-refiner-end -->
