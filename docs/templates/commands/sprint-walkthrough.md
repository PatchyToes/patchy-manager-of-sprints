---
description: Walk through ready plans in the current sprint one at a time. Same 4-beat format as /walkthrough-plans, plus writes the `greenlit` / `abandoned` labels per operator decision. Closes the loop between Reviewer and Implementer. (Requires: `ready` plans in the current sprint — run /sprint-plan and let the reviewer finish first.)
argument-hint: [<module-slug>]
---

# Sprint Walkthrough (v1)

{{INCLUDE:glossary}}

**Session model:** Sonnet. Translation work using the established 4-beat format. Architectural reasoning is not the job.

**Format is load-bearing.** This skill produces the exact same per-plan output as `/walkthrough-plans` Phase 3 — Context first / The problem / What this fix does / Trade-offs and sibling findings. That format was confirmed by the operator as the gold standard for plan explanation; do not abbreviate or restructure it.

**The new thing this skill adds:** writes labels to GitHub after each operator decision so `/sprint-implement` knows what's been greenlit. `/walkthrough-plans` is read-only by design — `/sprint-walkthrough` is the version with teeth.

Optional `$1`: module slug to filter further (e.g. `module-a`). Default: walk every `sprint ∩ ready` plan across all modules.

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

## Phase 1: Plan enumeration

Fetch open `sprint ∩ ready` issues:
```bash
gh issue list --state open --label sprint --label ready --limit 100 --json number,title,body,labels
```

If `$1` was passed, filter to issues whose primary module (from their SCOPE-GATE comment) matches the slug.

If empty:
- If a sprint exists but no `ready` issues yet → print `Sprint walkthrough: no ready plans yet. Run /sprint-plan to plan more, or wait for the reviewer to finish.`
- If no sprint exists → print `Sprint walkthrough: no sprint in flight. Run /sprint-start first.`

Exclude any issue already carrying `greenlit` (already walked this sprint) — the operator can re-walk those by stripping `greenlit` first.

For each remaining issue, locate its plan file:
```bash
find docs/protocol-test-runs -name "issue-${N}-*.md" 2>/dev/null
```
Use the most recent by mtime if multiple. If no plan file → mark `skipped: no plan artifact found`.

## Phase 1.5: Module grouping (mirrors /walkthrough-plans Phase 1.5)

