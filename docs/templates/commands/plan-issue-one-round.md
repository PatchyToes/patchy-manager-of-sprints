---
description: Run the one-round (collapsed) planning protocol on a GitHub issue. Orchestrator-mediated — spawns persistent planner and critic subagents and shuttles messages between them. Single critic pass with all three protocol questions combined. Produces a technical artifact for the Reviewer session. (Requires: Agent + SendMessage tools — needs `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` env. Run /scope-issue first for triage.)
argument-hint: <issue_number>
---

# Planner Protocol — One Round Collapsed (v4)

{{INCLUDE:glossary}}

You are the **Orchestrator**. You run on GitHub issue #$1.

You do not write the plan yourself. You spawn a **planner subagent** that produces plans v1 and v2 (final), and a **critic subagent** that produces a single combined critique covering all three protocol dimensions in one pass. You shuttle messages between them via `SendMessage`, write artifacts to disk, and dispatch a fresh reviewer subagent for the routing verdict.

Three dispatches per plan: 1 planner spawn + 1 critic spawn + 1 planner SendMessage + 1 reviewer spawn.

## Who reads the output

The Reviewer reads `docs/protocol-test-runs/issue-$1-one-round.md` and produces a triaged list (ready / needs operator / abandon). {{OPERATOR}} does not read the planner's output directly; they read the Reviewer's triaged list.

## What "good" looks like

Same five-question test as the three-round protocol:

1. Are there other potential ways this could go wrong that aren't surfaced?
2. Is the plan stale (built on outdated codebase or doc state)?
3. Do we have evidence for the decisions we're making?
4. Do we know what the outcome looks like?
5. Do we know how this affects other parts of the app?

If the Reviewer can answer all five with citations from the planner's output, the plan is ready.

## Roles and memory model

- **Planner subagent** — spawned in Phase 3 with the full setup context. Persists across plan v1 and plan v2 via one SendMessage continuation. Reads from disk on demand.
- **Critic subagent** — spawned in Phase 4 with plan v1 and the combined-question prompt. One-shot for one-round (no SendMessage continuations needed; only one critique pass).
- **Reviewer subagent** — fresh one-shot, dispatched in Phase 8 after plan v2 is finalized.

You (the orchestrator) hold no plan content in active reasoning. Subagent context is the working memory; disk is the source of truth.

## Standing rules

These apply to the planner subagent's output. The orchestrator enforces them by including them in the planner's first-turn prompt.

- **Definition-before-decision**: No decision invoking a concept/term/named component is valid until defined in writing. If the plan uses a term not in canonical docs, surface it explicitly in the evidence trail as a Reviewer-escalation item.
- **Reversibility**: State the reversibility of every architectural decision (cheap, expensive, one-way).
- **Single source of truth per workstream**: Master plan files are authoritative for active multi-session features.
- **No fake answers**: Empty lists are valid output. Do not generate items to fill sections. Every claim must cite a specific source (file:line, doc reference, issue, or stated assumption with rationale).
- **No silent protocol degradation**: This protocol's name asserts one round of adversarial critique. If you cannot run real `Agent()` and `SendMessage()` dispatches, you must NOT produce output labeled "one-round." See Phase 0 below.
- **Commit or escalate. No hedges.** Banned: "worth considering," "minor concern," "fair point but," "noted for follow-up," "could potentially," "we may want to," "not a blocker but." Replace with: a stated decision with reasoning, a filed issue with priority + label, a clean escalation as a structural question for the Reviewer, or silence.

## Phase 0: Pre-flight gates (fail-closed)

### Scope gate check

```bash
gh issue view $1 --json labels --jq '[.labels[].name]'
```

- **`deferred` label** → halt. Output: `ABORTED: scope gate verdict is DEFER — [condition]. Resolve the condition and re-run /scope-issue $1 --force.`
- **`scope:abort` label** → halt. Output: `ABORTED: scope gate verdict is ABORT — see scope gate comment for reason.`
- **Pipeline label present (`scoped`, `planned`, `ready`, `abandoned`)** → scope gate ran. Proceed.
- **No scope label** → proceed; Phase 2 handles structural blockers.

### Tool availability

Verify both `Agent` and `SendMessage` are available. `SendMessage` is gated behind `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`.

**If either tool is NOT available**:

1. Write the output file with the literal first line `PROTOCOL FAILURE: Agent or SendMessage tool unavailable in this session — one-round protocol requires orchestrator-mediated dispatch. Verify CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 in .claude/settings.local.json.`
2. Do NOT label the output "one-round." Do NOT produce a v1 → v2 plan body.
3. Surface to the user and stop.

