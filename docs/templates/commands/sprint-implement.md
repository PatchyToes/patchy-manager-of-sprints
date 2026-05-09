---
description: Bootstraps a fresh implementation session for the next greenlit sprint plan. Prints the handoff brief — issue, plan file, deploy footprint, ISSUE MANAGEMENT contract — that the operator pastes into a new Claude Code window to start implementing. (Requires: at least one `greenlit` plan in the current sprint — run /sprint-walkthrough first.)
argument-hint: [<issue_number> | <module-slug>]
---

# Sprint Implement (v1)

{{INCLUDE:glossary}}

**Session model:** Haiku. Reads labels and one plan file, prints a brief. No reasoning.

**Bootstrap, not implementer.** This skill does not implement code. Implementation needs a fresh session with full focus — that's where {{OPERATOR}} opens a new Claude Code window. This skill produces the brief the operator hands to that fresh session.

**Why bootstrap and not direct invoke:** implementation may take hours, may need its own debugging context, may need to run tests/deploys/verify. Trying to do it from inside a sprint-orchestration session burns context and pollutes the sprint state. Cleaner to spawn.

Optional `$1`:
- `<issue_number>` — implement that specific issue (must be `sprint ∩ ready ∩ greenlit`)
- `<module-slug>` — pick the next greenlit issue in that module
- (no arg) — pick the next greenlit issue across all modules

## Phase A: Announce

Before any tool calls, print this preamble exactly (with a trailing blank line). Plain text — do not wrap in code fences or add Markdown.

```
═══ SPRINT · implement ═══
Building the implementation brief for the next greenlit plan. You'll paste it into a fresh Claude Code window.
```

## Phase 0: Tool-availability gate (fail-closed)

```bash
gh auth status >/dev/null 2>&1 || { echo "Sprint implement abort: gh not authenticated."; exit 1; }
```

Verify the `implementing` label exists; create idempotently if missing:
```bash
gh label create "implementing" --color "fbca04" --description "Implementation session in progress" 2>/dev/null || true
```

{{INCLUDE:scratchpad-read}}

## Phase 1: Pick the target

Fetch greenlit candidates that are NOT already being implemented:
```bash
gh issue list --state open --label sprint --label greenlit --limit 50 --json number,title,labels | \
  jq '[.[] | select(.labels[].name != "implementing")]'
```

`greenlit` is the load-bearing decision label: it means the operator walked the plan through and approved it for implementation, regardless of whether the issue arrived at walkthrough as `ready` (reviewer auto-cleared) or `needs-operator` (reviewer escalated, operator answered). `ready` is a *pre-walkthrough* state owned by `/review-plans`; once `greenlit` exists, `ready` is informational, not gating.

The `implementing` exclusion is what enables parallel sessions: if you already ran `/sprint-implement` in another window, that issue is now claimed and won't be picked again here.

If empty:
- If there ARE greenlit issues but they all carry `implementing` → print: `All greenlit plans currently have implementation sessions in progress (#N1, #N2). Run /sprint-walkthrough for more, or wait for a session to merge before claiming the next.`
- Otherwise → print: `No greenlit plans waiting. Run /sprint-walkthrough to clear ready plans first, or /sprint to see status.`

Exit 0.

### Resolution