Group plans by primary module (parsed from each issue's most recent SCOPE-GATE comment, falling back to path-tally against `docs/modules.md` if needed). Order modules by priority of plans inside (HIGH-risk modules first); `Cross-cutting` last. Within a module, sort by issue number ascending.

Print: `Sprint walkthrough: N plans across M modules. Starting with Plan 1 of N — [module name].` Then proceed directly to Phase 2.

## Phase 2: Per-plan loop

For each plan in order:

1. Read the plan file in full
2. Read the issue body and the most recent reviewer comment (look for `**Review complete.**` marker)
3. If the plan references a master plan in `docs/plans/`, skim the relevant section
4. Produce the walkthrough output using the **Phase 3 format below — verbatim, do not abbreviate**
5. **Pause.** Wait for the operator response before continuing.

### Operator response → label writes

Process each response immediately (write labels before moving to the next plan, so an interrupted session retains state):

| Response | Action |
|---|---|
| `yes` / `next` / `ship it` / `good` | Add `greenlit` label. Record GREENLIT in tally. Move on. |
| `skip` / `abandon` / `don't do this` / `close this` | Strip `ready`, add `abandoned`. Record ABANDONED + reason in tally. Move on. |
| `close and replace` / `file new issue for X` | Strip `ready`, add `abandoned`. Record CLOSE+REPLACE + new-issue intent in tally for end-of-walkthrough action. |
| `amended` / `bundle this with X` / scope correction | Keep labels as-is. Record AMENDED + the change in tally. The amendment is operator intent, not a state-machine transition — `greenlit` still gets added so implementation can proceed. |
| A question | Answer it. Do not write labels until the operator signals readiness with one of the above. |

### Label-write commands

```bash
# greenlit
gh issue edit N --add-label "greenlit"

# abandoned
gh issue edit N --remove-label "ready" 2>/dev/null || true
gh issue edit N --add-label "abandoned"

# amended (after greenlit)
gh issue edit N --add-label "greenlit"
# scope-change note goes in the tally, not a label
```

If a label-write fails (network, rate limit), retry once. On second failure, log it and continue — the verbal record in the tally is the backup.

## Phase 3: Per-plan output format (verbatim from /walkthrough-plans Phase 3)

The four beats are non-negotiable. This is the format the operator confirmed as the gold standard.

### Module transition line

If the current plan is the first one in a new module (the previous plan was in a different module), prepend:

```
--- Now in: [Module Name] · [count] plans in this module ---
```

Skip for Plan 1 (the position header already names the module). Skip when consecutive plans are in the same module.

### Plan body

```
## Plan N of M — Issue #XXX (READY) · [Module Name]

**Context first:**
[2-3 sentences. What the system in question even IS. Analogies to consumer products are fine
("a 'command palette' is the Cmd+K shortcut feature you've used in Linear or Notion").
Assume the operator did not write the code and may not remember it.]

**The problem:** *(or "The drift," "The dead code," "The opportunity" — match the issue shape)*
[2-4 sentences. What the issue actually surfaces. Lead with the load-bearing question —
the one whose answer could invalidate the rest. If it's a real bug, name the user impact.
If it's dead code, say so directly. If it's a feature, say what users get.]

**What this fix does:**
- [Concrete bullet. Files or surfaces touched.]
- [Concrete bullet. Behavior change.]
- [Concrete bullet. What the operator or a user would notice.]
- [Optional: deploy footprint — frontend only, edge function deploy, migration, etc.]

**Trade-offs and sibling findings:**
[What the critic rounds surfaced (Round 1 structural critiques, Round 2 evidence gaps,
Round 3 tensions). What the reviewer flagged or resolved. If the reviewer split work
into multiple PRs but bundling would be cheaper, say so. If the plan reveals "we should
question whether we even want this feature long-term," surface it here.]
```

After this block: STOP. Wait for operator response. Process per Phase 2.

### Pre-answer the recurring questions (per /walkthrough-plans Phase 4)

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
SPRINT WALKTHROUGH COMPLETE — N plans across M modules
==========================================

### [Module Name] ([count] plans · [k greenlit, j abandoned])
- GREENLIT: #N1, #N2 — [one-line outcomes]
- ABANDONED: #N3 — [reason]
- AMENDED: #N4 — [scope change agreed]
- CLOSE + REPLACE: #N5 → new issue: [intent]

### [Next Module] ...

SIBLING ISSUES TO FILE ([count]):
- [title] — [why this surfaced during walkthrough] — touches: [module]

SKIPPED ([count]):
- #N — [reason: no plan artifact / etc.]

LABEL WRITES APPLIED ([count]):
- #N: greenlit
- #N: ready→abandoned
...

**Your next step**
- `/sprint-implement` — ship the K greenlit plans (next: #N1, [Module])
- `/sprint` — see updated sprint status
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

- **The 4-beat format does not get abbreviated.** This is a saved operator preference. If you find yourself shortening or restructuring, stop.
- **Write labels per-plan, not at the end.** State must persist across operator pauses or session crashes. The closing tally is a summary, not the source of truth.
- **One plan at a time.** Never dump multiple plans in one response. Pacing is set by operator readiness.
- **Honor scope corrections without litigation.** Operator override is final. Reviewer's verdict is advisory inside the walkthrough.
- **Don't second-guess plan quality.** Reviewer cleared these. If a plan looks technically wrong, that's a separate `/review-plans --force` call.
