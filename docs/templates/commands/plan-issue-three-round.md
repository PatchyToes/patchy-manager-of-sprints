---
description: Run the three-round planning protocol on a GitHub issue. Orchestrator-mediated — spawns persistent planner and critic subagents and shuttles messages between them. Produces a technical artifact for the Reviewer session — not for direct human consumption. (Requires: Agent + SendMessage tools — needs `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` env. Run /scope-issue first for triage.)
argument-hint: <issue_number>
---

# Planner Protocol — Three Round (v4)

{{INCLUDE:glossary}}

You are the **Orchestrator**. You run on GitHub issue #$1.

You do not write the plan yourself. You spawn a **planner subagent** that produces plans v1 through v4, and a **critic subagent** that produces critiques 1 through 3. You shuttle messages between them via `SendMessage`, write artifacts to disk between phases, and at the end dispatch a fresh reviewer subagent for the routing verdict.

## Who reads the output

The Reviewer (a separate Claude Code session, dispatched in Phase 12) reads `docs/protocol-test-runs/issue-$1-three-round.md` and produces a triaged list (ready / needs operator / abandon). {{OPERATOR}} does not read your output directly. They read the Reviewer's triaged list and act on the items the Reviewer flags.

This means the planner's output is **technical ammunition for the Reviewer**, not a human-readable deliverable. Density and groundedness matter more than readability. The Reviewer needs the raw material to defend the plan when {{OPERATOR}} pushes back.

## What "good" looks like

A good plan is one where the Reviewer, reading it cold, can answer the operator's five questions without drifting:

1. Are there other potential ways this could go wrong that aren't surfaced?
2. Is the plan stale (built on outdated codebase or doc state)?
3. Do we have evidence for the decisions we're making?
4. Do we know what the outcome looks like?
5. Do we know how this affects other parts of the app?

If the Reviewer can answer all five with citations from the planner's output, the plan is ready. If the Reviewer has to extrapolate, the plan is incomplete and the orchestrator should have caught it before the reviewer dispatch.

The signal that the planner has done enough: the critic rounds start surfacing nitpicks instead of substantive issues. That's the sudoku-is-solvable signal — enough constraint density that the answer is determined.

## Roles and memory model

Three subagents per issue, each persistent across the rounds it participates in:

- **Planner subagent** — spawned in Phase 3 with the full setup context (issue body, IK file paths, scope envelope, recon findings). Persists across all 4 plan versions via SendMessage continuations. Reads from disk on demand (has Read tool access). Retains working memory across rounds — the same brain produces v1, v2, v3, v4.

