---
description: Walk through every open sprint item that needs an operator decision — ready plans, reviewer-escalated plans, pre-plan scope-gate stucks (both flagged with `needs-operator`), and planner-aborted items. Renders each in a 4-beat format (Context first / The problem / What this fix does / Trade-offs) and writes greenlit / abandoned / WALKTHROUGH-DECISION per operator decision. Closes the loop between Planner/Reviewer and Implementer. (Requires: open sprint items needing decision.)
argument-hint: [<module-slug>]
---

# Sprint Walkthrough (v2)

{{INCLUDE:glossary}}

**Session model:** Sonnet. Translation work using the established 4-beat format. Architectural reasoning is not the job.

**Format is load-bearing.** Each item renders as a 4-beat: **Context first** / **The problem** / **What this fix does** / **Trade-offs and sibling findings**. That format was confirmed by the operator as the gold standard for plan explanation; do not abbreviate or restructure it. Phase 3 below has the verbatim per-shape output templates.

**This skill writes labels to GitHub after each operator decision** so `/sprint-implement` knows what's been greenlit. Read-only walkthrough behavior is not supported — every per-item operator response triggers a label change or a comment write. There's no rehearsal mode.

**v3 expansion (2026-05-08):** the walkthrough handles four item shapes — added PLANNER-ABORTED to the existing three. Planner Phase 2 aborts (diagnostic, vague, blocked-on-prereq, hard staleness) now route to `needs-operator` so the loop is broken; walkthrough surfaces them with a tight action menu (close-as-dup / defer / fix-body-and-rescope / override-and-replan).

- **Ready plan** — reviewer cleared, no open question. 4-beat format, decide ship/abandon.
- **Reviewer-escalated plan** (`needs-operator` after planning) — plan exists with one open question the reviewer flagged. 4-beat format with a "**The reviewer's question**" callout above. Operator answers, then ships or abandons.
- **Scope-gate stuck** (`scoped + needs-operator`, no plan exists) — gate emitted NEEDS-OPERATOR. Walk in 4-beat where "the problem" is the gate's flagged question. Operator decides whether to plan, defer, or abort. Rare in practice; most "needs-operator" items in sprint are actually post-plan reviewer escalations.

Operator's decision is captured in a `<!-- WALKTHROUGH-DECISION -->` comment on the issue (verbatim response + verdict). `/sprint-plan` reads this comment to override stale SCOPE-GATE verdicts on rerun.

Optional `$1`: module slug to filter further (e.g. `module-a`). Default: walk every open sprint item across all modules that needs a decision.

## Phase A: Announce

Before any tool calls, print this preamble exactly (with a trailing blank line). Plain text — do not wrap in code fences or add Markdown.

```
═══ SPRINT · walkthrough ═══
Walking ready plans one at a time. I'll write greenlit/abandoned labels per your call after each plan.
```

## Phase 0: Tool-availability gate (fail-closed)

```bash
gh auth status >/dev/null 2>&1 || { echo "Sprint walkthrough abort: gh not authenticated."; exit 1; }
gh repo view --json name >/dev/null 2>&1 || { echo "Sprint walkthrough abort: gh cannot reach current repo."; exit 1; }
```

Verify the `greenlit` label exists; create idempotently if missing:
```bash
gh label create "greenlit" --color "0e8a16" --description "Walkthrough cleared — ready to implement" 2>/dev/null || true
```

{{INCLUDE:scratchpad-read}}

## Phase 1: Item enumeration

Fetch all open `sprint` issues — single query, filter in-skill (label drift means a strict label-AND query misses items that should be walked):

```bash
gh issue list --state open --label sprint --limit 100 --json number,title,body,labels
```

