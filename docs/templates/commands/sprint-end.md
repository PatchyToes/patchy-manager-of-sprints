---
description: Sprint close-out ritual. Tally what shipped vs rolled, strip sprint/greenlit labels, update the manifest with outcomes, and recommend next steps. Run before /sprint-start to begin a new sprint cleanly. (Requires: an active sprint — issues labeled `sprint`.)
argument-hint: [--dry-run] [--force]
---

# Sprint End (v1)

{{INCLUDE:glossary}}

**Session model:** Sonnet. Mostly mechanical (label strips, manifest update) plus a one-paragraph operator-facing retrospective summary.

**One sprint at a time.** This skill is the inverse of `/sprint-start`. It clears the `sprint` label set so a new sprint can be picked. Without this, `/sprint-start` refuses to run.

**Naturally idempotent close-out.** Issues that shipped (closed via `Closes #N`) get their `sprint` label stripped. Issues still open get their `sprint` and `greenlit` labels stripped — they fall back into the `scoped` pool for the next sprint to consider. No issues are auto-closed.

Optional `$1`:
- `--dry-run` — produce the tally and the manifest update preview, skip all label writes

## Phase A: Announce

Before any tool calls, print this preamble exactly (with a trailing blank line). Plain text — do not wrap in code fences or add Markdown.

```
═══ SPRINT · end ═══
Closing out the current sprint. I'll tally outcomes and strip sprint/greenlit labels — no issues get auto-closed.
```

## Phase 0: Tool-availability gate (fail-closed)

```bash
gh auth status >/dev/null 2>&1 || { echo "Sprint end abort: gh not authenticated."; exit 1; }
git --version >/dev/null 2>&1 || { echo "Sprint end abort: git not in PATH."; exit 1; }
```

## Phase 1: Confirm a sprint is in flight

```bash
gh issue list --state all --label sprint --limit 200 --json number,title,labels,state,closedAt
```

If empty:
```
Sprint end: no sprint in flight (no issues carry the `sprint` label). Nothing to close out.
Run /sprint-start to begin a new sprint.
```
Exit 0.

## Phase 1.5: Pre-close gate (fail-closed)

Sprint-end is a destructive operation — it closes the sprint, archives the manifest, strips labels. Closing prematurely loses operator attention on partial work. This gate refuses to proceed if anything in the sprint is unfinished, and tells {{OPERATOR}} exactly which verb unblocks each item.

### 1.5A. Outstanding non-terminal sprint issues

From the Phase 1 result, count issues that are open AND in a non-terminal state (anything except `abandoned` or closed). For each, classify:

| state label | unblock verb |
|---|---|
| `scoped` (only) | `/sprint-plan` — never planned |
| `planning` | wait — planner is in flight; if stuck >1hr run `/sprint-doctor` to detect stale lock |
| `planned` (no `ready`) | wait — reviewer is in flight |
| `ready` (no `greenlit`) | `/sprint-walkthrough` — needs operator decision |
| `greenlit` (no `implementing`) | `/sprint-implement` — never started |
| `implementing` (open) | wait for the implementation session to commit, OR if abandoned mid-flight, manually mark abandoned |
| `needs-operator` | `/sprint-walkthrough` — escalation pending |

### 1.5B. Outstanding test plan items

```bash
SPRINT_MANIFEST=$(ls docs/sprints/S*.md 2>/dev/null | sed -n 's|.*/\(S[0-9]\{1,\}\)\.md|\1|p' | sort -V | tail -1 | xargs -I {} echo "docs/sprints/{}.md")
[ -z "$SPRINT_MANIFEST" ] && SPRINT_MANIFEST=$(ls docs/sprints/*.md 2>/dev/null | grep -v '/archive/' | sort -r | head -1)
UNCHECKED=$(awk '/^## Test plan/,/^## /' "$SPRINT_MANIFEST" | grep -c '^- \[ \]' || true)
```

If the test plan section has any `- [ ]` (unchecked) items, those are unverified shipped issues. Unblock verb: `/sprint-test`.

### 1.5C. Local commits not pushed

```bash
git fetch origin main
AHEAD=$(git rev-list --count origin/main..HEAD)
```

If `AHEAD > 0`, the sprint has local commits not on origin. Unblock verb: `/sprint-ship`.

### 1.5D. Print the gate result

If ALL of the following are true, proceed to Phase 2:
- Outstanding non-terminal sprint issues = 0
- Unchecked test plan items = 0
- Local commits ahead of origin = 0

Otherwise, print the gate report and abort:

```
==========================================
SPRINT END BLOCKED — sprint not yet complete
==========================================

Outstanding work:
[for each non-terminal issue:]
  - #N — title
    State: <state label>
    Unblock: <verb from table above>
[for each unchecked test:]
  - Test plan: K item(s) unchecked across L issue(s) → run /sprint-test
[if AHEAD > 0:]
  - Local commits not pushed: M commit(s) → run /sprint-ship

Resolve the items above, then re-run /sprint-end. To force-close anyway (mark
remaining issues as abandoned, accept unverified state), use `/sprint-end --force`.
```

If `--force` was passed, skip this gate. (Force-close is for genuine emergency exits — a corrupt sprint, an environment that needs reset. The default path is "fix it, then close.")

Exit 1 unless --force.

## Phase 2: Resolve sprint identifier

```bash
SPRINT_ID=$(ls docs/sprints/S*.md 2>/dev/null | sed -n 's|.*/\(S[0-9]\{1,\}\)\.md|\1|p' | sort -V | tail -1)
[ -z "$SPRINT_ID" ] && SPRINT_ID=$(ls docs/sprints/*.md 2>/dev/null | grep -v '/archive/' | sort -r | head -1 | xargs -I {} basename {} .md)
```

Picks the highest-numbered `S{N}.md` from `docs/sprints/` (excluding `archive/`). Falls back to legacy `2026-W{N}.md` style if no `S{N}.md` exists yet (transitional). If no manifest exists at all, add a footer warning that the manifest was missing.

## Phase 3: Tally outcomes

For each `sprint`-labeled issue, classify by current state:

- **SHIPPED** — issue is closed (commit with `Closes #N` body landed on main)
- **GREENLIT-NOT-SHIPPED** — open + has `greenlit` (walkthrough cleared, never implemented this sprint)
- **READY-NOT-WALKED** — open + has `ready` + no `greenlit` (reviewer cleared, walkthrough never reached it)
- **PLANNED-NOT-REVIEWED** — open + has `planned` + no `ready`/`needs-operator`/`abandoned` (planner ran, reviewer didn't finish)
- **NEEDS-OPERATOR** — open + has `needs-operator` (reviewer escalated, never resolved)
- **ABANDONED** — open + has `abandoned` (walkthrough rejected)
- **NEVER-PLANNED** — open + has `scoped` only (sprint set but planning never happened)

Group counts. Compute a one-paragraph summary:

```
SPRINT {SPRINT_ID} OUTCOMES:
  Shipped:                 K (X% of sprint)
  Greenlit, not shipped:   K (rolling into next sprint as priority candidates)
  Ready, never walked:     K
  Planned, not reviewed:   K
  Needs {{OPERATOR}}:              K (resolve these out-of-band)
  Abandoned:               K
  Never planned:           K (sprint reach exceeded grasp)
```

## Phase 4: Manifest update

Read `docs/sprints/{SPRINT_ID}.md`. Append (or replace if already present) a `## Outcomes` section:

```markdown
## Outcomes

**Closed:** YYYY-MM-DD

| Outcome | Count | Issue numbers |
|---|---|---|
| Shipped | K | #N1, #N2, #N3 |
| Greenlit-not-shipped | K | #N4 |
| Ready-not-walked | K | #N5, #N6 |
| Planned-not-reviewed | K | #N7 |
| Needs-{{OPERATOR}} | K | #N8 |
| Abandoned | K | #N9 |
| Never-planned | K | #N10, #N11 |

**Roll forward (these go back to `scoped` pool):** #N4, #N5, #N6, #N7, #N10, #N11

**Scratchpad lifecycle:** R resolved, A unresolved active entries. [If A > 0, list them here as a bulleted reminder of work that wasn't closed cleanly.]
```

Compute the scratchpad counts before writing:

```bash
ACTIVE_COUNT=$(awk '/^### Active/{flag=1; next} /^### Resolved/ || /^---$/ && flag {flag=0} flag' "docs/sprints/${SPRINT_ID}.md" | grep -E "^- " | wc -l)
RESOLVED_COUNT=$(awk '/^### Resolved/{flag=1; next} /^---$/ && flag {flag=0} flag' "docs/sprints/${SPRINT_ID}.md" | grep -E "^- " | wc -l)
```

If `ACTIVE_COUNT > 0`, list each active entry verbatim under the Outcomes line so the operator can see what slipped through. These are entries that were written during the sprint but never moved to ### Resolved — typically because the implementer who wrote them moved on without closing the loop, OR because the impact genuinely persists into next sprint.

If `--dry-run`, print the planned manifest update inline. Skip the file write.

## Phase 4.5: Scratchpad reconciliation (skip if --dry-run)

Default principle: assume the operator has no time for cleanup. Auto-route every entry whose destination can be inferred. Only prompt if a heavy residue remains.

### Step 1: Parse and classify each ### Active entry

Read all entries in `docs/sprints/${SPRINT_ID}.md` under `## Sprint scratchpad / ### Active`. For each entry, parse:
- `from_issue`: the `#N` before "→ affects" (if present)
- `affected_issue`: the `#M` after "→ affects" (if present)
- `tag`: presence of `general:` or `operator:`

Classify:
- **MOOT** — has `affected_issue` AND `gh issue view <affected_issue> --json state` returns `closed`. The impact is no longer relevant.
- **CARRYABLE** — has `affected_issue` AND it's still open. Impact persists; needs to follow the issue.
- **REVIEW** — `general:` / `operator:` tag, OR parsing failed, OR has `from_issue` but no `affected_issue`. No automatic destination.

### Step 2: Auto-route MOOT and CARRYABLE

**For each MOOT entry:**

Move from `### Active` to `### Resolved` with annotation:
```
- ~~<original entry verbatim>~~ → resolved <today>: moot — affected #M closed
```

**For each CARRYABLE entry:**

First, idempotency check — read existing comments on the affected issue to verify no prior carry-forward comment quoting this entry already exists:
```bash
gh issue view <affected_issue> --comments --json comments | \
  grep -c "SCRATCHPAD-CARRYFORWARD" # if matches contain this entry's text, skip
```

If no existing carry-forward for this entry, post the comment:
```bash
gh issue comment <affected_issue> --body "<!-- SCRATCHPAD-CARRYFORWARD -->
**Carry-forward from sprint ${SPRINT_ID}** (auto-noted at sprint close $(date -I))

> <verbatim entry text>

When this issue is next planned or implemented, incorporate this context. Original entry archived in \`docs/sprints/${SPRINT_ID}.md\` ## Sprint scratchpad ### Resolved."
```

Then move the entry from `### Active` to `### Resolved`:
```
- ~~<original entry verbatim>~~ → resolved <today>: carried via comment on #M
```

The carry-forward comment is the propagation channel — the next time `/enrich-issue` or a planner reads `#M`, the context is right in the issue thread.

### Step 3: Confirmation gate on REVIEW residue

Count the REVIEW-classified entries.

- **0 REVIEW** — silent. Auto-routing handled everything. Continue to Phase 5.
- **1–2 REVIEW** — list them in the close-out output as "needs manual review" but do not prompt. Entries stay in `### Active`. Continue to Phase 5.
- **3+ REVIEW** — prompt the operator with one line:

  ```
  ⚠ <count> scratchpad entries need a human read — couldn't be auto-routed.
  Triage now (~5 min walk-through) or leave them in active for next sprint to surface?

  Reply: `now` | `defer` (default: defer if no response)
  ```

  - **`defer`** (or no response): leave REVIEW entries in `### Active`. They surface in next `/sprint-start`'s proposal where the operator can decide whether to copy any forward.
  - **`now`**: walk each REVIEW entry one at a time. For each, ask the operator:
    ```
    Entry: <verbatim>
    [r]esolve / [c]arry to issue #_ / [d]iscard / [s]kip (leave in active)
    ```
    - `r` → move to ### Resolved with operator-supplied note
    - `c #N` → treat as CARRYABLE: post comment on #N, move entry to ### Resolved
    - `d` → move to ### Resolved with `discarded — no longer relevant`
    - `s` → leave in ### Active

### Step 4: Recompute the lifecycle counts

After Steps 1–3, update the `## Outcomes` section's `Scratchpad lifecycle:` line in the manifest to reflect the post-reconciliation totals:
```
Scratchpad lifecycle: R resolved (originally K, +N moot, +M carried), A unresolved active.
```

## Phase 5: Label cleanup + abandoned-issue closure (skip if --dry-run)

### Step 5A: Close `abandoned`-and-open issues

For each `sprint`-labeled issue that is **open** AND carries the `abandoned` label, close it with `--reason "not planned"`. The walkthrough or reviewer already made the closure decision when it applied `abandoned` — leaving the issue open creates re-scope noise on every future `/batch-scope` and clutters every status output.

```bash
# For each sprint-labeled, abandoned, open issue:
gh issue close N --reason "not planned" --comment "Closed at sprint end ({SPRINT_ID}). Walkthrough/reviewer verdict: ABANDONED. See plan artifact at docs/protocol-test-runs/issue-N-{three,one}-round.md or the WALKTHROUGH-DECISION / REVIEWER-VERDICT comment for full reasoning."
```

If the operator wanted to keep the issue alive for re-scope at a future date, the correct label is `deferred` (with a measurable trigger condition), not `abandoned`. The two labels are intentionally distinct.

### Step 5B: Strip sprint-scoped labels

For each `sprint`-labeled issue (closed by Step 5A or otherwise):

```bash
gh issue edit N --remove-label "sprint" 2>/dev/null || true
gh issue edit N --remove-label "greenlit" 2>/dev/null || true
gh issue edit N --remove-label "implementing" 2>/dev/null || true
```

`greenlit` and `implementing` are sprint-scoped — they have no meaning outside an active sprint, so they get cleared too. State labels (`scoped`, `planned`, `ready`, `needs-operator`) are preserved — they remain valid even when the issue isn't in a sprint, and the next sprint may want to re-consume them. `abandoned` is stripped on closed-by-5A issues (closure makes the label moot).

Process sequentially; on any single failure, log and continue. Report `Label cleanup: M of N succeeded, K abandoned-and-closed. Failures: [list].`

## Phase 6: Auto-run retro (auto-derived only)

Run the retro on the just-closed sprint with `--no-questions` — auto-derived metrics + synthesized recommendations only, no operator interruption. The qualitative layer (3 questions) is operator-initiated separately via `/sprint-retro` standalone, when the operator has time.

Use the Skill tool to invoke `sprint-retro` with args `{SPRINT_ID} --no-questions`. The retro will append its `## Retro` section (auto-derived metrics + synthesis) to the manifest and return.

If skill-from-skill invocation fails for any reason, inline the retro's auto-derived layer (Phases 1–3 + 5 + 6 of `/sprint-retro`, skipping Phase 4 questions). Don't block close-out on retro failure — log and continue.

## Phase 7: Auto-refresh scoped pool for next sprint (skip if --dry-run)

After the retro, refresh the scoped pool so `/sprint-start` runs cleanly next time. This is the right moment for the refresh — the close-out is already a "wrap up the week" ritual where waiting a few minutes is fine.

Print:
```
⟳ Refreshing scoped pool for next sprint — running /batch-scope --force.
This re-classifies rolled-forward issues + any new issues filed during the sprint.
Takes a few minutes for a 60-issue backlog.
```

Use the Skill tool to invoke `batch-scope` with arg `--force`. If skill-from-skill invocation fails, inline the batch-scope logic (Phases 0–6 of `/batch-scope`).

After it completes, proceed to Phase 8.

## Phase 8: Final summary

```
==========================================
SPRINT {SPRINT_ID} CLOSED — YYYY-MM-DD
==========================================

[Phase 3 outcome summary verbatim]

Manifest updated: docs/sprints/{SPRINT_ID}.md
Sprint labels stripped from N issues.
Greenlit labels stripped from K issues.
Scoped pool refreshed: K issues re-classified, M new issues scoped.

Scratchpad reconciliation:
  - {N} moot entries auto-resolved (affected issue already closed)
  - {M} entries auto-carried via comment on #X1, #X2, ... (next planning stage will see them)
  - {K} entries left in active for review

[If K > 0:]
⚠ Active scratchpad entries needing manual review:
  - [verbatim entry 1]
  - [verbatim entry 2]
  - ...
  These surface in next /sprint-start's proposal. No action needed now.

ROLLED FORWARD (back in `scoped` pool, fresh classification):
  - #N4 — [title] — was greenlit, never shipped
  - #N5 — [title] — was ready, never walked
  - ...

**Your next step**
- Resolve any NEEDS-{{OPERATOR}} items out-of-band: #N8
- `/sprint-retro` when you have a few minutes for the qualitative layer (auto-derived already saved)
- `/sprint-start` when ready — pool is fresh, no wait
```

## Standing rules

- **Never auto-close issues.** Close-out is a state machine update, not a workflow decision. Whether an unfinished issue should remain open is the operator's call.
- **Strip sprint + greenlit, preserve everything else.** State labels survive sprints. The `sprint` and `greenlit` labels are scoped to one sprint cycle.
- **Manifest gets the truth.** Even on a chaotic sprint where 80% never shipped, the manifest records exactly what happened. Future-you reading the manifest a year later should be able to reconstruct what went on.
- **The doctor is your friend.** After `/sprint-end`, run `/sprint-doctor --quiet` to confirm clean state before starting the next sprint. Drift detection catches anything the close-out missed.