**Self-written critic rounds are not a valid fallback.** If the user authorizes `--allow-no-critic`, you may produce plan v1 only, labeled `PROTOCOL: zero-round-degraded (no-critic, user-authorized)`. Never label it "one-round" regardless.

If both tools ARE available, proceed.

## Phase 1: Orchestrator context loading

0. **Mark in-flight + strip stale state labels.** Stake a claim so concurrent /sprint-plan invocations skip this issue:
   ```bash
   gh label create "planning" --color "fbca04" --description "Planner is actively planning this issue" 2>/dev/null || true
   gh issue edit $1 --remove-label "planned,ready,needs-operator,abandoned" --add-label "planning" 2>/dev/null || true
   ```

   The `planning` label must be stripped on every exit path — Phase 2 abort and Phase 7 success.

1. **Read the issue.** `gh issue view $1 --comments`. The full body and comments will be passed to the planner.

2. **Discover master plan.**
   ```bash
   grep -rl "#$1\b" docs/plans/ 2>/dev/null
   ```
   Note any matching path; pass to the planner.

3. **Note IK file paths.** Confirm which exist: `docs/modules.md`, `docs/stakes-index.md`, `docs/lessons-by-surface.md`, `docs/operating-principles.md`. Pass existing paths to the planner.

4. **Note CLAUDE.md location** (repo root).

5. **Create the issue's working folder.** `mkdir -p docs/protocol-test-runs/issue-$1/`

## Phase 2: Issue feasibility — type and scope reconnaissance

### Check 2A — Issue type

Refuse if:
- Diagnostic ("figure out why X is broken") — investigation IS the plan; drafting is wrong-shaped
- Part of an active multi-session workstream and no master plan was provided
- Issue body too vague to plan against

If aborting on type, write `ABORTED: <reason>` to the output file. Do not run reconnaissance.

### Check 2B — Scope reconnaissance

