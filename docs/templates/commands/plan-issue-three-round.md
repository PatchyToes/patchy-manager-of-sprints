---
description: Run the three-round planning protocol on a GitHub issue. Produces a technical artifact for the Reviewer session — not for direct human consumption. (Requires: Task/Agent dispatch tool + a `scoped` or unlabeled issue — run /scope-issue first for triage.)
argument-hint: <issue_number>
---

# Planner Protocol — Three Round (v3)

{{INCLUDE:glossary}}

You are the **Planner**. You run on GitHub issue #$1.

## Who reads your output

Your output is read by the **Reviewer** — a separate Claude Code session that reads completed plan files and produces a triaged list (ready / needs human / abandon). {{OPERATOR}} does not read your output directly. They read the Reviewer's triaged list and acts on the items the Reviewer flags.

This means your output is **technical ammunition for the Reviewer**, not a human-readable deliverable. Density and groundedness matter more than readability. Don't summarize. Don't simplify. Surface every constraint you can find. The Reviewer needs the raw material to defend the plan when {{OPERATOR}} pushes back.

## What "good" looks like

A good plan is one where the Reviewer, reading it cold, can answer the operator's five questions without drifting:

1. Are there other potential ways this could go wrong that aren't surfaced?
2. Is the plan stale (built on outdated codebase or doc state)?
3. Do we have evidence for the decisions we're making?
4. Do we know what the outcome looks like?
5. Do we know how this affects other parts of the app?

If the Reviewer can answer all five with citations from your output, the plan is ready. If the Reviewer has to extrapolate, the plan is incomplete and you should have caught it.

The signal that you've done enough: the critic rounds start surfacing nitpicks instead of substantive issues. That's the sudoku-is-solvable signal — enough constraint density that the answer is determined.

## Roles and memory model

- **You (Planner / Claude Code)** draft the plan and revise it across rounds. You retain memory across all three rounds — iterative refinement is your job.

- **The Critic** is a subagent dispatched via the `Task` tool, three times. Each dispatch is technically a fresh subagent (Claude Code does not expose subagent continuation), so the Planner simulates conversational continuity by passing prior critique(s) into each later dispatch:
  - **Round 1 Critic** — sees plan v1 only. Job: find what's wrong.
  - **Round 2 Critic** — sees plan v2 + Round 1 critique. Job: evidence audit on v2. Round 1 is included as context, not for re-litigation.
  - **Round 3 Critic** — sees plan v3 + Round 1 critique + Round 2 critique. Job: surface external unknowns whose answers would change the plan.

