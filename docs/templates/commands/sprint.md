---
description: Status oracle for the current sprint. Renders progress per module and lists available next actions. Never acts — pure read.
argument-hint: (none)
---

# Sprint Status (v1)

{{INCLUDE:glossary}}

**Session model:** Haiku. Reads labels, renders a table. No reasoning, no writes.

**Status only. Never acts.** This skill is the answer to "where am I in the sprint?" It dispatches no work, writes no labels, runs no planners. If you want to do something, type the verb (`/sprint-plan`, `/sprint-walkthrough`, `/sprint-implement`, `/sprint-end`).

## Phase A: Announce

Before any tool calls, print this preamble exactly (with a trailing blank line). Plain text — do not wrap in code fences or add Markdown.

```
═══ SPRINT · status ═══
Reading sprint state. No writes — pure status.
```

## Phase 0: Tool-availability gate (fail-closed)

```bash
gh auth status >/dev/null 2>&1 || { echo "Sprint status abort: gh not authenticated."; exit 1; }
```

## Phase 1: Detect sprint state

```bash
gh issue list --state open --label sprint --limit 100 --json number,title,labels
```

If empty:

```
No sprint in flight.

Run `/sprint-start` to pick this week's sprint.
```

Stop here. Do not render any further sections.

## Phase 2: Resolve sprint identifier

```bash
SPRINT_ID=$(ls docs/sprints/*.md 2>/dev/null | sort -r | head -1 | xargs -I {} basename {} .md)
```

If no manifest exists but `sprint` label is present (label-without-manifest is recoverable but worth flagging), use `date +%G-W%V` as the fallback identifier and add a footer warning.

## Phase 3: Compute per-issue state (cheap path — no per-issue comment fetches)

The manifest at `docs/sprints/{SPRINT_ID}.md` already contains the module assignment per issue (parsed and cached at `/sprint-start` time). Reading the manifest costs one local file read; fetching SCOPE-GATE comments per issue costs one gh call per issue. **Always prefer the manifest.**

For each `sprint`-labeled issue:

1. **Resolve module from the manifest.** Read `docs/sprints/{SPRINT_ID}.md`, parse the per-module sections (`## module-a (5)`, `## module-b (9)`, etc.), build an `issue_number → module_slug` index. If the issue isn't in the index (e.g., added to the sprint after start), default to `unsorted` and add a footer warning.
2. Map labels to a state machine position:

```
sprint + scoped                  → SCOPED       (not yet planned)
sprint + planned                 → PLANNED      (reviewer running or done, awaiting verdict)
sprint + ready                   → READY        (cleared, awaiting walkthrough)
sprint + ready + greenlit        → GREENLIT     (walkthrough cleared, ready to implement)
sprint + needs-operator          → NEEDS-MIKE
sprint + abandoned               → ABANDONED
closed (was sprint)              → IMPLEMENTED  (commit with `Closes #N` body landed on main)
```

To capture IMPLEMENTED, also fetch closed sprint issues:

```bash
gh issue list --state closed --label sprint --limit 100 --json number,title,labels,closedAt
```

## Phase 4: Render

Group by module. Order modules by total sprint membership desc; `cross-cutting` last.

Bar rendering uses 10 cells. Each cell represents `ceil(total / 10)` issues. Filled cells = issues at PLANNED-or-beyond.

```
==========================================
SPRINT {SPRINT_ID} — N issues across M modules
==========================================

  module-a          (8): ████████░░  6 planned · 4 ready · 2 greenlit · 1 implemented
  module-b          (6): ██████░░░░  4 planned · 2 ready
  module-c          (5): ░░░░░░░░░░  not started
  module-d          (4): ██████████  4 implemented — fully shipped
  cross-cutting     (2): ░░░░░░░░░░  not started

**Where you are now**
Mid-sprint. {summary phrase — e.g., "5 plans waiting for walkthrough, 1 greenlit ready to ship"}.

[If NEEDS YOUR INPUT exists:]
**Needs your input**
  - #350 (module-a) — needs-operator: [reviewer's escalation summary]

**Your next step**
`/sprint-{verb}` — {Plain-English description of what this single recommended action does.} {ETA + posture — "walk away," "stay at the keyboard," "produces a brief to paste elsewhere."}

[Optional — only if there's genuinely valuable parallel work AND the operator is likely to have capacity:]
Parallel option (separate windows):
  /sprint-plan {other-module-slug}    ({N} issues, ~{ETA})
```

### Recommendation rules (which verb to surface as the CTA)

Pick ONE primary action based on sprint state, in this order:

1. **`/sprint-implement`** — if any sprint issue is `ready ∩ greenlit ∩ NOT implementing`. Shipping greenlit plans is highest-leverage.
2. **`/sprint-walkthrough`** — if **any** of:
   - A sprint issue is `ready ∩ NOT greenlit ∩ NOT abandoned` (cleared plans needing decision), OR
   - A sprint issue carries `needs-mike` or `needs-operator` (escalations needing operator input — walkthrough now handles these too as of v2).
   Both shapes are unblocked by the same verb.
3. **`/sprint-plan`** (no arg) — if any module has `scoped` issues that aren't `planned`/`needs-mike`/`needs-operator`. The skill auto-picks the next module.
4. **`/sprint-end`** — if every sprint issue is in a terminal state (closed, abandoned, deferred, or fully implemented).
5. **Wait state** — if all sprint issues are `planned` but reviewer is still running, render: "Reviewer is still working on K plans. Re-run /sprint in a few minutes."

**Module slugs are NOT recommended as the primary CTA.** They're a parallelism escape hatch only — surfaced under "Parallel option" and only when there's a coherent reason to fan out (e.g., multiple modules with unplanned issues AND the operator hasn't already started one). Default mental model: one verb per action, system picks the rest.

### NEEDS-MIKE rendering

For each `needs-operator`-labeled sprint issue, fetch the most recent reviewer comment and extract the escalation items. Surface them in the NEEDS YOUR INPUT section so the operator knows what's blocking.

### When the parallel option is worth surfacing

Surface the optional parallel-windows hint only when ALL of these are true:
- The primary CTA is `/sprint-plan` (no arg)
- 2+ modules have unplanned issues
- No `/sprint-plan` session is currently active in another window (best-effort detection — assume yes if you can't tell)

Otherwise, omit the parallel option entirely. A second module hint when the operator only wants to do one thing creates exactly the noise we're trying to eliminate.

## Standing rules

- **No writes. No actions. No subagent dispatches.** This skill is read-only by contract.
- **No LLM reasoning required.** This skill is mechanical: gh queries + manifest read + label-to-state map + render. If you find yourself reasoning about plan quality or recommending implementation choices, you're in the wrong skill — use `/sprint-walkthrough` for plan-quality, `/sprint-doctor` for state diagnosis.
- **Cheap path only.** Bounded cost: 2 gh calls (open + closed sprint issues) + 1 manifest read + 0-3 extra gh calls only for `needs-operator` issues that need their escalation summary surfaced. Total runtime should be seconds, not minutes. Operator runs this casually multiple times per day — it must stay cheap.
- **One primary CTA, not a menu.** Pick the highest-leverage next action per the recommendation rules above. The operator's mental model is one verb per turn — match it.
- **Module slugs are an escape hatch, not the default.** Surface them only under the optional parallel-windows hint, and only when the conditions in "When the parallel option is worth surfacing" are met.
- **If state is corrupt** (label without comment, manifest without label, etc.), surface the discrepancy in a footer but still render. Don't fail-closed on cosmetic issues.