Four cheap probes (one-round drops scope-magnitude classification — that's what routes to one-round vs three-round in the first place).

1. **Siblings.** Grep for the bug signature / function shape. Output: file:line matches or "no siblings."
2. **Conflicts.** `Glob docs/plans/**` and `gh pr list --search`. Output: overlapping plans/PRs or "no conflicts."
3. **Staleness.** Re-read every cited file:line anchor. `git log --since='14 days ago' -- <file>`. Classify each as Clean / Soft / HARD STALENESS.
4. **Dependencies.** `gh issue view $1 --json` for blocked-by labels; `gh issue list --search` on central concepts.

Write findings to `docs/protocol-test-runs/issue-$1/recon.md`.

### Routing rules

| Finding | Action |
|---|---|
| HARD STALENESS in any cited anchor | **(c) hard-stop.** `ABORTED: hard staleness — <anchor> no longer resolves.` |
| Siblings found | **(b) ask the operator.** Bundle or file separately? |
| Conflicts found | **(b) ask the operator.** Sequence, merge, or split? |
| Soft staleness | **(b) ask the operator.** Does the recent change affect the plan? |
| Dependencies found | **(b) ask the operator.** Ordering call. |
| All four checks clean | Proceed silently. |

**Consolidate (b) questions** into one operator message. Wait for the answer.

**Auto-expansion is forbidden.** Update the scope envelope explicitly when scope widens.

## Phase 3: Spawn the planner subagent

Dispatch via the `Agent` tool with `model: opus` and `name: planner-$1`. The first-turn prompt:

```
You are the Planner. You produce plan v1 first, then plan v2 (final) after a single
combined critique round, across two SendMessage continuations.

This first turn produces plan v1 only. After producing v1, end with the literal phrase
"Plan v1 complete. Awaiting combined critique." and stop.

Issue: #$1
Title: [issue title]
Body:
[full issue body]

Comments:
[verbatim comments thread, if any]

Working folder: docs/protocol-test-runs/issue-$1/

IK files (read on demand using your Read tool):
- docs/modules.md
- docs/stakes-index.md
- docs/lessons-by-surface.md
- docs/operating-principles.md
- CLAUDE.md

Master plan (if any): [path from Phase 1, or "none found"]

Scope Envelope (from Phase 2B reconnaissance):
[paste recon.md contents]

[STANDING RULES — paste verbatim from the "Standing rules" section of this skill]

Plan v1 sections required:
- Scope — One paragraph.
- Approach — What changes, in what order, in what files.
- Architectural decisions — Each: decision, options, choice, reversibility, rationale.
- Out of scope — Explicitly named.
- Manual testing steps — Specific actions.
- Git commits — Logical commit boundaries.
- Cross-system effects — What other parts of the app this affects.

Read the IK files relevant to surfaces this plan touches. Surface stakes notes,
lessons, and operating principles in the plan body and the evidence trail when
relevant. A decision contradicting a stakes note or repeating a documented past
failure must explicitly acknowledge the conflict and justify the deviation as a
Reviewer-escalation item.

Produce plan v1 now.
```

Save plan v1 verbatim to `docs/protocol-test-runs/issue-$1/plan-v1.md`. Record `planner_agent_id`.

## Phase 4: Spawn the critic subagent — combined three-dimension pass

Dispatch via `Agent` with `model: opus` and `name: critic-$1`:

```
You are the Critic. You produce one combined critique covering three dimensions
in a single pass. You will not be asked again.

Plan v1:
[paste plan-v1.md verbatim]

Scope Envelope:
[paste recon.md verbatim]

The Scope Envelope above documents what was deliberately included or excluded
during reconnaissance. Do NOT critique the plan for failing to address findings
the envelope routed out of scope. DO critique if the plan's scope contradicts
the envelope. Decisions that explicitly reference the envelope are grounded by
the envelope itself.

DIMENSION 1 — What's wrong:
Find reasoning errors, logic gaps, scope ambiguity, missing dependency ordering,
underspecified failure handling, vague language ("ensure," "verify," "handle
appropriately"), decisions with hidden blast radius. Cite specific sections of
the plan or issue.

DIMENSION 2 — Evidence grounding:
For every architectural decision, determine if it's grounded in a specific
file:line / doc / issue / precedent, grounded in a stated assumption with
rationale, or ungrounded (claim presented as fact without support). Demand
specifics. Reject vague groundings.

DIMENSION 3 — Approach-changing questions:
Identify questions that, if answered differently, would force a different plan.
Real binary or multi-choice answers only. Skip questions whose answers are
already clear from the plan or context. Skip nice-to-knows.

Empty output for any dimension is valid. Do not pad.

Hedge ban across all three dimensions:
- Dimension 1: every critique is committed pushback or no critique. Banned:
  "minor concern," "worth noting," "consider whether," "might want to," "could potentially."
- Dimension 2: every audit verdict is committed (Grounded, Assumption, or UNGROUNDED).
  No middle category, no qualifying adjectives smuggling uncertainty back in.
- Dimension 3: every question is concrete and would change the plan if answered
  differently. If you can articulate it concretely, do; if not, omit.

Output format:

WHAT'S WRONG:
- [issue] — [evidence]
- ...
(or: "No substantive issues found")

EVIDENCE GROUNDING:
- Decision X — Grounded: [specific source]
- Decision Y — Assumption: [stated rationale, accept]
- Decision Z — UNGROUNDED: [what's missing]
- ...

APPROACH-CHANGING QUESTIONS:
- Question 1: [the question]
  Why it matters: [how the plan would change if the answer differed]
- ...
(or: "None")

End with "Critique complete." and stop.
```

Save the critique to `docs/protocol-test-runs/issue-$1/critique.md`. Record `critic_agent_id`.

## Phase 5: SendMessage planner — produce v2 (final)

```
SendMessage({
  to: planner_agent_id,
  message: "Combined critique:

  [paste critique.md verbatim]

  Read all three categories of critique. For each item:
  - WHAT'S WRONG → revise the plan to address them, or note your reasoning if invalid
  - UNGROUNDED decisions → find evidence, convert to stated assumption with rationale,
    or mark as 'UNGROUNDED — Reviewer escalation'
  - APPROACH-CHANGING QUESTIONS → answer from codebase/docs if possible (cite source,
    integrate); or mark as 'UNRESOLVED — Reviewer escalation'

  Produce plan v2 (final). In addition to the plan body, produce:
  - An 'EVIDENCE TRAIL' section: every architectural decision in v2 with grounding.
  - A 'DEPENDENCIES' section: blocked by, unblocks, touches.
  - A 'CROSS-SYSTEM EFFECTS' section.

  End with 'Plan v2 complete.' and stop."
})
```

Save plan v2 verbatim to `docs/protocol-test-runs/issue-$1/plan-v2.md`.

## Phase 6: Write canonical output file

Write `docs/protocol-test-runs/issue-$1-one-round.md`:

```
---
issue: $1
protocol: one-round (v4 architecture: orchestrator-mediated)
---

==========================================
PLAN: Issue #$1 — [title]
==========================================

PROTOCOL: one-round
ROUNDS COMPLETED: 1 (combined)
ARCHITECTURE: orchestrator-mediated (persistent planner + one-shot critic via SendMessage)
ISSUE TYPE: atomic implementation

---

## SCOPE ENVELOPE

[paste recon.md verbatim]

---

[paste plan-v2.md verbatim — includes plan body + EVIDENCE TRAIL + DEPENDENCIES +
CROSS-SYSTEM EFFECTS sections produced by the planner in Phase 5]

---

## ISSUE MANAGEMENT

The orchestrator templates this section using plan-v2.md's "Out of scope" content
and the standard implementer-contract boilerplate (commit conventions, autoclose
rules, master plan registration, debrief format). Mechanical fill, not planner
judgment — orchestrator handles it.

[Standard ISSUE MANAGEMENT template — same as three-round protocol]

---

## Close-out: Debrief

[Standard debrief template — same as three-round protocol]

---

## SIDECAR FILES

Available at `docs/protocol-test-runs/issue-$1/`:
- `recon.md` — Phase 2B reconnaissance
- `plan-v1.md` — first draft
- `critique.md` — combined three-dimension critique
- `plan-v2.md` — final synthesis (this file's main content)

---

## PROTOCOL NOTES

- Architecture: orchestrator-mediated
- Subagent dispatches: 1 planner spawn + 1 critic spawn + 1 planner SendMessage + 1 reviewer spawn = 4 total
- Dimension 1 (what's wrong) critiques surfaced: [count]
- Dimension 2 (evidence) ungrounded decisions found: [count]
- Dimension 3 (questions) surfaced: [count]
```

## Phase 7: Link plan back to GitHub issue

The abort path differentiates by source. Phase 0 aborts are state corruption (issue carries `deferred` or `scope:abort` — those labels are correct, leave them). Phase 2 aborts are content shape — the operator needs to decide what to do, route via `needs-operator`.

**If plan was ABORTED in Phase 0:** State labels are correct. Just post a trail comment:
```bash
gh issue comment $1 --body "**Planning attempted — aborted.**

Reason: [reason from Phase 0 abort]"
```
No label change. Skip Phase 8.

**If plan was ABORTED in Phase 2:** Apply `needs-operator` so `/sprint-plan` skips this issue on subsequent runs and `/sprint-walkthrough` catches it. Do NOT strip `scoped`.

```bash
gh label create "needs-operator" --color "e4e669" --description "Reviewer or planner: needs judgment call" 2>/dev/null || true
gh issue edit $1 --remove-label "planning" --add-label "needs-operator"
gh issue comment $1 --body "**Planning attempted — aborted in Phase 2.**

Reason: [reason from Phase 2 abort]

Routed to \`needs-operator\` for /sprint-walkthrough. Operator decides: close-as-dup / defer / fix-body-and-rescope."
```
Skip Phase 8.

**If plan completed normally:**
```bash
gh issue edit $1 --remove-label "scoped,planning,planned,ready,needs-operator,abandoned" 2>/dev/null || true
gh label create "planned" --color "0075ca" --description "Planning protocol complete" 2>/dev/null || true
gh issue edit $1 --add-label "planned"
gh issue comment $1 --body "**Planning protocol complete.** Plan artifact: \`docs/protocol-test-runs/issue-$1-one-round.md\`

Sidecars in \`docs/protocol-test-runs/issue-$1/\` for trajectory inspection.

Reviewer running now."
```

## Phase 8: Auto-invoke reviewer

Skip if plan was ABORTED.

Dispatch the reviewer as a fresh one-shot subagent using the Agent tool:
- `model: opus` — Pin Opus regardless of session model.
- Plan file path: `docs/protocol-test-runs/issue-$1-one-round.md`
- Issue number $1 (explicit)
- Instruction: "You are the Reviewer. Run the full review-plans protocol on the plan file at `docs/protocol-test-runs/issue-$1-one-round.md`. Issue number for GitHub write-back is $1. Sidecars are available at `docs/protocol-test-runs/issue-$1/` if you want trajectory beyond v2."

**If the dispatch fails:**
```bash
gh issue comment $1 --body "**Reviewer auto-invoke failed.**
Run \`/review-plans docs/protocol-test-runs/issue-$1-one-round.md $1\` manually."
```

**If the dispatch succeeds:** Relay verdict (READY / NEEDS {{OPERATOR}} / ABANDON + key items) in one short paragraph.

## Phase 9: Cleanup

Subagents (planner-$1 and critic-$1) are abandoned — no further messages. They idle out and get GC'd.

## Standing notes

- **Subagent IDs are the durable handle.** Use `agentId`, not name, for SendMessage after the initial spawn.
- **Async resumes.** Wait for task notifications; don't poll.
- **Disk is the source of truth.** Subagent context is working-memory optimization.
- **The orchestrator does not write plan content.** Every word of plan v1 and v2 comes from the planner subagent.
- **No NEEDS HUMAN INPUT section.** Reviewer triages.
- **Empty critique dimensions are positive signal.** Do not pad.
