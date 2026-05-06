---
description: Sprint close-out ritual. Tally what shipped vs rolled, strip sprint/greenlit labels, update the manifest with outcomes, and recommend next steps. Run before /sprint-start to begin a new sprint cleanly. (Requires: an active sprint — issues labeled `sprint`.)
argument-hint: [--dry-run]
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

## Phase 2: Resolve sprint identifier

```bash
SPRINT_ID=$(ls docs/sprints/*.md 2>/dev/null | sort -r | head -1 | xargs -I {} basename {} .md)
```

If no manifest exists, fall back to `date +%G-W%V` and add a footer warning that the manifest was missing.

## Phase 3: Tally outcomes

For each `sprint`-labeled issue, classify by current state:

- **SHIPPED** — issue is closed (commit with `Closes #N` body landed on main)
- **GREENLIT-NOT-SHIPPED** — open + has `greenlit` (walkthrough cleared, never implemented this sprint)
- **READY-NOT-WALKED** — open + has `ready` + no `greenlit` (reviewer cleared, walkthrough never reached it)
- **PLANNED-NOT-REVIEWED** — open + has `planned` + no `ready`/`needs-operator`/`abandoned` (planner ran, reviewer didn't finish)
- **NEEDS-MIKE** — open + has `needs-operator` (reviewer escalated, never resolved)
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

## Phase 5: Label cleanup (skip if --dry-run)

For each `sprint`-labeled issue:

```bash
gh issue edit N --remove-label "sprint" 2>/dev/null || true
gh issue edit N --remove-label "greenlit" 2>/dev/null || true
gh issue edit N --remove-label "implementing" 2>/dev/null || true
```

`greenlit` and `implementing` are sprint-scoped — they have no meaning outside an active sprint, so they get cleared too. State labels (`scoped`, `planned`, `ready`, `needs-operator`, `abandoned`) are preserved — they remain valid even when the issue isn't in a sprint, and the next sprint may want to re-consume them.

Process sequentially; on any single failure, log and continue. Report `Label cleanup: M of N succeeded. Failures: [list].`

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

[If ACTIVE_COUNT > 0:]
⚠ Scratchpad: A unresolved active entries — these signal cross-issue impact that was never closed:
  - [verbatim entry 1]
  - [verbatim entry 2]
  - ...
  Review these before /sprint-start. If any are about rolled-forward issues, copy them
  into the new sprint's manifest scratchpad so the next implementer sees them.

ROLLED FORWARD (back in `scoped` pool, fresh classification):
  - #N4 — [title] — was greenlit, never shipped
  - #N5 — [title] — was ready, never walked
  - ...

NEXT:
  - Resolve any NEEDS-MIKE items out-of-band: #N8
  - /sprint-retro when you have a few minutes for the qualitative layer (auto-derived already saved)
  - /sprint-start when ready — pool is fresh, no wait
```

## Standing rules

- **Never auto-close issues.** Close-out is a state machine update, not a workflow decision. Whether an unfinished issue should remain open is the operator's call.
- **Strip sprint + greenlit, preserve everything else.** State labels survive sprints. The `sprint` and `greenlit` labels are scoped to one sprint cycle.
- **Manifest gets the truth.** Even on a chaotic sprint where 80% never shipped, the manifest records exactly what happened. Future-you reading the manifest a year later should be able to reconstruct what went on.
- **The doctor is your friend.** After `/sprint-end`, run `/sprint-doctor --quiet` to confirm clean state before starting the next sprint. Drift detection catches anything the close-out missed.