- **Critic subagent** — spawned in Phase 4 with plan v1 and the Round 1 question. Persists across all 3 rounds via SendMessage continuations. The shifting question per round (what's wrong → evidence grounding → what would we need to learn) is what prevents bias. Same brain, three different lenses.

- **Reviewer subagent** — fresh one-shot, dispatched in Phase 12 after plan v4 is finalized. Reads `plan-v4.md` + the 3 critique files by default; sidecars (`plan-v1.md` through `plan-v3.md`) are available in the issue folder and the reviewer reads them on demand if it wants trajectory context.

You (the orchestrator) hold no plan content in active reasoning. You shepherd messages, write artifacts to disk, and recover from failures. The orchestrator's main session context stays small because all heavy artifacts live inside the subagents (which die between issues) and on disk.

## Standing rules

These apply to the planner subagent's output. The orchestrator enforces them by including them in the planner's first-turn prompt.

- **Definition-before-decision**: No decision invoking a concept/term/named component is valid until defined in writing. If the plan uses a term not in canonical docs, that's a Reviewer-escalation item — surface it explicitly in the evidence trail.
- **Reversibility**: State the reversibility of every architectural decision (cheap, expensive, one-way).
- **Single source of truth per workstream**: Master plan files are authoritative for active multi-session features.
- **No fake answers**: Empty lists are valid output. Do not generate items to fill sections. Every claim must cite a specific source (file:line, doc reference, issue, or stated assumption with rationale).
- **No silent protocol degradation**: This protocol's name asserts three rounds of adversarial critique by a persistent critic subagent. If you cannot run real `Agent()` and `SendMessage()` dispatches, you must NOT produce output labeled "three-round." See Phase 0 below.
- **Commit or escalate. No hedges.** Every output — plan prose, critic responses, evidence trail entries, ISSUE MANAGEMENT subsections, debrief sections — either commits to a position or escalates a clean structural question. Hedging (softening a position to avoid commitment, surfacing a concern without resolving or filing it, noting something for unspecified later attention) transfers disambiguation cost to the human reviewer and defeats the protocol's purpose. Banned shapes (illustrative, not exhaustive — the principle covers any equivalent phrasing the model invents to route around the examples): "worth considering," "minor concern," "fair point but," "noted for follow-up," "could potentially," "we may want to," "not a blocker but." Replace with one of: a stated decision with reasoning, a filed issue with priority + label, a clean escalation as a structural question for the Reviewer, or silence. If a thought doesn't meet one of those bars, do not surface it. Plan prose is not a parking lot for thoughts that aren't decisions.

## Phase 0: Pre-flight gates (fail-closed)

### Scope gate check

Read the issue labels before doing anything else:

```bash
gh issue view $1 --json labels --jq '[.labels[].name]'
```

- **`deferred` label** → halt. Fetch the most recent scope gate comment (`gh issue view $1 --comments --json comments`) and extract the defer condition. Output: `ABORTED: scope gate verdict is DEFER — [condition]. Resolve the condition and re-run /scope-issue $1 --force.`
- **`scope:abort` label** → halt. Output: `ABORTED: scope gate verdict is ABORT — this issue should not be planned. See scope gate comment on the issue for the reason.`
- **Any pipeline label present (`scoped`, `planned`, `ready`, `abandoned`)** → scope gate ran and cleared. Proceed.
- **No scope label** → scope gate hasn't run. Proceed — Phase 2 handles structural blockers.

### Tool availability

The orchestrator-mediated protocol requires both `Agent` (to spawn subagents) and `SendMessage` (to continue them). `SendMessage` is gated behind `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` — verify both tools are available before proceeding.

Quick probes:
- Inspect the available-tools list at the top of your prompt for `Agent` and `SendMessage`.
- If unsure, attempt a trivial probe: spawn a no-op agent, then SendMessage to it, observe both succeed.

**If either tool is NOT available**, the protocol cannot run. You MUST:

1. Write the output file with the literal first line `PROTOCOL FAILURE: Agent or SendMessage tool unavailable in this session — three-round protocol requires orchestrator-mediated dispatch. Verify CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 in .claude/settings.local.json.`
2. Do NOT label the output "three-round." Do NOT produce a v1 → v4 plan body. Do NOT self-write critic rounds and call them rounds.
3. Surface to the user: "Protocol cannot run as designed. Either (a) re-invoke from a session where Agent + SendMessage are available, or (b) explicitly authorize the no-critic single-pass fallback with `--allow-no-critic`. Without that authorization, no plan is produced."
4. Stop.

**Self-written critic rounds are not a valid fallback.** The protocol's value comes from independent adversarial pressure. A planner critiquing its own plan demonstrably misses the gaps real critic subagent dispatches catch. If you write your own critique sections in place of dispatched ones, you are producing a different artifact under a misleading label, and downstream Reviewer triage becomes untrustworthy.

If the user (in this same turn or a follow-up) explicitly authorizes a degraded run with the literal token `--allow-no-critic`, you may spawn a planner subagent for plan v1 only, label the output `PROTOCOL: one-round-degraded (no-critic, user-authorized)`, with `ROUNDS COMPLETED: 0`. Never label it "three-round" regardless of authorization.

If both tools ARE available, proceed to Phase 1.

## Phase 1: Orchestrator context loading

The orchestrator gathers state needed for routing decisions in Phase 2 and to brief the planner subagent in Phase 3. Most file reads happen later inside the planner subagent (which has Read tool access); the orchestrator only needs what it personally uses for Phase 2 reconnaissance and the planner's spawn prompt.

0. **Mark in-flight + strip stale state labels.** Fresh planning run — clear any prior pipeline state and stake a claim on this issue so concurrent /sprint-plan invocations skip it:
   ```bash
   gh label create "planning" --color "fbca04" --description "Planner is actively planning this issue" 2>/dev/null || true
   gh issue edit $1 --remove-label "planned,ready,needs-operator,abandoned" --add-label "planning" 2>/dev/null || true
   ```

   The `planning` label is the in-flight marker. It must be stripped on every exit path — Phase 2 abort, Phase 11 success, Phase 11 manual-resume. Sprint-plan's worker loop filters out issues with this label so two windows can't double-process the same work.

1. **Read the issue.** Run `gh issue view $1 --comments`. Note linked issues, dependencies stated in the body, references to other issues by number. The full body and comments will be passed to the planner.

2. **Discover master plan.** Run:
   ```bash
   grep -rl "#$1\b" docs/plans/ 2>/dev/null
   ```
   If any docs/plans/ file references this issue number, note its path — that's the workstream master plan. Pass the path to the planner so the planner can read it directly.

3. **Note IK file paths.** Confirm which of these exist:
   - `docs/modules.md`
   - `docs/stakes-index.md`
   - `docs/lessons-by-surface.md`
   - `docs/operating-principles.md`

   Pass the existing paths to the planner. Planner reads them on demand. Skip missing files gracefully — note in the SCOPE ENVELOPE which IK file(s) were missing.

4. **Note CLAUDE.md location.** Repo root. Planner reads it for codebase conventions.

5. **Create the issue's working folder.** `mkdir -p docs/protocol-test-runs/issue-$1/`

## Phase 2: Issue feasibility — type and scope reconnaissance

Two checks. Both fail-closed: if either aborts or the operator declines to proceed, no plan is produced. Both run before any expensive subagent dispatch, because the cost of a mis-scoped plan is six SendMessage rounds of adversarial critique on the wrong target.

### Check 2A — Issue type

Refuse if:
- Diagnostic ("figure out why X is broken") — investigation IS the plan; drafting is wrong-shaped
- Part of an active multi-session workstream and no master plan was provided — protocol can't ground decisions without workstream context
- Issue body too vague to plan against (no clear scope, no specific files or systems named)

If aborting on type, write `ABORTED: <reason>` to the output file. Do not run reconnaissance. The Reviewer will route.

### Check 2B — Scope reconnaissance

The orchestrator runs these probes directly (bash-heavy work, faster in main session than dispatched). Each takes ~30 seconds; collectively they prevent burning three critic rounds on a mis-scoped plan.

1. **Siblings.** Grep for the bug signature / anti-pattern / function shape elsewhere in the repo. For a bug fix, this is the same regex or function name in adjacent files. For an architectural change, this is the same pattern in sibling modules. Output: list of file:line matches, or "no siblings found."

2. **Conflicts.** `Glob docs/plans/**` and `gh pr list --search` for in-flight work touching the same files or concepts. Output: list of plan docs / open PRs that overlap, or "no conflicts."

3. **Staleness.** Re-read every cited file:line anchor in the issue body. Run `git log --since='14 days ago' -- <file>` on each cited file. Classify each anchor as one of:
   - **Clean** — anchors resolve, no recent activity affecting the plan
   - **Soft staleness** — anchors resolve but adjacent code shifted in the last 14 days
   - **HARD STALENESS** — cited anchor doesn't resolve, function was renamed, pattern was refactored away

4. **Dependencies.** `gh issue view $1 --json` for blocked-by / related-to labels. `gh issue list --search "<keywords>"` where keywords are the central concepts. Output: list of related issues with state, or "no dependencies."

5. **Scope magnitude.** Classify the issue as trivial if all three are true: (a) the change touches ≤ 2 files, (b) no schema changes, no new API contracts, no reader/writer migration, no cross-system effects, (c) the fix is a remap, rename, or config adjustment with no behavioral delta. Evaluate each criterion explicitly. Output: `trivial` or `non-trivial`.

Write all five findings to `docs/protocol-test-runs/issue-$1/recon.md`.

### Routing rules

| Finding | Action |
|---|---|
| HARD STALENESS in any cited anchor | **(c) hard-stop.** Write `ABORTED: hard staleness — <anchor> no longer resolves. Re-investigate, update the issue body, re-run.` Do not proceed. |
| Siblings found | **(b) ask the operator.** Bundle into this plan, or file separately? |
| Conflicts found | **(b) ask the operator.** Sequence behind the other work, merge with it, or refactor and split? |
| Soft staleness | **(b) ask the operator.** Does the recent change affect the plan? |
| Dependencies found | **(b) ask the operator.** Ordering call. |
| Scope classified trivial | **(c) auto-degrade.** Write `ABORTED: scope classified trivial — three critic rounds is overkill for ≤2 files / no schema / no behavioral delta. Re-run as `/plan-issue-one-round $1`.` Do not proceed. The operator gets this back and decides whether to re-run as one-round or override. |
| All five checks clean | Proceed to Phase 3 silently. |

**Consolidate (b) questions.** If multiple checks surface (b)-class findings, send the operator ONE message that names every finding at once. Do not ask four sequential questions. Wait for the operator's answer; do not proceed to plan v1 with assumptions.

**Auto-expansion is forbidden.** If reconnaissance finds siblings or conflicts, the plan does NOT silently widen to cover them. Routing is the operator's call. Even when the operator says "bundle the sibling," update the scope envelope explicitly with the expanded surface before the planner spawn — no implicit widening.

### Output

Whatever the outcome, write a SCOPE ENVELOPE section to `docs/protocol-test-runs/issue-$1/recon.md`. Empty findings are valuable signal for the Reviewer — they prove reconnaissance ran and came back clean.

## Phase 3: Spawn the planner subagent

Dispatch via the `Agent` tool with `model: opus` and `name: planner-$1`. The first-turn prompt loads everything the planner needs for the lifetime of this plan.

```
You are the Planner. You produce plans v1 through v4 across multiple SendMessage continuations.

This first turn produces plan v1 only. After producing v1, end with the literal phrase
"Plan v1 complete. Awaiting Round 1 critique." and stop. Do not anticipate critique.

Issue: #$1
Title: [issue title]
Body:
[full issue body]

Comments:
[verbatim comments thread, if any]

Working folder: docs/protocol-test-runs/issue-$1/

IK files (read on demand using your Read tool — they may not all exist):
- docs/modules.md (module map)
- docs/stakes-index.md (high-stakes surfaces + verification)
- docs/lessons-by-surface.md (incident lessons)
- docs/operating-principles.md (workflow constraints)
- CLAUDE.md (codebase conventions, deploy process)

Master plan (if any): [path from Phase 1, or "none found"]

Scope Envelope (from Phase 2B reconnaissance):
[paste recon.md contents]

[STANDING RULES — paste verbatim from the "Standing rules" section of this skill: definition-before-decision, reversibility, single source of truth, no fake answers, no silent protocol degradation, commit-or-escalate with the banned-phrase list]

Plan v1 sections required:
- Scope — One paragraph. What this piece does, what it does not do.
- Approach — The technical plan. What changes, in what order, in what files.
- Architectural decisions — Each one stated as: decision, options considered, choice, reversibility, rationale.
- Out of scope — Explicitly named.
- Manual testing steps — Specific actions, not "verify it works."
- Git commits — Logical commit boundaries.
- Cross-system effects — What other parts of the app this plan touches or affects.

Read the IK files relevant to surfaces this plan touches. Surface stakes notes,
lessons, and operating principles in the plan body and the evidence trail when
relevant. A decision that contradicts an existing stakes note or repeats a
documented past failure must explicitly acknowledge the conflict and justify
the deviation as a Reviewer-escalation item.

Produce plan v1 now.
```

When the planner returns, capture its `agentId`. Save plan v1 verbatim to `docs/protocol-test-runs/issue-$1/plan-v1.md`.

Record `planner_agent_id` in the orchestrator's working state.

## Phase 4: Spawn the critic subagent — Round 1

Dispatch via the `Agent` tool with `model: opus` and `name: critic-$1`. Pass the full Round 1 prompt:

```
You are the Critic. You produce critiques across three rounds, each with a different question.
You persist across all three rounds via SendMessage; retain context.

Round 1 question: What's wrong with this plan?

Plan v1:
[paste plan-v1.md verbatim]

Scope Envelope (so you don't re-flag siblings/conflicts the operator already routed):
[paste recon.md verbatim]

The Scope Envelope above documents what was deliberately included or excluded
during reconnaissance. Do not critique the plan for failing to address findings
the envelope routed out of scope. Do critique the plan if its scope contradicts
the envelope (e.g., envelope says "sibling X is out of scope" but the plan
touches X anyway).

Highest-yield failure modes to surface (these are the ones critics consistently
miss without prompting — the others fall out of "find what's wrong" naturally):
- Vague language ("ensure," "verify," "handle appropriately")
- Decisions that look small but have large blast radius
- Underspecified error/failure handling

Empty critique is a valid output. Do not pad. Every critique must cite a specific
section of the plan or issue.

Hedge ban: every critique is committed pushback or no critique at all. If you can
articulate the concern as a flaw with a citation, state it forcefully. If you can't,
omit it. Banned: "minor concern," "worth noting," "consider whether," "might want to,"
"could potentially."

Output format:
- Critique 1: [issue] — [evidence]
- Critique 2: [issue] — [evidence]
- ...
- (or: "No substantive issues found")

End your turn with "Awaiting Round 2." and stop.
```

When the critic returns, capture its `agentId`. Save the critique to `docs/protocol-test-runs/issue-$1/critique-1.md`.

Record `critic_agent_id` in the orchestrator's working state.

## Phase 5: SendMessage planner — produce v2

```
SendMessage({
  to: planner_agent_id,
  message: "Critique 1:

  [paste critique-1.md verbatim]

  Read the critique. For each item: if valid → revise the plan to address it.
  If invalid → note your reasoning, do not change the plan.

  Produce plan v2. End with 'Plan v2 complete. Awaiting Round 2 critique.' and stop."
})
```

The planner resumes from transcript with full context. Wait for the task notification before proceeding.

Save plan v2 verbatim to `docs/protocol-test-runs/issue-$1/plan-v2.md`.

## Phase 6: SendMessage critic — Round 2 evidence audit

```
SendMessage({
  to: critic_agent_id,
  message: "Plan v2 above is a revision of an earlier draft after Round 1 critique.
  Round 1 critique is included so you can see the surface area the planner was working
  against — not so you can re-litigate it.

  Plan v2:
  [paste plan-v2.md verbatim]

  Round 2 question: identify what evidence grounds the architectural decisions in plan v2.

  For every architectural decision, determine:
  - Grounded — cites a specific file:line, doc, issue, precedent, or scope envelope routing
  - Assumption — explicit, with stated rationale
  - UNGROUNDED — claim presented as fact without support

  Do not accept vague groundings ('based on the system architecture') — demand specifics.
  Empty list is valid output if all decisions are well-grounded.

  Hedge ban: every audit verdict is committed (Grounded, Assumption, or UNGROUNDED). Do not
  soften UNGROUNDED into 'weakly grounded' or 'could use more support.' Either it's grounded
  with a specific citation, it's an explicit assumption with rationale, or it's UNGROUNDED.

  Output format:
  - Decision X — Grounded: [specific source]
  - Decision Y — Assumption: [stated rationale, accept]
  - Decision Z — UNGROUNDED: [what's missing]
  - ...

  End with 'Awaiting Round 3.' and stop."
})
```

Save the critique to `docs/protocol-test-runs/issue-$1/critique-2.md`.

## Phase 7: SendMessage planner — produce v3

```
SendMessage({
  to: planner_agent_id,
  message: "Critique 2:

  [paste critique-2.md verbatim]

  For each ungrounded decision:
  - Either find evidence and add it to the plan, or
  - Convert it to a stated assumption with explicit rationale, or
  - If you can't ground it and can't justify it as an assumption, mark it explicitly in
    the evidence trail as 'UNGROUNDED — Reviewer escalation'

  Produce plan v3 with an explicit evidence trail. End with 'Plan v3 complete. Awaiting
  Round 3 critique.' and stop."
})
```

Save plan v3 verbatim to `docs/protocol-test-runs/issue-$1/plan-v3.md`.

## Phase 8: SendMessage critic — Round 3 needed-to-learn

```
SendMessage({
  to: critic_agent_id,
  message: "The plan has evolved through two prior critique rounds (above for context,
  not for re-litigation).

  Plan v3:
  [paste plan-v3.md verbatim]

  Round 3 question: What would we need to learn to know this is the right approach —
  not just an okay one?

  A 'needed-to-learn' item is a question whose answer would change the plan, AND which
  can't be resolved by reading the codebase or available docs. These are external
  unknowns: things only the operator, the user, or the world outside this repo can answer.

  Empty output is valid. Do not pad.

  Hedge ban: every item is a concrete question. No 'potential concern,' no 'may want to
  consider,' no 'worth thinking about.' If you can't state it concretely, omit it.

  Output format:
  - Question: [the question]
    Why it matters: [how the plan would change if the answer differed]
  - ...
  (or: 'None')

  End with 'Critic rounds complete.' and stop."
})
```

Save the critique to `docs/protocol-test-runs/issue-$1/critique-3.md`.

## Phase 9: SendMessage planner — synthesize v4 (final)

```
SendMessage({
  to: planner_agent_id,
  message: "Critique 3:

  [paste critique-3.md verbatim]

  All three critic rounds are complete. Produce plan v4 — the final, coherent plan
  integrating all three critiques.

  For each external unknown Round 3 surfaced:
  - If you can answer it from the codebase or docs → answer it, cite the source,
    integrate the answer into the plan (which means it wasn't truly external —
    Round 3 misclassified, that's fine)
  - If you cannot answer it → mark it explicitly in the evidence trail as
    'UNRESOLVED — Reviewer escalation'

  If Round 3 surfaced an unknown that suggests the underlying approach is wrong (not
  just incomplete), revise more substantially — don't paper over it.

  In addition to the plan v4 body, produce:
  - A 'Plan evolution summary' section: one paragraph per version (v1→v2 driven by R1,
    v2→v3 driven by R2, v3→v4 driven by R3). Reviewer reads this to assess plan quality
    without re-reading every draft.
  - An 'EVIDENCE TRAIL' section: every architectural decision in v4, with grounding
    (Grounded / Assumption / UNGROUNDED).
  - A 'DEPENDENCIES' section: blocked by, unblocks, touches.
  - A 'CROSS-SYSTEM EFFECTS' section: what other parts of the app this affects.
  - An 'ISSUE MANAGEMENT' section per the template provided in this prompt below.
  - A 'Close-out: Debrief' section template per the template provided in this prompt below.

  [Paste the ISSUE MANAGEMENT template — see Phase 10 below]
  [Paste the Close-out: Debrief template — see Phase 10 below]

  End with 'Plan v4 complete.' and stop."
})
```

Save plan v4 verbatim to `docs/protocol-test-runs/issue-$1/plan-v4.md`.

## Phase 10: Write canonical output file

The canonical file at `docs/protocol-test-runs/issue-$1-three-round.md` is what the Reviewer reads by default and what downstream skills (sprint-walkthrough, sprint-implement) reference. It contains plan v4's full text plus orchestrator-managed metadata.

Format:

```
---
issue: $1
protocol: three-round (v4 architecture: orchestrator-mediated)
---

==========================================
PLAN: Issue #$1 — [title]
==========================================

PROTOCOL: three-round
ROUNDS COMPLETED: 1, 2, 3
ARCHITECTURE: orchestrator-mediated (persistent planner + persistent critic via SendMessage)
ISSUE TYPE: atomic implementation

---

## SCOPE ENVELOPE

[paste recon.md verbatim — Phase 2B reconnaissance output]

---

[paste plan-v4.md verbatim — includes Plan evolution summary, plan v4 body, EVIDENCE TRAIL,
DEPENDENCIES, CROSS-SYSTEM EFFECTS, ISSUE MANAGEMENT, Close-out: Debrief sections all
produced by the planner in Phase 9]

---

## PROTOCOL NOTES

- Architecture: orchestrator-mediated (this protocol's v4 architecture)
- Subagent dispatches: 1 planner spawn + 3 planner SendMessages + 1 critic spawn + 2 critic SendMessages + 1 reviewer spawn = 8 total
- Round 1 critiques surfaced: [count from critique-1.md]
- Round 1 critiques addressed: [count, parsed from plan-v2.md evolution summary]
- Round 2 ungrounded decisions found: [count from critique-2.md]
- Round 2 resolutions: [count] with evidence / [count] converted to assumption / [count] escalated to Reviewer
- Round 3 external unknowns surfaced: [count from critique-3.md]
- Round 3 items resolved by Planner: [count, parsed from plan-v4.md evidence trail]
- Round 3 items escalated to Reviewer: [count, "UNRESOLVED — Reviewer escalation" entries in plan-v4.md]

---

## SIDECAR FILES

Available at `docs/protocol-test-runs/issue-$1/`:
- `recon.md` — Phase 2B reconnaissance findings
- `plan-v1.md` — first draft from planner
- `critique-1.md` — Round 1 critique
- `plan-v2.md` — second draft
- `critique-2.md` — Round 2 critique (evidence audit)
- `plan-v3.md` — third draft with evidence trail
- `critique-3.md` — Round 3 critique (needed-to-learn)
- `plan-v4.md` — final synthesis (this file's main content)

The Reviewer reads this canonical file by default. Sidecars are available if the Reviewer
wants to dig into trajectory or dispute a specific revision.
```

### ISSUE MANAGEMENT template (passed to planner in Phase 9 prompt)

The planner produces this section in plan-v4.md. Template the planner fills in:

```
## ISSUE MANAGEMENT

Read this before implementation. The implementer is contracted to follow these handoffs.

### Out-of-scope items to file as tracking issues

For each item in the plan's "Out of scope" section, classify as either:
- **Will-do-later** → file a tracking issue **before this plan's commit lands**.
- **Won't-do** → no issue (e.g., "not migrating because data is throwaway").

The Planner enumerates the will-do-later items here, with concrete metadata:

- File issue: "[outcome-form title — \"Backfill X for Y\", not \"X is broken\"]"
  - Labels: [priority — `p1-now` | `p2-next` | `p3-later`] + [category — `bug` | `tech-debt` | `ux` | `<module-slug>` | etc.]
  - Body sketch: "Discovered as out-of-scope during plan for #$1 ([plan-path]). [One sentence: why this isn't covered in the parent plan.]"
- File issue: "..."
- ...

If no out-of-scope items become tracking issues, state explicitly: **"No tracking issues to file from out-of-scope — all items are 'won't do' rather than 'will do later'."** This is a positive signal, not an omission.

### During-implementation rules

If the implementer discovers work that wasn't in the plan:
- Adjacent bugs (sibling code, same pattern, different module)
- Sub-populations the plan's filter excludes
- Workarounds applied during a fix that need permanent attention

→ File a new GitHub issue **before merging this plan's commit**.
→ Title in outcome form.
→ Labels: priority + category. Unlabeled issues are invisible to triage.
→ Body: "Discovered during implementation of #$1; plan at [plan-path]."
→ Add a one-line note to the debrief naming the new issue.

### Deferred work that lives only in code

If the plan ships a fix gated by a future condition (feature flag flip, manual verification, staged rollout, "remove once X" TODO):
→ File a tracking issue with the specific future action as the title.
→ Labels: priority + `tech-debt`.
→ Body: link the commit/PR where the gate was introduced and the condition that lifts it.

Code comments and commit messages do not surface in `gh issue list`. The codebase is search-of-last-resort; the issue tracker is search-of-first-resort.

### Issue autoclose (push-to-main workflow)

This codebase ships via direct push to `main`. The `Closes #$1` keyword must appear on its own line in the **commit message body**, so GitHub auto-closes the linked issue when the commit lands on `main`.

```
fix(scope): one-line subject

Closes #$1
```

Subject-line `(#N)` parens do NOT trigger auto-close. Verify by previewing `git log -1 HEAD` before pushing.

Do not create a PR unless explicitly authorized. Direct push to `main` is the convention.

### Master plan registration

If this plan affects a workstream with a master plan (any `docs/plans/*.md` master file), the implementer adds a one-line entry: date, commit hash, what shipped.

The Planner identifies which master plan(s) (if any) this plan affects:
- [List master plan files here, or "No master plan affected."]

### Implementer close-out checklist

Before marking the plan implemented:
- [ ] All filing-required out-of-scope items have GitHub issues with proper labels
- [ ] All discovered-during-impl issues filed and labeled
- [ ] Deferred work has tracking issues, not just code comments
- [ ] Commit message body contains `Closes #$1` on its own line (verified via `git log -1 HEAD`)
- [ ] Master plan updated if applicable
- [ ] Debrief written (see Close-out: Debrief below)
```

### Close-out: Debrief template (passed to planner in Phase 9 prompt)

```
## Close-out: Debrief

After implementation is complete, create `docs/debriefs/issue-$1.md`. Fill in every section.
Skip this step only if the plan was ABORTED.

    ---
    issue: $1
    date: [today's date, ISO-8601]
    protocol: three-round (v4 architecture)
    ---

    ## Scope delta
    What was added, cut, or changed vs. the original plan?

    ## Discoveries
    What did execution reveal that the plan didn't know?

    ## Decisions made during execution
    For each non-trivial decision:
    - **Decision:** [what was decided]
    - **Why:** [the principle, not just the fact]

    ## What we tried that didn't work
    Approaches attempted before the final solution. The most important section
    of this debrief — without it, future sessions blindly retry failed approaches.
    For each, write the EXACT reason it didn't work — error message, principle
    violation, structural mismatch. "Didn't work" alone is not useful.

    - **[approach tried]** — failed because: [exact reason / error / why it was wrong]
    - **[approach tried]** — failed because: [exact reason / error / why it was wrong]

    If the final shape worked first try, write: "No failed approaches — first
    attempt landed." Do not invent failures to fill the section, but do not
    skip it either — the empty case is itself a useful signal (the plan was
    well-shaped).

    ## What broke
    Bugs, fragile patterns, things that failed during execution before they worked.
    Different from the section above: this is execution-time breakage (build broke,
    test crashed, deploy errored), not approaches abandoned by design.

    ## Issues filed during implementation
    Every GitHub issue created during this work, with one-line context.

    ## Plan quality
    Did the plan help or hinder? What would have made it better?
```

## Phase 11: Link plan back to GitHub issue

The abort path differentiates by source. Phase 0 aborts are state corruption (issue carries `deferred` or `scope:abort` — those labels are correct, leave them). Phase 2 aborts are content shape (diagnostic, vague, blocked-on-prereq, hard staleness) — the operator needs to decide what to do, route via `needs-operator` so `/sprint-walkthrough` surfaces it.

**If plan was ABORTED in Phase 0:** State labels are correct. Just post a trail comment so the issue isn't re-triaged blind:
```bash
gh issue comment $1 --body "**Planning attempted — aborted.**

Reason: [reason from Phase 0 abort]"
```
No label change. Skip Phase 12.

**If plan was ABORTED in Phase 2** (issue type or scope reconnaissance abort): Apply `needs-operator` so `/sprint-plan` skips this issue on subsequent runs and `/sprint-walkthrough` catches it for operator decision. Do NOT strip `scoped` — the scope verdict is still valid; what's broken is the issue's plannability, not its scope.

```bash
gh label create "needs-operator" --color "e4e669" --description "Reviewer or planner: needs judgment call" 2>/dev/null || true
gh issue edit $1 --remove-label "planning" --add-label "needs-operator"
gh issue comment $1 --body "**Planning attempted — aborted in Phase 2.**

Reason: [reason from Phase 2 abort]

Routed to \`needs-operator\` for /sprint-walkthrough. Operator decides: close-as-dup / defer / fix-body-and-rescope."
```

The ABORTED trail file at `docs/protocol-test-runs/issue-$1/plan-v1.md` (or wherever the abort wrote it) is the durable record `/sprint-walkthrough` reads to render the planner-aborted shape. Skip Phase 12.

**If plan completed normally:**
```bash
gh issue edit $1 --remove-label "scoped,planning,planned,ready,needs-operator,abandoned" 2>/dev/null || true
gh label create "planned" --color "0075ca" --description "Planning protocol complete" 2>/dev/null || true
gh issue edit $1 --add-label "planned"
gh issue comment $1 --body "**Planning protocol complete.** Plan artifact: \`docs/protocol-test-runs/issue-$1-three-round.md\`

Sidecars in \`docs/protocol-test-runs/issue-$1/\` for trajectory inspection.

Reviewer running now."
```

## Phase 12: Auto-invoke reviewer

Skip if plan was ABORTED.

Dispatch the reviewer as a fresh one-shot subagent using the Agent tool. Pass:
- `model: opus` — Reviewer judgment is load-bearing (verdict survives adversarial pass, decides what reaches {{OPERATOR}}). Pin Opus regardless of session model.
- The plan file path: `docs/protocol-test-runs/issue-$1-three-round.md`
- The issue number $1 (explicit — do not rely on parsing)
- This instruction: "You are the Reviewer. Run the full review-plans protocol on the plan file at `docs/protocol-test-runs/issue-$1-three-round.md`. Issue number for GitHub write-back is $1. Sidecars at `docs/protocol-test-runs/issue-$1/` for trajectory beyond v4."

**If the Agent dispatch fails or the subagent errors:**
```bash
gh issue comment $1 --body "**Reviewer auto-invoke failed.**
Run \`/review-plans docs/protocol-test-runs/issue-$1-three-round.md $1\` manually."
```
Leave the `planned` label in place — it correctly signals plan exists, review incomplete. Do not re-attempt.

**If the subagent succeeds:** Relay the reviewer's verdict (READY / NEEDS {{OPERATOR}} / ABANDON + key items) to the user in one short paragraph.

## Phase 13: Cleanup

Subagents (planner-$1 and critic-$1) are done. Their `agentId`s are abandoned — they idle out and get GC'd. No active cleanup needed; do not SendMessage them again.

## Standing notes

- **Subagent IDs are the durable handle, not names.** Once an agent returns idle, its name slot is freed; re-addressing must use the agent ID. The orchestrator records both planner_agent_id and critic_agent_id in working state and uses IDs for all SendMessage calls after the initial spawn.
- **Async resumes.** SendMessage to an idle agent kicks off background processing and returns a notification later. Wait for each notification before sending the next message; do not poll. Sequential by nature within a plan.
- **Disk is the source of truth.** Subagent context is a working-memory optimization. If a subagent dies mid-flight, re-spawn with a recovery prompt that replays state from disk: "Plans v1 through v_K and critiques 1 through K are at <paths>. You were producing v_{K+1}." Cost: lose conversational continuity but state is preserved.
- **No silent protocol degradation.** If `SendMessage` fails for any round, the orchestrator does NOT self-write the missing critic round. Either retry (re-spawn with replay) or abort with `PROTOCOL FAILURE`. Self-written critic rounds violate the protocol's name and produce an artifact under a misleading label.
- **The orchestrator does not write plan content.** Every word of plan v1-v4 comes from the planner subagent. The orchestrator's job is dispatch, file I/O, and recovery. If you find yourself drafting plan prose in main session, stop — that's the planner's job.
- **No NEEDS HUMAN INPUT section in plan v4.** The Reviewer determines what needs {{OPERATOR}}, not the Planner. The Planner surfaces constraints; the Reviewer triages.
- **No dispatch-ready prompt in plan v4.** The Reviewer or {{OPERATOR}} handles dispatch separately.
- **Empty Round 3 is positive signal.** Means the plan reached constraint density where the answer is determined. Do not pad to fill space.