For each issue, gather context first:
- Plan file presence at `docs/protocol-test-runs/issue-${N}-*.md`
- Most recent comment containing `**Review complete.**` marker (the reviewer's verdict signal — load-bearing)
- Most recent `<!-- SCOPE-GATE -->` comment
- Current label set

Then classify into one of these states. Check in this order — first match wins:

### Skipped (never walked, listed in closing summary)

- **Skip — already-walked** — has `greenlit` or `abandoned` label
- **Skip — in flight** — has `implementing` label (a session is shipping it)
- **Skip — phantom ready** — has `ready` label but NO plan file at `docs/protocol-test-runs/issue-${N}-*.md`. The label is drift; surface for `/sprint-doctor` investigation
- **Skip — unreviewed plan** — has plan file but NO `**Review complete.**` comment AND no `needs-operator` label. The plan was never reviewed; walking it would ask the operator to ship something nobody verified. Surface in summary with action: "Run `/review-plans` on these or `/sprint-doctor` to investigate."
- **Skip — not actionable** — no plan file AND no SCOPE-GATE comment with NEEDS-OPERATOR verdict AND no `needs-operator` label. Issue is in an early state with nothing to walk yet.

### Walkable item shapes

The `**Review complete.**` marker is the load-bearing signal — if it's present with a verdict, the reviewer cleared this item and walking it is safe. If `needs-operator` is set without that marker, the label was applied by a planner-abort path, not a reviewer escalation.

- **READY-PLAN** — has plan file AND has `**Review complete.**` comment with verdict READY AND has `ready` label
- **NEEDS-OPERATOR-PLAN** — has plan file AND has `**Review complete.**` comment with verdict NEEDS-OPERATOR (or NEEDS MIKE — legacy phrasing). The `needs-operator` label should also be set, but the review marker is what makes it walkable, not the label.
- **PLANNER-ABORTED** — has `needs-operator` label AND NO `**Review complete.**` comment (or one with verdict other than NEEDS-OPERATOR). Means the planner protocol couldn't proceed and added `needs-operator` from the abort path; no reviewer ever cleared it. The plan file (if any) typically contains an `ABORTED:` or `PROTOCOL FAILURE:` marker, but the absence-of-review-marker is the more reliable signal — don't rely on plan-file string matching.
- **SCOPE-GATE-STUCK** — no plan file, has SCOPE-GATE comment with NEEDS-OPERATOR verdict (rare; pre-plan stuck). The `needs-operator` label may also be set defensively.

If a label and review-marker conflict (e.g., `ready` label set but no review marker), trust the marker over the label. The marker is what the reviewer wrote; labels can drift independently.

If `$1` was passed, filter further to issues whose primary module matches the slug.

If no walk-it items remain after filtering:
- If a sprint exists → print:
  ```
  Sprint walkthrough: nothing left to decide. Either every sprint item is greenlit/abandoned/implementing, or there are no items needing operator input.
  Run /sprint-implement to ship greenlit, or /sprint for status.
  ```
- If no sprint exists → print `Sprint walkthrough: no sprint in flight. Run /sprint-start first.`

## Phase 1.5: Module grouping

Group items by primary module (parsed from each issue's most recent SCOPE-GATE comment, falling back to path-tally against `docs/modules.md` if needed). Order modules by priority of items inside (HIGH-risk modules first); `Cross-cutting` last. Within a module, sort by issue number ascending. Item shape (READY-PLAN vs NEEDS-OPERATOR-PLAN vs SCOPE-GATE-STUCK vs PLANNER-ABORTED) does not affect ordering — they interleave by issue number.

Print: `Sprint walkthrough: N items across M modules. Starting with Item 1 of N — [module name].` Then proceed directly to Phase 2.

## Phase 2: Per-item loop

For each item in order:

1. Read the plan file (READY-PLAN, NEEDS-OPERATOR-PLAN: read full body. PLANNER-ABORTED: read just the abort reason from the first content line. SCOPE-GATE-STUCK: skip, no plan exists.)
2. Read the issue body and the most recent reviewer comment (`**Review complete.**` marker)
3. Read the most recent `<!-- SCOPE-GATE -->` comment for module + verdict
4. If the plan references a master plan in `docs/plans/`, skim the relevant section
5. Produce the walkthrough output using the **Phase 3 format below — verbatim, do not abbreviate**
6. **Pause.** Wait for the operator response before continuing.

### Operator response → label writes + WALKTHROUGH-DECISION comment

Process each response immediately (write labels and the decision comment before moving to the next item, so an interrupted session retains state):

| Operator response | Applies to | Action |
|---|---|---|
| `yes` / `next` / `ship it` / `good` | READY-PLAN | Add `greenlit`. Record GREENLIT. Move on. |
| Operator answer + `ship it` (after Q&A) | NEEDS-OPERATOR-PLAN | Strip `needs-operator`. Add `greenlit`. Post WALKTHROUGH-DECISION comment with the answer. Record GREENLIT-WITH-ANSWER. Move on. |
| `plan it` / `plan as 3-round` / `plan as 1-round` | SCOPE-GATE-STUCK | Strip `needs-operator`. Post WALKTHROUGH-DECISION comment with verdict (default `PLAN-3-ROUND` if unspecified). Record CLEARED-FOR-PLANNING. Move on. |
| `close as dup of #N` | PLANNER-ABORTED | Strip `needs-operator,sprint`. Close the issue with a comment naming the duplicate target. Record CLOSED-DUP. Move on. |
| `defer` (PLANNER-ABORTED variant) | PLANNER-ABORTED | Strip `sprint,needs-operator`. Add `deferred`. Post a comment with the defer-until condition. Record DEFERRED. Move on. |
| `fix body` / `re-scope` | PLANNER-ABORTED | Strip `needs-operator`. Operator commits to editing the issue body and re-running `/scope-issue $1 --force` afterward. Record FIX-BODY-PENDING. Move on. The next sprint won't pick it up unless re-scoped. |
| `defer` / `not this cycle` | Any | Strip `sprint`. Add `deferred`. Record DEFERRED. Move on. |
| `abandon` / `close this` / `won't do` | Any | Strip `ready`, `needs-operator`. Add `abandoned`. Record ABANDONED + reason. Move on. |
| `close and replace` / `file new issue for X` | Any | Strip `ready`, `needs-operator`. Add `abandoned`. Record CLOSE+REPLACE + new-issue intent for Phase 5 follow-up. |
| `amended` / `bundle this with X` / scope correction | READY-PLAN, NEEDS-OPERATOR-PLAN | Keep labels as-is, add `greenlit`. Record AMENDED + the change. |
| `skip for now` / `come back to this` / `not sure yet` | Any | No label changes. No comment writes. Record SKIPPED-PARKED. Move on. Item stays in current state for next walkthrough. |
| A question | Any | Answer it. Do not write labels or the comment until the operator signals readiness with one of the above. |

### Label-write commands

```bash
# Greenlit (READY-PLAN)
gh issue edit N --add-label "greenlit"

# Greenlit with answer (NEEDS-OPERATOR-PLAN, after operator answers reviewer's question)
gh issue edit N --remove-label "needs-operator" 2>/dev/null || true
gh issue edit N --add-label "greenlit"

# Cleared for planning (SCOPE-GATE-STUCK)
gh issue edit N --remove-label "needs-operator" 2>/dev/null || true

# Deferred
gh issue edit N --remove-label "sprint" 2>/dev/null || true
gh issue edit N --add-label "deferred"

# Abandoned
gh issue edit N --remove-label "ready,needs-operator" 2>/dev/null || true
gh issue edit N --add-label "abandoned"
```

### WALKTHROUGH-DECISION comment

For NEEDS-OPERATOR-PLAN (operator-answered) and SCOPE-GATE-STUCK (cleared-for-planning) items, post a comment capturing the decision verbatim. This is the contract handoff to `/sprint-plan` (which reads this comment when its SCOPE-GATE verdict is stale):

```bash
gh issue comment N --body "$(cat <<'EOF'
<!-- WALKTHROUGH-DECISION -->
**Verdict:** PLAN-3-ROUND
**Operator note:** [verbatim operator response, free text]
**Date:** YYYY-MM-DD
EOF
)"
```

Verdict values:
- `PLAN-3-ROUND` / `PLAN-1-ROUND` — for SCOPE-GATE-STUCK items, replaces the gate's NEEDS-OPERATOR verdict. `/sprint-plan` reads this on next run.
- `ANSWER-RECORDED` — for NEEDS-OPERATOR-PLAN items where the operator answered the reviewer's question. The answer is in the operator note; implementation reads it via the issue comments.

If a label-write or comment-post fails (network, rate limit), retry once. On second failure, log it and continue — the verbal record in the tally is the backup.

## Phase 3: Per-item output format

The four beats are non-negotiable. This is the format the operator confirmed as the gold standard. All four item shapes (READY-PLAN, NEEDS-OPERATOR-PLAN, SCOPE-GATE-STUCK, PLANNER-ABORTED) use the same 4-beat structure — content adapts, structure does not.

### Module transition line

If the current item is the first one in a new module (the previous item was in a different module), prepend:

```
--- Now in: [Module Name] · [count] items in this module ---
```

Skip for Item 1 (the position header already names the module). Skip when consecutive items are in the same module.

### Item body — READY-PLAN

```
## Item N of M — Issue #XXX (READY) · [Module Name]

**Context first:**
[2-3 sentences. What the system in question even IS. Analogies to consumer products are fine.
Assume the operator did not write the code and may not remember it.]

**The problem:** *(or "The drift," "The dead code," "The opportunity" — match the issue shape)*
[2-4 sentences. What the issue surfaces. Lead with the load-bearing question.]

**What this fix does:**
- [Concrete bullet. Files or surfaces touched.]
- [Concrete bullet. Behavior change.]
- [Concrete bullet. What the operator or a user would notice.]
- [Optional: deploy footprint.]

**Trade-offs and sibling findings:**
[Critic rounds, reviewer flags, bundling opportunities, strategic-fit concerns.]
```

### Item body — NEEDS-OPERATOR-PLAN (reviewer-escalated)

Same as READY-PLAN, but **prepend a callout** above the 4-beat with the reviewer's specific question. Operator must answer this before the item can be greenlit:

```
## Item N of M — Issue #XXX (NEEDS YOUR ANSWER) · [Module Name]

**The reviewer's question:**
> [Verbatim quote from the reviewer comment — the exact escalation. If the reviewer
> flagged multiple decisions, surface ONE root question that subsumes them, with the
> sub-points as defaulted overrides ("default to X, override if you want").]

[Then the standard 4-beat body — Context first / The problem / What this fix does / Trade-offs.]
```

After the 4-beat: present a recommendation with reasoning, then ask the root question. Operator answers, then says ship it (greenlit) or abandon.

### Item body — PLANNER-ABORTED (planner couldn't proceed)

The planner ran but aborted in Phase 2 — issue is diagnostic-shaped, body too vague, hard-staleness, or blocked on a prereq. There's no plan to walk; what to walk is the **action menu**. Render the abort reason verbatim from the plan file and present the four operator decisions concisely.

```
## Item N of M — Issue #XXX (PLANNER ABORTED) · [Module Name]

**The planner's abort reason:**
> [Verbatim quote of the ABORTED line from the plan file. Includes the Phase 2 finding —
> "diagnostic body, no clear scope," "hard staleness on cited path," "blocked by #N (open),"
> etc.]

**Context first:**
[2-3 sentences. What the system is. What the issue's general intent looks like.]

**The problem:**
[2-3 sentences. Why the planner couldn't proceed. Lead with the load-bearing condition.]

**Your options:**
- **close as dup of #N** — the issue duplicates an existing planned/in-flight one
- **defer** — leave the sprint, condition for re-entry stays in the body
- **fix body and re-scope** — edit the issue, then run `/scope-issue $1 --force` to refresh

**Trade-offs:**
[Recommended action with reasoning. If the abort is "diagnostic body" and an existing
ready plan covers the surface — close as dup. If it's "blocked by #N" — defer until #N
ships. If you actually need this issue planned now — fix the body to be implementation-shaped,
not investigation-shaped, and re-scope. There's no "override" option — the abort condition
is signal that the body needs work, not that the protocol is wrong. Fix the body or close.]
```

After this block: STOP. Wait for operator response. Process per Phase 2's PLANNER-ABORTED rows.

### Item body — SCOPE-GATE-STUCK (rare; pre-plan, no plan file)

Same 4-beat skeleton, content adapts because there is no plan to walk:

```
## Item N of M — Issue #XXX (NEEDS PLANNING DECISION) · [Module Name]

**The gate's question:**
> [Verbatim quote from the SCOPE-GATE comment — the gate's flagged ambiguity.]

**Context first:**
[What the system is. Same shape as ready-plan context.]

**The problem:**
[The issue's surface — what the user/code actually exhibits.]

**What this fix would do:**
- No plan exists yet. The decision here is whether to plan, defer, or abort.
- If you say "plan it as 3-round" / "plan it as 1-round," next /sprint-plan run picks it up
  with the chosen protocol (a WALKTHROUGH-DECISION comment overrides the gate's NEEDS-OPERATOR).
- If you say "defer," it leaves this sprint.
- If you say "abort," the issue closes.

**Trade-offs:**
[The gate's reasoning for parking it — what tradeoffs the gate saw and couldn't resolve.]
```

After this block: STOP. Wait for operator response. Process per Phase 2.

### Pre-answer the recurring questions

The operator asks the same questions across plans. Pre-answer them in the body where applicable:

- **Scope: universal or per-user/workspace?** Name explicitly.
- **Does this lock us in, or make deprecation easier?** Surface if relevant.
- **"If we designed from scratch?"** If patching a smell, name it.
- **Reviewer over-scoping.** If bundling multiple plans would be cheaper, recommend it.
- **Strategic fit.** If touching a strategically skeptical area, surface it.

When the operator says "ask me a question that, knowing the answer, would let you make the call" — produce ONE binary question. Do not waffle.

## Phase 4: Closing tally

Print **grouped by module**:

```
==========================================
SPRINT WALKTHROUGH COMPLETE — N items across M modules
==========================================

### [Module Name] ([count] items · [breakdown])
- GREENLIT: #N1, #N2 — [one-line outcomes]
- GREENLIT-WITH-ANSWER: #N6 — [answer + outcome]
- CLEARED-FOR-PLANNING: #N7 — [verdict assigned]
- DEFERRED: #N8 — [reason]
- ABANDONED: #N3 — [reason]
- AMENDED: #N4 — [scope change agreed]
- CLOSE + REPLACE: #N5 → new issue: [intent]
- SKIPPED-PARKED: #N9 — [operator chose to come back later]

### [Next Module] ...

SIBLING ISSUES TO FILE ([count]):
- [title] — [why this surfaced during walkthrough] — touches: [module]

SKIPPED — NEVER WALKED ([count total]):

These are items the walkthrough excluded from your decision-list because they're not in a walkable state. Each bucket has a different remediation path.

- **Phantom ready** ([count]) — has `ready` label but no plan file:
  - #N — investigate; either find the missing plan or strip the label
  - Action: `/sprint-doctor` or manual investigation
- **Unreviewed plan** ([count]) — plan file exists but no `**Review complete.**` marker:
  - #N — plan was never reviewed; running this through `/sprint-walkthrough` would ask you to ship something nobody verified
  - Action: `/review-plans <path>` per issue, or `/sprint-doctor` to bulk-flag
- **Not actionable** ([count]) — early state, no plan and no escalation:
  - #N — needs `/scope-issue` or `/plan-issue-*` first
- **Already-walked / in-flight** ([count]) — has `greenlit`, `abandoned`, or `implementing`:
  - #N — already past walkthrough, no action needed

LABEL WRITES APPLIED ([count]):
- #N: +greenlit
- #N: +greenlit, -needs-operator (with WALKTHROUGH-DECISION comment)
- #N: -needs-operator (with WALKTHROUGH-DECISION comment, verdict: PLAN-3-ROUND)
- #N: -ready, +abandoned
...

**Your next step**
[Pick the highest-leverage next action based on what just happened:
 - If there are now greenlit-not-implementing items → /sprint-implement
 - If there are CLEARED-FOR-PLANNING items → /sprint-plan to plan them
 - If everything is terminal → /sprint-end
 - Otherwise → /sprint for status]
```

## Phase 5: Follow-up actions (operator-authorized)

After the tally, ask explicitly:

```
Follow-up actions detected. Authorize?
  - File N sibling issues identified during walkthrough
  - File N close-and-replace issues
  - Close N abandoned issues with their recorded reasons (PR-less close)

Reply: yes (do all) | none | choose (per-action prompt) | later
```

For each authorized action, perform the GitHub write. For `close N abandoned issues`: only close issues whose abandon reason was clear (e.g., "doesn't fit roadmap"). Issues abandoned with reasons like "not this sprint" stay open — the `abandoned` label is sufficient.

## Standing rules

- **The 4-beat format does not get abbreviated.** This is a saved operator preference. All four item shapes use it. If you find yourself shortening or restructuring, stop.
- **One root question per item.** When a NEEDS-OPERATOR-PLAN or SCOPE-GATE-STUCK item has multiple sub-questions, find the ONE root question whose answer subsumes the others, then surface sub-questions as defaulted overrides ("default to X, override if you want"). Do not present a menu of N parallel questions.
- **Write labels and the WALKTHROUGH-DECISION comment per-item, not at the end.** State must persist across operator pauses or session crashes. The closing tally is a summary, not the source of truth.
- **One item at a time.** Never dump multiple items in one response. Pacing is set by operator readiness.
- **Honor scope corrections without litigation.** Operator override is final. Reviewer's verdict is advisory inside the walkthrough.
- **Don't second-guess plan quality.** Reviewer cleared READY-PLANs. If a plan looks technically wrong, that's a separate `/review-plans --force` call.
- **`skip for now` is a valid outcome.** If the operator isn't ready to decide, accept the parked state and move on. Don't pressure for a decision.
