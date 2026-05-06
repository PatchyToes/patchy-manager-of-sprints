---
description: Plan the next module's worth of sprint issues sequentially in one session. Auto-picks protocol (3-round vs 1-round) per issue from the scope-gate verdict. (Requires: an active sprint with `scoped` issues — run /sprint-start first.)
argument-hint: [<module-slug>]
---

# Sprint Plan (v1)

{{INCLUDE:glossary}}

**Session model:** Inherit from caller. The skill itself does no reasoning — it's a sequential dispatcher over the existing planner skills, which pin Opus on their own critic dispatches.

**One module per session.** This is the planning unit. A 6-issue module = 6 sequential planner runs in one session. The planner files (`docs/protocol-test-runs/issue-N-*.md`) accumulate as the session progresses. Sessions are resumable — each run filters to scoped-but-not-planned, so an interrupted session picks up where it stopped.

## Phase A: Announce

Before any tool calls, print this preamble exactly (with a trailing blank line). Plain text — do not wrap in code fences or add Markdown.

```
═══ SPRINT · plan ═══
Planning the next module sequentially. Reviewer auto-runs after each plan. This takes a while — walk away.
```

## Phase 0: Tool-availability gate (fail-closed)

```bash
gh auth status >/dev/null 2>&1 || { echo "Sprint plan abort: gh not authenticated."; exit 1; }
gh repo view --json name >/dev/null 2>&1 || { echo "Sprint plan abort: gh cannot reach current repo."; exit 1; }
```

Verify `Task`/`Agent` tool availability — required by the underlying planner. Same probe as `/plan-issue-three-round` Phase 0:

- Inspect available-tools list for `Task` or `Agent`
- If absent: abort with `Sprint plan abort: planner requires Task/Agent dispatch tool unavailable in this session.`

{{INCLUDE:scratchpad-read}}

## Phase 1: Resolve target module

If `$1` was passed, treat it as the target module slug (kebab-case, e.g. `module-a`, `multi-word-module`).

Map the slug back to the canonical module name from `docs/modules.md`:
- Read all H2 headings from `docs/modules.md`
- For each, compute `slug = lowercase(name).replace(/[^a-z0-9]+/g, '-').trim('-')` (strip `&` to nothing, collapse spaces+ampersands+commas to single hyphens)
  - Example: `Billing, Subscription & Credits` → `billing-subscription-credits`
  - Example: `Multi Word Module` → `multi-word-module`
- Match `$1` against computed slugs (case-insensitive)
- If no match: abort with `Sprint plan abort: module slug "<slug>" not found. Run /sprint to see available modules.`

If `$1` was NOT passed:

1. Read sprint state (Phase 2 below)
2. Pick the first module (in `/sprint`'s natural sort order) that has any unplanned scoped sprint issues
3. If no module has unplanned issues: print `Sprint plan: nothing to plan — all sprint issues are past the planning stage. Run /sprint for status.` and exit 0

## Phase 2: Enumerate target issues

```bash
gh issue list --state open --label sprint --label scoped --limit 100 --json number,title,labels
```

For each result:
1. Fetch the most recent `<!-- SCOPE-GATE -->` comment to read `Module:` and verdict (`PLAN-3-ROUND` vs `PLAN-1-ROUND`)
2. Skip if labeled `planned`, `ready`, `needs-operator`, or `abandoned` (already past planning)
3. Filter to issues whose module matches the target

Order the resulting list by:
1. Risk: HIGH → MEDIUM → LOW (high-risk planned first while session is fresh)
2. Issue number ascending

If empty:
```
Sprint plan: module "<slug>" has no unplanned issues. Either it's already done or it's not in the sprint.
Run /sprint for status.
```
Exit 0.

## Phase 3: Pre-flight summary

Print before dispatching:

```
==========================================
SPRINT-PLAN: <module-slug> — N issues
==========================================

Sequential planning order:
  1. #341 — [title] (HIGH · PLAN-3-ROUND)
  2. #350 — [title] (MED · PLAN-3-ROUND)
  3. #361 — [title] (MED · PLAN-1-ROUND)
  ...

Each issue runs the appropriate planner protocol. Reviewer auto-invokes after each plan.
Estimated: ~K Opus subagent dispatches across ~T minutes wall time.

Starting in 3 seconds. Ctrl-C to abort.
```

Sleep 3 seconds, then proceed.

## Phase 4: Sequential dispatch

For each issue in order:

1. **Re-check labels** before dispatching (race-safety — another session may have planned this issue while we were processing prior items):
   ```bash
   gh issue view N --json labels --jq '[.labels[].name]'
   ```
   Skip the issue if it now carries `planned`, `ready`, `needs-operator`, or `abandoned`. Log: `Skipped #N — already planned (likely concurrent session).`

2. **Dispatch the appropriate planner.** Map the scope-gate verdict to a skill:
   - `PLAN-3-ROUND` → use the Skill tool to invoke `plan-issue-three-round` with arg `N`
   - `PLAN-1-ROUND` → use the Skill tool to invoke `plan-issue-one-round` with arg `N`

   Skill-tool invocation preserves all the planner's Phase-0 fail-closed gates and its auto-invoke of the reviewer at the end. If skill-from-skill invocation fails for any reason, fall back to dispatching via `Task` with `model: opus` and the planner's instructions inline.

3. **Wait for completion.** The planner runs through Phase 12 / Phase 8 (auto-invokes the reviewer). When the planner reports back, capture:
   - Final verdict (READY / NEEDS {{OPERATOR}} / ABANDON) from the reviewer
   - Plan file path
   - Any failures or aborts

4. **Per-issue status line.** After each issue completes, print one line:
   ```
   [N of N_total] #ISSUE → READY (plan: docs/protocol-test-runs/issue-N-three-round.md)
   ```
   Or on abort:
   ```
   [N of N_total] #ISSUE → ABORTED (reason)
   ```

5. **Continue to the next issue.** Do not stop on individual aborts — log them and move on. The session's value is the cohort of plans, not any single plan.

## Phase 5: Final summary

After the loop completes:

```
==========================================
SPRINT-PLAN COMPLETE — <module-slug>
==========================================

Planned: K of N
  - READY:    #N1, #N2, #N3
  - NEEDS {{OPERATOR}}: #N4 ([reviewer escalation summary, one line])
  - ABANDONED: #N5 ([reason])
Skipped (concurrent): #N6, #N7
Aborted: #N8 ([reason])

Module status: K planned, J still scoped (run again to resume)

Next:
  /sprint                    — see updated sprint status
  /sprint-walkthrough        — walk through K READY plans
  /sprint-plan <next-module> — plan another module
```

If everything in the module planned successfully (no remaining `scoped` in this module):
- Add suffix: `Module fully planned. /sprint-plan with no arg will pick the next module.`

## Standing rules

- **Sequential, not parallel.** Within one session, plans run one at a time. Parallelism happens by opening multiple Claude Code windows and naming different modules in each. Do not try to dispatch concurrent planners from inside a single `/sprint-plan` invocation.
- **No interactive operator gates.** Once dispatched, the loop runs unattended. The underlying planner skills handle their own operator interactions (Phase 2B reconnaissance routing).
- **Resumable by re-run.** A crashed or interrupted `/sprint-plan` recovers by re-running with the same module argument. The label filter ensures already-planned issues are skipped.
- **Auto-protocol from the scope verdict.** Do not override. If the operator wants a different protocol on a specific issue, they invoke `/plan-issue-three-round N` or `/plan-issue-one-round N` directly outside the sprint loop.
- **Don't reimplement the planner.** This skill is a sequencer. All planning logic lives in `/plan-issue-three-round` and `/plan-issue-one-round`. If you find yourself drafting evidence trails or critic prompts here, you're in the wrong file.
