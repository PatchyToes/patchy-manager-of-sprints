---
description: Walk the active sprint's `## Test plan` section as a consolidated UAT checklist. For each issue, render its tests, ask {{OPERATOR}} pass/fail, mark the manifest checkboxes accordingly. Failures reopen the issue with `needs-fix` and post the failure evidence as a comment. Pairs with `/sprint-ship` (run after the batch deploy lands). (Requires: at least one issue in the manifest's ## Test plan section.)
argument-hint: (none)
---

# Sprint Test

{{INCLUDE:glossary}}

You are the **Batch UAT Walker** for the active sprint. /sprint-implement appended a `### #N — title` subsection per shipped issue; this skill walks them as one consolidated session so {{OPERATOR}} verifies the whole sprint in one focused slot rather than per-issue interruption.

**Why this exists:** per-issue testing fragments operator attention across the sprint window. Batched testing concentrates verification into one slot after `/sprint-ship` deploys everything, which is when prod actually reflects the work and tests are most meaningful.

## Phase A: Announce

```
═══ SPRINT · test ═══
Walking the sprint's manual UAT checklist. I'll surface each issue's tests one at a time. Mark each pass/fail; failures get reopened with needs-fix.
```

## Phase 0: Tool-availability gate (fail-closed)

```bash
gh auth status >/dev/null 2>&1 || { echo "Sprint test abort: gh not authenticated."; exit 1; }
```

## Phase 1: Resolve sprint manifest

```bash
SPRINT_MANIFEST=$(ls docs/sprints/S*.md 2>/dev/null | sed -n 's|.*/\(S[0-9]\{1,\}\)\.md|\1|p' | sort -V | tail -1 | xargs -I {} echo "docs/sprints/{}.md")
[ -z "$SPRINT_MANIFEST" ] && SPRINT_MANIFEST=$(ls docs/sprints/*.md 2>/dev/null | grep -v '/archive/' | sort -r | head -1)
[ -f "$SPRINT_MANIFEST" ] || { echo "Sprint test abort: no sprint manifest found."; exit 1; }
```

## Phase 2: Parse the test plan

Read the manifest. Extract every `### #N — title` subsection under the `## Test plan` heading. Build a structure:

```
[
  { issue: 480, title: "Workspace ownership transfer", tests: ["test 1 (golden)", "test 2 (edge)", ...], notes: "tested locally with mocked Stripe" },
  { issue: 484, title: "...", tests: [...], notes: "..." },
  ...
]
```

Each `tests` entry is the literal text of a `- [ ]` checkbox line (without the bracket). Skip already-checked `- [x]` items — they were verified previously (re-runnable).

If the `## Test plan` section is missing or empty:
```
Sprint test: no test plan found in $SPRINT_MANIFEST. Either the sprint has no implementations yet, or /sprint-implement didn't append a test plan (check the manifest manually).
```
Exit 0.

If every checkbox is already `- [x]`: print `Sprint test: every test in this sprint is already verified. Run /sprint-end when ready to close out.` and exit 0.

## Phase 3: Pre-flight summary

```
==========================================
SPRINT-TEST — N issues with M open tests
==========================================

Issues to verify:
  - #480 — title (3 tests)
  - #484 — title (2 tests)
  - #490 — title (4 tests)
  ...

I'll walk each issue's tests one at a time. For each, you confirm pass or describe the failure. Failed issues get reopened with `needs-fix` and the failure evidence is posted as a comment.
```

No sleep, no gating. Proceed to Phase 4.

## Phase 4: Per-issue walk

For each issue in manifest order:

### Step 4.1 — Render the issue's tests

```
─── #N — issue title ───

Tests:
  1. [ ] Golden path test description
  2. [ ] Edge case test description
  3. [ ] Other test

Implementer notes: [whatever was logged]

Issue: https://github.com/<owner>/<repo>/issues/N
```

The issue URL is for the operator to open in browser if they need context (the linked plan, the issue body, etc.).

### Step 4.2 — Ask the operator

Use AskUserQuestion with one question:

> "Did all tests pass for #N?"

Options:
- **Pass** — all tests good, mark all checkboxes as `[x]`
- **Fail** — at least one failed, ask for details
- **Skip** — defer this one (don't mark, don't reopen)

### Step 4.3 — Apply outcome

**On Pass:**
- Edit the manifest: replace each `- [ ]` line in this issue's subsection with `- [x]`. Append `- [x] **Verified $(date -I) by {{OPERATOR}}**` as a final line in the subsection.
- Print: `[N of N_total] #N → PASS`

**On Fail:**
- AskUserQuestion: "Which test(s) failed and what did you see?" — capture the operator's free-text response
- Reopen the issue:
  ```bash
  gh issue reopen N
  gh label create "needs-fix" --color "d93f0b" --description "Shipped but failed at /sprint-test — needs follow-up plan" 2>/dev/null || true
  gh issue edit N --add-label "needs-fix"
  ```
- Post the failure evidence as a comment:
  ```bash
  gh issue comment N --body "**Failed at /sprint-test $(date -I).**

  Test failures:
  [operator's free-text response]

  Issue reopened with \`needs-fix\`. Next sprint or hotfix will plan + implement the corrective work; the failure context above is primary evidence."
  ```
- Edit the manifest: leave checkboxes as `- [ ]`. Append `- ❌ **Failed $(date -I) — reopened with needs-fix**: [one-line summary of what failed]` to the issue's subsection.
- Print: `[N of N_total] #N → FAIL (reopened with needs-fix)`

**On Skip:**
- No manifest edit, no label change.
- Print: `[N of N_total] #N → SKIPPED (re-run /sprint-test to revisit)`

### Step 4.4 — Continue

Move to the next issue. Don't summarize between issues — that's noise. The per-issue status line is the marker.

## Phase 5: Final summary

```
==========================================
SPRINT-TEST COMPLETE
==========================================

Verified: K of N
  - Passed: #N1, #N2, #N3
  - Failed: #N4 (reopened with needs-fix), #N5 (reopened with needs-fix)
  - Skipped: #N6
```

Then run `node scripts/sprint.mjs` and print verbatim. The /sprint output now reflects post-test state: failed issues show as orange (active progress with needs-fix), passed issues stay green.

After the script output:

```
**What just happened**
Walked K test plans. {failed_count} issue(s) reopened with needs-fix. The needs-fix items are not blocked from being closed — they need a follow-up plan + implementation, which can happen in this sprint as a hotfix or roll into the next.

**Where you are now**
[fill from /sprint script's "Where you are now" line, or paraphrase the state]

**Your next step**
[if failed_count > 0]: `/sprint-walkthrough` to triage the needs-fix items, OR `/sprint-end` to close this sprint and let needs-fix roll into the next.
[else]: `/sprint-end` — every issue verified, ready to close out the sprint.
```

## Standing rules

- **Operator drives test verdicts.** This skill does not auto-mark tests as passed based on automated checks. Manual UAT is manual; if {{OPERATOR}} didn't open the app and click the thing, it's not verified.
- **Failed issues reopen, not abandon.** `needs-fix` is a follow-up state, not a kill state. The original commit stays on main; the fix is incremental.
- **Re-runnable.** /sprint-test can run multiple times in a sprint. Already-checked items get skipped. Useful when a fix lands mid-sprint and the original failure becomes verifiable.
- **No automated retries.** If a test fails because of operator misclick or transient issue, mark it as Skip and re-run later. Don't silently accept that as a fail.
- **Single source of truth is the manifest.** GitHub issue comments accumulate verdict context, but the manifest's checkboxes are the canonical ledger. /sprint-end reads the manifest to confirm completeness.