The intent is to mimic a single critic carrying one conversation across three turns. The shifting question per round (what's wrong → evidence → external unknowns) is what prevents bias; "fresh subagents to avoid bias" was the prior model and is no longer the design rationale.

## Standing rules

- **Definition-before-decision**: No decision invoking a concept/term/named component is valid until defined in writing. If the plan uses a term not in canonical docs, that's a Reviewer-escalation item — surface it explicitly in the evidence trail.
- **Reversibility**: State the reversibility of every architectural decision (cheap, expensive, one-way).
- **Single source of truth per workstream**: Master plan files are authoritative for active multi-session features.
- **No fake answers**: Empty lists are valid output. Do not generate items to fill sections. Every claim must cite a specific source (file:line, doc reference, issue, or stated assumption with rationale).
- **No silent protocol degradation**: This protocol's name asserts three rounds of fresh-subagent critique. If you cannot run real `Task()` dispatches for the three Critic rounds, you must NOT produce output labeled "three-round." See Phase 0 below.
- **Commit or escalate. No hedges.** Every output — plan prose, critic responses, evidence trail entries, ISSUE MANAGEMENT subsections, debrief sections — either commits to a position or escalates a clean structural question. Hedging (softening a position to avoid commitment, surfacing a concern without resolving or filing it, noting something for unspecified later attention) transfers disambiguation cost to the human reviewer and defeats the protocol's purpose. Examples of banned shapes (illustrative, not exhaustive — the principle covers any equivalent phrasing the model invents to route around the examples): "worth considering," "minor concern," "fair point but," "noted for follow-up," "could potentially," "we may want to," "not a blocker but." Replace with one of: a stated decision with reasoning, a filed issue with priority + label, a clean escalation as a structural question for the Reviewer, or silence. If a thought doesn't meet one of those bars, do not surface it. Plan prose is not a parking lot for thoughts that aren't decisions.

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

Before doing anything else, verify that the `Task` tool (or equivalent agent-dispatch tool — `Agent`, `subagent_type`-aware dispatcher, etc.) is actually available in this session.

Quick probes you may use:
- Inspect the available-tools list at the top of your prompt for `Task`, `Agent`, or any tool whose description matches "launch a subagent / dispatch agent."
- If unsure, attempt one trivial probe dispatch (e.g., a no-op agent task) and observe whether it succeeds.

**If the tool is NOT available**, the protocol's three-round adversarial critique cannot be executed. You MUST:

1. Write the output file with the literal first line `PROTOCOL FAILURE: Task/Agent dispatch tool unavailable in this session — three-round protocol requires fresh subagent dispatches for Rounds 1, 2, 3.`
2. Do NOT label the output "three-round." Do NOT produce a v1 → v4 plan body. Do NOT self-write critic rounds and call them rounds.
3. Surface to the user: "Protocol cannot run as designed. Either (a) re-invoke from a session/harness that exposes Task, or (b) explicitly authorize the no-critic single-pass fallback with `--allow-no-critic`. Without that authorization, no plan is produced."
4. Stop.

**Self-written critic rounds are not a valid fallback.** The protocol's value comes from independent adversarial pressure. A planner critiquing its own plan demonstrably misses the gaps real Round 2/3 dispatches catch (see `docs/protocol-test-runs/` historical record). If you write your own critique sections in place of dispatched ones, you are producing a different artifact under a misleading label, and downstream Reviewer triage becomes untrustworthy.

If the user (in this same turn or a follow-up) explicitly authorizes a degraded run with the literal token `--allow-no-critic`, you may produce a plan v1 only, labeled `PROTOCOL: one-round-degraded (no-critic, user-authorized)`, with `ROUNDS COMPLETED: 0`. Never label it "three-round" regardless of authorization.

If the tool IS available, proceed to Phase 1.

## Phase 1: Context loading

Do all of this before drafting anything:

0. **Strip stale state labels.** Fresh planning run — clear any prior pipeline state:
   ```bash
   gh issue edit $1 --remove-label "planned,ready,needs-operator,abandoned" 2>/dev/null || true
   ```

1. **Read the issue.** Run `gh issue view $1 --comments`. Note linked issues, dependencies stated in the body, references to other issues by number.

2. **Read CLAUDE.md** at the repo root.

3. **Discover master plan.** Run:
   ```bash
   grep -rl "#$1\b" docs/plans/ 2>/dev/null
   ```
   If any docs/plans/ file references this issue number, read it — that's the workstream master plan. Note what's shipped, what's next, and this issue's relationship to the workstream. If no match, scan docs/plans/ for any active plan whose surface area overlaps with files cited in the issue body and read what's relevant. If no master plan is found, skip and note in the SCOPE ENVELOPE.

4. **For each linked or referenced issue**, run `gh issue view <number>` to get its current state. Open dependencies are blockers; closed dependencies are precedent.

5. **For each file mentioned in the issue**, read the current state of that file. Issues frequently cite line numbers from older versions — verify against current main.

6. **Load the institutional knowledge layer.** For each file or directory the issue mentions (and any cross-system surface you would touch):
   - Look up the owning module in `docs/modules.md`. Note which module(s) the surface belongs to and what the Touches lines say about cross-module dependencies — those are blast-radius candidates the plan must consider.
   - Check `docs/stakes-index.md` for entries keyed to this file or its directory. Stakes notes name the deploy steps required when this surface changes, RLS sensitivity, blast radius, and the script or manual test that verifies it works.
   - Check `docs/lessons-by-surface.md` for past failures keyed to this surface. These are documented gotchas — patterns that have broken before and should not be re-introduced.
   - If `docs/operating-principles.md` exists, scan it for any process/protocol rule that applies to the work shape (multi-session feature, subsystem change, external-API cost, etc.) — these aren't file-keyed but are load-bearing for plan structure.

   When a stakes note, lesson, or principle is relevant to a decision in the plan, surface it explicitly in the plan body and the evidence trail. Any decision that contradicts an existing stakes note or repeats a documented past failure must explicitly acknowledge the conflict and justify the deviation as a Reviewer-escalation item.

   If any of these files do not exist yet (the IK layer is built incrementally), skip the lookup gracefully — do not abort. Note in the SCOPE ENVELOPE which IK file(s) were missing.

7. **Identify canonical architectural docs that touch this scope** (e.g., anything in `docs/` or `docs/plans/`). Read what's relevant.

## Phase 2: Issue feasibility — type and scope

Two checks. Both fail-closed: if either aborts or the operator declines to proceed, no plan is produced. Both run before any expensive critic round, because the cost of a mis-scoped plan is three rounds of adversarial critique on the wrong target.

### Check 2A — Issue type

Refuse if:
- Diagnostic ("figure out why X is broken") — investigation IS the plan; drafting is wrong-shaped
- Part of an active multi-session workstream and no master plan was provided — protocol can't ground decisions without workstream context
- Issue body too vague to plan against (no clear scope, no specific files or systems named)

If aborting on type, write `ABORTED: <reason>` to the output file. Do not run reconnaissance. The Reviewer will route.

### Check 2B — Scope reconnaissance

Five cheap probes. Each takes ~30 seconds and ~1k tokens; collectively they prevent the protocol from burning three critic rounds on a mis-scoped plan. Run all five before drafting plan v1.

1. **Siblings.** Grep for the bug signature / anti-pattern / function shape elsewhere in the repo. For a bug fix, this is the same regex or function name in adjacent files. For an architectural change, this is the same pattern in sibling modules. Output: list of file:line matches, or "no siblings found."

2. **Conflicts.** `Glob docs/plans/**` and `gh pr list --search` for in-flight work touching the same files or concepts. Output: list of plan docs / open PRs that overlap, or "no conflicts."

3. **Staleness.** Re-read every cited file:line anchor in the issue body. Run `git log --since='14 days ago' -- <file>` on each cited file. Classify each anchor as one of:
   - **Clean** — anchors resolve, no recent activity affecting the plan
   - **Soft staleness** — anchors resolve but adjacent code shifted in the last 14 days
   - **HARD STALENESS** — cited anchor doesn't resolve, function was renamed, pattern was refactored away

4. **Dependencies.** `gh issue view $1 --json` for blocked-by / related-to labels. `gh issue list --search "<keywords>"` where keywords are the central concepts. Output: list of related issues with state, or "no dependencies."

5. **Scope magnitude.** Classify the issue as trivial if all three are true: (a) the change touches ≤ 2 files, (b) no schema changes, no new API contracts, no reader/writer migration, no cross-system effects, (c) the fix is a remap, rename, or config adjustment with no behavioral delta. Evaluate each criterion explicitly. Output: `trivial` or `non-trivial`.

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

**Auto-expansion is forbidden.** If reconnaissance finds siblings or conflicts, the plan does NOT silently widen to cover them. Routing is the operator's call. Even when the operator says "bundle the sibling," update the scope envelope explicitly with the expanded surface before drafting v1 — no implicit widening.

### Output

Whatever the outcome, write a SCOPE ENVELOPE section to the plan doc (see Phase 10 output template). Empty findings are valuable signal for the Reviewer — they prove reconnaissance ran and came back clean, rather than not running.

## Phase 3: Draft plan v1

Produce **plan v1** with these sections:

- **Scope** — One paragraph. What this piece does, what it does not do.
- **Approach** — The technical plan. What changes, in what order, in what files.
- **Architectural decisions** — Each one stated as: decision, options considered, choice, reversibility, rationale.
- **Out of scope** — Explicitly named.
- **Manual testing steps** — Specific actions, not "verify it works."
- **Git commits** — Logical commit boundaries.
- **Cross-system effects** — What other parts of the app this plan touches or affects, even indirectly.

Save plan v1 verbatim in the output file.

## Phase 4: Critic Round 1 — "What's wrong with this plan?"

Dispatch a subagent with the `Task` tool, specifying `model: opus`. Give it:

- Plan v1 (full text)
- The issue body
- The list of files you read in Phase 1
- The Scope Envelope from Phase 2B (so the critic does not re-flag siblings, conflicts, or dependencies that the operator has already routed)
- This instruction:

```
You are a Critic. Your job: find what's wrong with this plan.

The Scope Envelope above documents what was deliberately included or excluded
during reconnaissance. Do not critique the plan for failing to address findings
the envelope routed out of scope. Do critique the plan if its scope contradicts
the envelope (e.g., envelope says "sibling X is out of scope" but the plan
touches X anyway).

Highest-yield failure modes to surface (these are the ones critics consistently miss without prompting — the others fall out of "find what's wrong" naturally):
- Vague language ("ensure," "verify," "handle appropriately")
- Decisions that look small but have large blast radius
- Underspecified error/failure handling

Empty critique is a valid output. Do not pad. Every critique must cite a specific section of the plan or issue.

Hedge ban: every critique is committed pushback or no critique at all. If you can articulate the concern as a flaw with a citation, state it forcefully. If you can't, omit it. Banned: "minor concern," "worth noting," "consider whether," "might want to," "could potentially."

Output format:
- Critique 1: [issue] — [evidence]
- Critique 2: [issue] — [evidence]
- ...
- (or: "No substantive issues found")
```

Save the Round 1 critique to `docs/protocol-test-runs/issue-$1-r1.md`.

## Phase 5: Revise plan based on Round 1

Read the critique. For each item:
- If valid → revise the plan to address it
- If invalid → note your reasoning, do not change the plan

Produce **plan v2**. Save to sidecar file `docs/protocol-test-runs/issue-$1-v2.md` (and Round 1 critique to `issue-$1-r1.md`, plan v1 to `issue-$1-v1.md` if not yet saved). The main output file gets the evolution summary in Phase 10, not the verbatim drafts.

## Phase 6: Critic Round 2 — "What evidence grounds this revised plan?"

Dispatch a subagent with the `Task` tool. Give it:

- Plan v2 (full text)
- Round 1 critique (so the critic can see what the planner was responding to and audit the revision honestly, not re-litigate R1 items)
- The issue body
- The list of files you read in Phase 1
- The Scope Envelope from Phase 2B
- This instruction:

```
You are a Critic. The plan v2 above is a revision of an earlier draft after Round 1 critique. Round 1 critique is included so you can see the surface area the planner was working against — not so you can re-litigate it.

Your job: identify what evidence grounds the architectural decisions in plan v2.

For every architectural decision, determine:
- Grounded — cites a specific file:line, doc, issue, precedent, or scope envelope routing
- Assumption — explicit, with stated rationale
- UNGROUNDED — claim presented as fact without support

Do not accept vague groundings ("based on the system architecture") — demand specifics.
Empty list is valid output if all decisions are well-grounded.

Hedge ban: every audit verdict is committed (Grounded, Assumption, or UNGROUNDED). Do not soften UNGROUNDED into "weakly grounded" or "could use more support." Either it's grounded with a specific citation, it's an explicit assumption with rationale, or it's UNGROUNDED.

Output format:
- Decision X — Grounded: [specific source]
- Decision Y — Assumption: [stated rationale, accept]
- Decision Z — UNGROUNDED: [what's missing]
- ...
```

Save the Round 2 critique to `docs/protocol-test-runs/issue-$1-r2.md`.

## Phase 7: Revise plan based on Round 2

For each ungrounded decision:
- Either find evidence and add it to the plan, or
- Convert it to a stated assumption with explicit rationale, or
- If you can't ground it and can't justify it as an assumption, mark it explicitly in the evidence trail as "UNGROUNDED — Reviewer escalation"

Produce **plan v3** with an explicit evidence trail. Save to sidecar `docs/protocol-test-runs/issue-$1-v3.md` (and Round 2 critique to `issue-$1-r2.md`).

## Phase 8: Critic Round 3 — "What would we need to learn to know this is the right approach?"

Dispatch a subagent with the `Task` tool, specifying `model: opus`. Give it:

- Plan v3 (full text)
- Round 1 critique (so the critic sees how the plan evolved without re-litigating)
- Round 2 critique
- The issue body
- The Scope Envelope from Phase 2B
- This instruction:

```
You are a Critic. The plan has evolved through two prior critique rounds (included above for context, not for re-litigation).

Your job: answer this question.

What would we need to learn to know this is the right approach — not just an okay one?

A "needed-to-learn" item is a question whose answer would change the plan, AND which can't be resolved by reading the codebase or available docs. These are external unknowns: things only the operator, the user, or the world outside this repo can answer.

Empty output is valid. Do not pad.

Hedge ban: every item is a concrete question. No "potential concern," no "may want to consider," no "worth thinking about." If you can't state it concretely, omit it.

Output format:
- Question: [the question]
  Why it matters: [how the plan would change if the answer differed]
- ...
(or: "None")
```

Save the Round 3 critique to `docs/protocol-test-runs/issue-$1-r3.md`.

## Phase 9: Resolve and finalize

For each external unknown Round 3 surfaced:
- If you can answer it from the codebase or docs → answer it, cite the source, integrate the answer into the plan (which means it wasn't truly external — Round 3 misclassified, that's fine)
- If you cannot answer it → mark it explicitly in the evidence trail as "UNRESOLVED — Reviewer escalation"

If Round 3 surfaced an unknown that suggests the underlying approach is wrong (not just incomplete), revise more substantially — don't paper over it.

Produce **plan v4 (final)**. Save verbatim.

## Phase 10: Write output

Write the test/production output to the location Claude Code determines is appropriate (typically `docs/protocol-test-runs/issue-$1-three-round.md` for test runs, or wherever the project convention places plan files for production).

Format:

```
---
issue: $1
protocol: three-round
---

==========================================
PLAN: Issue #$1 — [title]
==========================================

PROTOCOL: three-round
ROUNDS COMPLETED: 1, 2, 3
ISSUE TYPE: atomic implementation

---

## SCOPE ENVELOPE

Phase 2B reconnaissance output. Empty findings are valuable — they prove reconnaissance ran.

- **Siblings:** [list with file:line, or "none found"]
- **Conflicts:** [in-flight plans / open PRs, or "none found"]
- **Staleness:** [clean / soft: <evidence> / HARD: <evidence>]
- **Dependencies:** [issue numbers with state, or "none found"]
- **Scope magnitude:** [trivial / non-trivial — (a) files touched: N, (b) schema/contract/cross-system: yes/no, (c) behavioral delta: yes/no]
- **Operator routing:** [paste verbatim each (b)-class question and the operator's answer; or "no operator interrupt — all checks clean"]

---

## Plan evolution summary

One paragraph per version. What changed and why. The Reviewer reads this to assess plan quality without re-reading every draft. If the Reviewer wants to dispute a specific revision, intermediates are saved as sidecar files (see below).

- **v1 → v2 (R1 driven):** [what R1 caught, what changed in v2, in 2-3 sentences]
- **v2 → v3 (R2 driven):** [what R2 caught about evidence/grounding, what changed in v3]
- **v3 → v4 (R3 driven):** [what R3 surfaced as external unknowns, what got resolved vs escalated]

Sidecar files (saved alongside this output, not embedded — Reviewer fetches if needed):
- `docs/protocol-test-runs/issue-$1-v1.md` — plan v1
- `docs/protocol-test-runs/issue-$1-v2.md` — plan v2
- `docs/protocol-test-runs/issue-$1-v3.md` — plan v3
- `docs/protocol-test-runs/issue-$1-r1.md` — Round 1 critique
- `docs/protocol-test-runs/issue-$1-r2.md` — Round 2 critique
- `docs/protocol-test-runs/issue-$1-r3.md` — Round 3 critique

---

## Plan v4 (final)
[full text of plan v4]

---

## EVIDENCE TRAIL

For Reviewer use. Every architectural decision in plan v4, with grounding.

- Decision 1: [statement] — Grounded in [source]
- Decision 2: [statement] — Grounded in [source]
- Decision 3: [statement] — ASSUMPTION: [rationale]
- Decision 4: [statement] — UNGROUNDED: Reviewer escalation
- ...

## DEPENDENCIES

- Blocked by: [issue numbers still open that this needs]
- Unblocks: [issue numbers waiting on this]
- Touches: [other workstreams or master plans this affects]

## CROSS-SYSTEM EFFECTS

- [system 1]: [how this plan affects it]
- [system 2]: [how this plan affects it]
- ...

## PROTOCOL NOTES

- Total subagent dispatches: 3
- Round 1 critiques surfaced: [count]
- Round 1 critiques addressed: [count]
- Round 2 ungrounded decisions found: [count]
- Round 2 resolutions: [count] with evidence / [count] converted to assumption / [count] escalated to Reviewer
- Round 3 external unknowns surfaced: [count]
- Round 3 items resolved by Planner: [count]
- Round 3 items escalated to Reviewer: [count]

---

## ISSUE MANAGEMENT

Read this before implementation. The implementer (whether human, autonomous run, or follow-on Claude session) is contracted to follow these handoffs. The Planner populates each subsection with specifics — not just the template.

### Out-of-scope items to file as tracking issues

For each item in the plan's "Out of scope" section, the Planner classifies as either:
- **Will-do-later** → file a tracking issue **before this plan's PR merges**.
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
- Sub-populations the plan's filter excludes (e.g., "the fix targets specific modules but discovery surfaced foundation modules with the same symptom")
- Workarounds applied during a fix that need permanent attention

→ File a new GitHub issue **before merging this plan's PR**.
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

This codebase ships via direct push to `main`, not via PRs. The `Closes #$1` keyword must appear on its own line in the **commit message body**, so GitHub auto-closes the linked issue when the commit lands on `main`.

```
fix(scope): one-line subject

Closes #$1
```

Subject-line `(#N)` parens are a PR-number convention only — they do NOT trigger auto-close. Verify by previewing `git log -1 HEAD` before pushing; if `Closes #N` isn't on its own line in the body, fix the message before push.

Do not create a PR unless explicitly authorized. Direct push to `main` is the convention. Issues without the autoclose keyword stay open after the fix ships, accumulating false-positive backlog (the planning pipeline burned 3 of 9 plan slots on already-shipped work in the 2026-W19 sprint due to this exact failure mode).

### Master plan registration

If this plan affects a workstream with a master plan (any `docs/plans/*.md` master file), the implementer adds a one-line entry: date, commit hash, what shipped. Without this entry, the next session has no awareness this work landed.

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

---

## Close-out: Debrief

After implementation is complete, create `docs/debriefs/issue-$1.md`. Fill in every section —
do not leave template placeholders. Skip this step only if the plan was ABORTED.

    ---
    issue: $1
    date: [today's date, ISO-8601]
    protocol: three-round
    ---

    ## Scope delta
    What was added, cut, or changed vs. the original plan?

    ## Discoveries
    What did execution reveal that the plan didn't know? Missing dependencies,
    undocumented constraints, things figured out mid-build.

    ## Decisions made during execution
    For each non-trivial decision:
    - **Decision:** [what was decided]
    - **Why:** [the principle, not just the fact]

    ## What broke
    Bugs, fragile patterns, things that failed before they worked.

    ## Issues filed during implementation
    Every GitHub issue created during this work, with one-line context:
    - #N: [title] — filed because [out-of-scope sibling | discovered-during-impl | deferred-in-code gate]
    - #N: ...
    (Or: "None — plan was atomic, no follow-up issues surfaced.")

    ## Plan quality
    Did the plan help or hinder? What would have made it better?
```

## Phase 11: Link plan back to GitHub issue

**If plan was ABORTED (Phase 2):** Post an abort trail comment so the issue isn't re-triaged blind:
```bash
gh issue comment $1 --body "**Planning attempted — aborted.**

Reason: [reason from Phase 2 abort]"
```
No label added. Skip Phase 12.

**If plan completed normally:**
```bash
gh issue edit $1 --remove-label "planned,ready,needs-operator,abandoned" 2>/dev/null || true
gh label create "planned" --color "0075ca" --description "Planning protocol complete" 2>/dev/null || true
gh issue edit $1 --add-label "planned"
gh issue comment $1 --body "**Planning protocol complete.** Plan artifact: \`docs/protocol-test-runs/issue-$1-three-round.md\`

Reviewer running now."
```

## Phase 12: Auto-invoke reviewer

Skip if plan was ABORTED.

Dispatch the reviewer as a subagent using the Agent tool. Pass:
- `model: opus` — Reviewer judgment is load-bearing (verdict survives adversarial pass, decides what reaches {{OPERATOR}}). Pin Opus regardless of session model. If a model-cost-mode override at invocation time explicitly says otherwise, follow that — but the default for this dispatch is Opus, not the session inheritance.
- The plan file path produced in Phase 10
- The issue number $1 (explicit — do not rely on parsing)
- This instruction: "You are the Reviewer. Run the full review-plans protocol on the plan file at [path]. Issue number for GitHub write-back is $1."

**If the Agent dispatch fails or the subagent errors:**
```bash
gh issue comment $1 --body "**Reviewer auto-invoke failed.**
Run \`/review-plans docs/protocol-test-runs/issue-$1-three-round.md $1\` manually."
```
Leave the `planned` label in place — it correctly signals plan exists, review incomplete. Do not re-attempt.

**If the subagent succeeds:** Relay the reviewer's verdict (READY / NEEDS MIKE / ABANDON + key items) to the user in one short paragraph.

## Reminders

- Save plan v1, v2, v3 and the three critique outputs to sidecar files (`docs/protocol-test-runs/issue-$1-v{1,2,3}.md` and `-r{1,2,3}.md`). The main output file gets the evolution summary plus plan v4 verbatim only. The Reviewer reads the main file by default and fetches sidecars only on dispute.

- Do not produce a NEEDS HUMAN INPUT section. The Reviewer determines what needs {{OPERATOR}}, not the Planner. Your job is to surface constraints; the Reviewer's job is to triage.

- Do not produce a dispatch-ready prompt. The Reviewer or {{OPERATOR}} handles dispatch separately.

- If Round 3 surfaces nothing — empty list — that's a positive signal. It means the plan has reached the constraint density where the answer is determined. Do not pad to fill space.

- If the issue is too ambiguous to plan against (Phase 2 abort), say so and stop. Don't produce a plan that's mostly assumptions.

- Include the ISSUE MANAGEMENT section in every non-aborted plan output. Populate the out-of-scope-to-file list and master-plan list with specifics — not template placeholders. The implementer reads this section to know what tracking issues to file before merging the PR. Empty subsections are valid (state "No tracking issues to file" or "No master plan affected"); template boilerplate left in place is not.

- Include the Close-out: Debrief section in every non-aborted plan output. Do not omit it.