- **`$1` is a number** — verify it carries `sprint` and `greenlit`. If not, abort with the missing labels listed.
- **`$1` is a module slug** — filter candidates to that module (parse from each issue's SCOPE-GATE comment). Pick the lowest issue number.
- **No `$1`** — group candidates by module (same module ordering as `/sprint`). Pick the first issue in the first module that has greenlit plans.

## Phase 2: Read context for the brief

For the chosen issue:
1. Fetch the issue body and the most recent reviewer comment
2. Read the plan file: `docs/protocol-test-runs/issue-N-{three,one}-round.md`
3. Extract from the plan:
   - Scope envelope
   - Plan v4 / v2 (final) — the actual implementation steps
   - Cross-system effects
   - ISSUE MANAGEMENT section (out-of-scope items to file, master plan registration, close-out checklist)
4. Note the deploy footprint — does it touch `supabase/functions/`, `supabase/migrations/`, `src/`, etc.

## Phase 3: Print the handoff brief

```
==========================================
SPRINT IMPLEMENT — Issue #N
==========================================

Module: [name]
Plan file: docs/protocol-test-runs/issue-N-{protocol}.md
Sprint: [SPRINT_ID]

DEPLOY FOOTPRINT (recorded for /sprint-ship):
- [Frontend only / Edge functions: X, Y / Migration: yes / etc.]
- [Verification: which scripts to run after deploy]

ISSUE MANAGEMENT CONTRACT (must be honored before commit):
- Out-of-scope items to file as tracking issues:
  - [list from ISSUE MANAGEMENT section, or "None"]
- Master plan to update: [path, or "None"]
- Commit message body MUST contain `Closes #N` on its own line (no PR — direct push to main, but the push happens at /sprint-ship time, not here)
- Close-out: write `docs/debriefs/issue-N.md` after commit

---

Open a fresh Claude Code window in this repo and paste this prompt:

────────────────────────────────────────────────────────────
You are implementing the plan for issue #N from sprint [SPRINT_ID].

Read these in order:
1. CLAUDE.md (especially the "Shipping changes" section)
2. docs/protocol-test-runs/issue-N-{protocol}.md (the plan)
3. The issue: gh issue view N --comments

Then implement the plan. When the work is code-complete:

**COMMIT, BUT DO NOT PUSH OR DEPLOY.** This sprint uses batched shipping — all
sprint commits push together at /sprint-ship time. Per-issue pushes during a
sprint cause AI agents in parallel windows to see dirty git state and burn
tokens investigating false alarms. So:

- `git add` and `git commit` only. NO `git push`.
- NO `supabase functions deploy`.
- NO `supabase db push`.
- The commit message body MUST contain `Closes #N` on its own line. Example:
    fix(scope): one-line subject

    Closes #N
  Verify with `git log -1 HEAD` after commit that `Closes #N` is on its own line.
  GitHub will auto-close the issue when /sprint-ship pushes; the close keyword is
  what triggers it.
- File the tracking issues listed in the plan's ISSUE MANAGEMENT section BEFORE
  the close-out commit.

**APPEND THE TEST PLAN TO THE SPRINT MANIFEST.** The plan file's "Test Plan" or
"Verification" section becomes the manual-UAT checklist for end-of-sprint testing.
Find the active sprint manifest:

  ls docs/sprints/S*.md | sort -V | tail -1

Append a section under `## Test plan` (create if missing) using this format:

  ### #N — [issue title]
  - [ ] Test description (golden path)
  - [ ] Test description (edge case)
  - Implementer notes: [anything the operator should know — e.g. "tested locally with mocked Stripe", "needs UAT against live workspace"]

Each test item MUST be a checkbox (`- [ ]`). /sprint-test walks these and applies
needs-fix on failures. If the plan file has no Test Plan section, write one
checkbox: "- [ ] Manual UAT — implementer to specify after work" and let the
operator define the test at /sprint-test time.

**SCRATCHPAD WRITES** (cross-issue impact propagation):
- IF you discover during implementation that your work materially changes another
  sprint issue's plan (shipped a flag they assumed wouldn't exist, changed a
  signature they referenced, found their issue body is wrong), append a one-line
  entry to the manifest's `## Sprint scratchpad / ### Active`. Format:
    - YYYY-MM-DD · #N → affects #M: one-line note
- IF the scratchpad's ### Active had an entry mentioning your issue (#N) and your
  work resolved it, MOVE that entry to ### Resolved with strikethrough + resolution.

**DEBRIEF.** After the close-out commit lands locally (NOT pushed), write
`docs/debriefs/issue-N.md` with what you actually built, what you didn't, what
surprised you. Operator reviews these at /sprint-end.

The plan went through {three-round | one-round} planning + adversarial reviewer pass.
Trust the plan; if you discover the plan is wrong mid-implementation, file a new issue
and stop rather than improvise.
────────────────────────────────────────────────────────────

The commit lives on local main until /sprint-ship batches all sprint commits in
one push + deploy cycle. The `implementing` label persists until that push fires
GitHub's auto-close on `Closes #N`.

---

**What just happened**
Rendered the dispatch brief above for issue #N. This window stays as the orchestration parent — implementation work happens in the new window you're about to open.

**Where you are now**
Brief is staged but the implementation session hasn't started yet. The `implementing` label is now on #N to prevent parallel `/sprint-implement` runs from re-claiming it. Sprint uses batched shipping — the implementation session will commit but not push.

**Your next step**
Open a fresh Claude Code window in this repo and paste the dispatch brief above (the block between the dashed lines). When the implementation session lands its close-out commit locally (no push, no deploy), the `implementing` label persists and the test plan appears in the sprint manifest. Run `/sprint-implement` again here for the next greenlit plan, or `/sprint` for status. When all sprint issues are code-complete, `/sprint-ship` pushes + deploys + tests as a batch.
```

## Phase 4: Claim the issue with `implementing` label

Add the `implementing` label so parallel `/sprint-implement` sessions in other windows skip this issue:

```bash
gh issue edit N --add-label "implementing"
```

When the implementation session pushes its commit to main with `Closes #N` in the body, GitHub auto-closes the issue and the labels become irrelevant. No manual cleanup needed for the happy path.

If implementation is abandoned mid-flight, the operator should `gh issue edit N --remove-label implementing greenlit` to free the issue for re-claim, or run `/sprint-walkthrough` to re-walk it.

## Phase 5: No further GitHub writes

State machine progression:
- Implementation session ships → commit with `Closes #N` body lands on main → GitHub auto-closes the issue
- `/sprint-end` strips `sprint`, `greenlit`, and (defensively) `implementing` from any open sprint issues during close-out
- `/sprint` re-renders next time showing the issue as IMPLEMENTED

## Standing rules

- **No code is written by this skill.** It produces a brief and exits. Implementation is the next session's job.
- **The brief is copy-paste-ready.** The operator should not have to edit it before pasting. If the brief requires editing, the brief is wrong — fix this skill, don't push the work onto the operator.
- **Honor the plan over improvisation.** If the implementer (the next session) discovers the plan is wrong, the right answer is to file a new issue and stop, not to silently scope-creep.
- **Stays out of the implementation session's way.** Do not try to monitor or coordinate the spawned session. Implementation runs independently; sprint state catches up via PR-merge auto-close.
