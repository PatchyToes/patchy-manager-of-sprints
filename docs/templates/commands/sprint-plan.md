---
description: Plan the next module's worth of sprint issues sequentially in one orchestrator session. Auto-picks protocol (3-round vs 1-round) per issue from the scope-gate verdict. Executes the planner protocol inline per issue (no Skill-tool dispatch — that re-introduces nested-subagent failures). (Requires: Agent + SendMessage tools — needs `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` env. Active sprint with `scoped` issues — run /sprint-start first.)
argument-hint: [<module-slug>]
---

# Sprint Plan (v2)

{{INCLUDE:glossary}}

You are the **Multi-Issue Orchestrator**. You loop over a module's worth of sprint issues and run the orchestrator-mediated planner protocol on each, in this session.

**Critical architectural change from v1:** This skill no longer uses the Skill tool to dispatch the planner. Skill-tool dispatch puts the planner protocol inside a subagent, and the v4 planner protocols (`plan-issue-three-round.md` v4, `plan-issue-one-round.md` v4) themselves spawn planner and critic subagents — a nested dispatch that Claude Code does not support. This sprint-plan session IS the orchestrator; it directly spawns planner-N and critic-N subagents per issue, top-level, and SendMessages between them. Tear down between issues by abandoning the agent IDs.

**Session model:** Inherit from caller. The skill itself does no reasoning — it's a sequential dispatcher over the planner protocols, which pin Opus on their own subagent dispatches.

**One module per session.** This is the planning unit. A 6-issue module = 6 sequential planner-protocol executions in one session. Plan files (`docs/protocol-test-runs/issue-N-{three,one}-round.md` and the per-issue folders) accumulate as the session progresses. Sessions are resumable — each iteration filters to scoped-but-not-planned, so an interrupted session picks up where it stopped.

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

Verify both `Agent` and `SendMessage` are available. The v4 planner protocols require `SendMessage`, which is gated behind `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in `.claude/settings.local.json`.

- Inspect available-tools list for `Agent` and `SendMessage`.
- If either is absent: abort with `Sprint plan abort: planner requires Agent + SendMessage. Verify CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 in .claude/settings.local.json and restart Claude Code.`

{{INCLUDE:scratchpad-read}}

## Phase 1: Resolve target (module or batch)

A "batch" is the unit `/sprint-plan` processes per invocation, capped at 10 issues. `/sprint-start` writes the manifest with batches: single-batch modules use `<module-slug>` (e.g., `module-a`); multi-batch modules use `<module-slug>-batch-N` (e.g., `module-b-batch-2`).

### Step 1.1 — Read the manifest

Find the most recent sprint manifest. Prefers `S{N}` numbered format (numeric sort); falls back to legacy `2026-W{N}` only if no S-numbered manifests exist. Excludes `archive/` subfolder:

```bash
SPRINT_MANIFEST=$(ls docs/sprints/S*.md 2>/dev/null | sed -n 's|.*/\(S[0-9]\{1,\}\)\.md|\1|p' | sort -V | tail -1 | xargs -I {} echo "docs/sprints/{}.md")
[ -z "$SPRINT_MANIFEST" ] && SPRINT_MANIFEST=$(ls docs/sprints/*.md 2>/dev/null | grep -v '/archive/' | sort -r | head -1)
```

If no manifest exists, abort: `Sprint plan abort: no sprint manifest found. Run /sprint-start first.`

Parse the manifest's module headings (`## <module-slug> (...)`) and any `### Batch N — <batch-slug> (...)` subheadings. Build a map: `slug → [issue_numbers]`. Both module slugs (single-batch) and batch slugs (multi-batch) are valid targets.

### Step 1.2 — Resolve `$1`

If `$1` was passed:
- **Match against a batch slug** (e.g., `module-b-batch-2`) → target = that batch's issues only.
- **Match against a module slug for a single-batch module** (e.g., `module-a`) → target = all issues in that module.
- **Match against a module slug for a multi-batch module** (e.g., `module-b` when both `module-b-batch-1` and `module-b-batch-2` exist) → target = the first batch with unplanned issues. Print: `Module "module-b" has 2 batches; planning batch 1 first. Run /sprint-plan module-b-batch-2 next.`
- **No match** → abort with `Sprint plan abort: target "<slug>" not found in manifest. Available: <list of module/batch slugs>.`

If `$1` was NOT passed:

1. **Bulk-fetch all sprint label state in ONE call** — do not loop per issue. Use `gh --template` to avoid `jq` dependency:
   ```bash
   gh issue list --state open --label sprint --limit 200 --json number,labels \
     --template '{{range .}}{{.number}}|{{range .labels}}{{.name}},{{end}}{{"\n"}}{{end}}'
   ```
   Parse the output into a map: `issue_number → label_set`. This is the cache for unplanned-batch detection.
2. Iterate all batches in manifest order (modules in `/sprint`'s natural sort, batches within a module by index). For each batch, an issue is "available to plan" if its label set does NOT contain any of `planning`, `planned`, `ready`, `needs-operator`, `abandoned`. The `planning` filter is critical: it means another /sprint-plan session is currently working on that issue. Use the cached map; do not re-fetch.
3. Pick the first batch with any unplanned scoped sprint issues
4. If no batch has unplanned issues: print `Sprint plan: nothing to plan — all sprint issues are past the planning stage. Run /sprint for status.` and exit 0

**The target is always a single batch** (≤10 issues). Never plan more than one batch in a single `/sprint-plan` invocation, even if the operator passes a module slug for a multi-batch module. This is a hard cap. Do not "just plan the next batch too" — the operator runs `/sprint-plan` again for the next batch.

## Phase 2: Enumerate target issues (batch-bounded)

The target was resolved in Phase 1 to a specific batch (single-batch modules treat the whole module as one batch). The candidate list is the issue numbers in that batch's manifest entry — **already capped at ≤10**.

```bash
gh issue list --state open --label sprint --label scoped --limit 100 --json number,title,labels
```

Filter the live GitHub list to **only** the issue numbers from the target batch. Drop any GitHub issue not in the batch list (it belongs to a different batch and gets planned in a separate invocation).

For each remaining (in-batch) issue:
1. Fetch the most recent `<!-- SCOPE-GATE -->` comment to read `Module:` and verdict (`PLAN-3-ROUND` vs `PLAN-1-ROUND`)
2. Fetch the most recent `<!-- WALKTHROUGH-DECISION -->` comment, if any. **If it exists AND is newer than the SCOPE-GATE comment AND has a `Verdict:` field, use that verdict instead.** This is the contract handoff from `/sprint-walkthrough` for items the operator cleared from a NEEDS-OPERATOR state.
3. Skip if labeled `planning`, `planned`, `ready`, `needs-operator`, or `abandoned` (already past planning OR currently in flight in another session). **Do NOT skip on `needs-operator` alone** — if a WALKTHROUGH-DECISION comment cleared the verdict, the issue is plannable even if the label hasn't been stripped yet (label drift). The walkthrough strips `needs-operator` itself; this is defensive.

Order the resulting list by:
1. Risk: HIGH → MEDIUM → LOW (high-risk planned first while session is fresh)
2. Issue number ascending

**Sanity check.** The list length must be ≤10. If for any reason it's larger (manifest drift, bad parse), abort with `Sprint plan abort: target "<slug>" resolved to >10 issues — manifest may be corrupt. Re-run /sprint-doctor or check the manifest at <path>.` Do not silently plan an over-sized batch.

If the list is empty:
```
Sprint plan: target "<slug>" has no unplanned issues. Either this batch is already planned, or its issues moved past the planning stage.
Run /sprint for status.
```
Exit 0.

## Phase 3: Pre-flight summary

Print before dispatching. This is the operator's sanity-check window: every issue this session will attack is listed here, before any planner subagent spawns. Do not pause or sleep — the operator either reads it as it streams or scrolls back to it. The point is *visibility*, not gating.

```
==========================================
SPRINT-PLAN: <slug> — planning N issues
==========================================

Issues selected this run:
  1. #341 — [title] (HIGH · 3-round)
  2. #350 — [title] (MED · 3-round)
  3. #361 — [title] (MED · 1-round)
  ...

Reviewer auto-invokes after each plan. Aborts (Phase 2 hard-stops) route to needs-operator and the loop continues to the next issue — they are normal output, not failures.

Estimated: ~T min wall time, ~K subagent dispatches. Walk away — `/sprint` to check progress.
```

After printing, proceed directly to Phase 4. Do not sleep — the harness doesn't honor it and it just delays the first planner dispatch for no operator benefit.

## Phase 4: Sequential per-issue execution

For each issue in order:

### Step 4.0 — Print startup marker

Before any tool calls for this issue, print exactly one line so the operator can scroll back and see what's in flight without scanning subagent transcripts:

```
─── [N of N_total] STARTING #ISSUE — title (RISK · {3,1}-round) ───
```

This line is a visual anchor. Whatever the planner protocol does next — Phase 0 gates, Phase 1 context loading, Phase 2 reconnaissance, the planner+critic spawns — happens *under* this marker, so a glance at the stream tells the operator which issue is currently being chewed on.

### Step 4.1 — Re-check labels

Race-safety — another sprint-plan session may have planned this issue while we were processing prior items. Use `gh --template` (not `--jq`; `jq` is not always installed in the local environment, and `--template` produces what we need without external tools):

```bash
gh issue view N --json labels --template '{{range .labels}}{{.name}},{{end}}'
```

Output is a comma-separated label list (e.g. `p1-now,tech-debt,brain-pipeline,ready,scoped,sprint,`). Check for the skip set inline.

Skip the issue if it now carries `planning`, `planned`, `ready`, `needs-operator`, or `abandoned`. Log:
- `Skipped #N — currently being planned in another session.` (planning)
- `Skipped #N — already planned (concurrent session).` (planned/ready)
- `Skipped #N — needs operator decision.` (needs-operator)
- `Skipped #N — abandoned.` (abandoned)

Move to the next issue.

### Step 4.2 — Execute the appropriate planner protocol IN THIS SESSION

**Do NOT use the Skill tool to dispatch the planner.** Skill-tool dispatch puts the planner protocol inside a subagent, which then cannot spawn its own planner-N and critic-N subagents (Claude Code does not support nested subagent dispatch).

Instead, this sprint-plan session executes the planner protocol's phases directly, spawning planner-N and critic-N as top-level subagents.

The protocol to execute is determined by the scope-gate verdict for issue N:

- **PLAN-3-ROUND** → Execute every phase of [`.claude/commands/plan-issue-three-round.md`](.claude/commands/plan-issue-three-round.md) on issue N. This includes Phase 0 (pre-flight gates), Phase 1 (orchestrator context loading), Phase 2 (scope reconnaissance), Phase 3 (spawn planner-N), Phase 4 (spawn critic-N), Phases 5-9 (SendMessage round-trips between planner and critic), Phase 10 (write canonical output), Phase 11 (GitHub link), Phase 12 (auto-invoke reviewer).

- **PLAN-1-ROUND** → Execute every phase of [`.claude/commands/plan-issue-one-round.md`](.claude/commands/plan-issue-one-round.md) on issue N. This includes Phase 0 through Phase 8.

The planner protocol skill files contain the full per-phase instructions. Read them if you need refresher context. The orchestrator (you) is responsible for following each phase in order.

**Subagent naming.** When spawning subagents inside the planner protocol for issue N, use names `planner-N` and `critic-N` (e.g., `planner-341`, `critic-341`). The number in the name disambiguates between issues so logs and cleanup are clear.

### Step 4.3 — Wait for protocol completion

The planner protocol's final phase auto-invokes the reviewer. When the reviewer returns, capture:
- Final verdict (READY / NEEDS {{OPERATOR}} / ABANDON) from the reviewer
- Plan file path (`docs/protocol-test-runs/issue-N-{three,one}-round.md`)
- Any failures or aborts during the protocol

### Step 4.4 — Per-issue status line

After each issue completes, print one line:

```
[N of N_total] #ISSUE → READY (plan: docs/protocol-test-runs/issue-N-three-round.md)
```

Or on abort:

```
[N of N_total] #ISSUE → ABORTED (reason)
```

### Step 4.5 — Tear down subagents and continue

The planner-N and critic-N subagents from this issue's protocol are now idle. Abandon their `agentId`s — do not SendMessage them again. They idle out and get GC'd.

**Do not stop on individual aborts** — log them and move on. The session's value is the cohort of plans, not any single plan.

Continue to the next issue. Each new issue's protocol spawns fresh `planner-{N+1}` and `critic-{N+1}` subagents (no cross-issue context bleed).

## Phase 5: Final summary

After the loop completes:

```
==========================================
SPRINT-PLAN COMPLETE — <slug>
==========================================

Planned: K of N (in this batch)
  - READY:    #N1, #N2, #N3
  - NEEDS {{OPERATOR}}: #N4 ([reviewer escalation summary, one line])
  - ABANDONED: #N5 ([reason])
Skipped (concurrent): #N6, #N7
Aborted: #N8 ([reason])

**What just happened**
{K} planner protocols completed in this batch. Each spawned its own planner+critic subagents
and dispatched the reviewer. Plans are at docs/protocol-test-runs/issue-N-{three,one}-round.md per issue.

**Where you are now**
[fill from manifest state — see below]

**Your next step**
[fill from manifest state — see below]
```

### Determining "Where you are now" and "Your next step"

After the batch completes, parse the manifest again to find the next unplanned batch (across ALL modules, in manifest order):

- **If the just-completed slug was a batch (multi-batch module) AND more batches in the same module remain unplanned:**
  ```
  **Where you are now**
  Module <module-name>: batch <N> done. Batches <N+1>..<last> remain.

  **Your next step**
  `/sprint-plan <module-slug>-batch-<N+1>` — plan the next batch in this module.
  ```

- **If the just-completed slug was the last batch of its module AND another module/batch is unplanned:**
  ```
  **Where you are now**
  Module <module-name> fully planned. Next up: <next-module-or-batch-slug>.

  **Your next step**
  `/sprint-plan` (no arg) — auto-picks the next batch.
  Or `/sprint-walkthrough` to walk through what's READY so far.
  ```

- **If the entire sprint is now fully planned:**
  ```
  **Where you are now**
  Sprint fully planned. All batches complete.

  **Your next step**
  `/sprint-walkthrough` — walk every READY plan and any `needs-operator` items.
  ```

- **If items remain in the current target batch (incomplete run — concurrent skip, abort, etc.):**
  ```
  **Where you are now**
  Batch <slug>: K planned, J still scoped (run again to resume).

  **Your next step**
  `/sprint-plan <slug>` — re-run to retry remaining issues in this batch.
  ```

**Always name the specific next slug.** Don't say "plan another module" — name it. The operator's mental model is one verb per turn; resolve ambiguity in the output.

### Needs-operator pile-up check

After the summary, count `needs-operator` items across the whole sprint. Use `gh --template` to avoid `jq` dependency:

```bash
gh issue list --state open --label sprint --label needs-operator --json number --template '{{len .}}'
```

If count > 0, append a one-line note to the summary:
```
⚠ K item(s) sprint-wide are parked at needs-operator. Run /sprint-walkthrough when convenient — they need your call.
```

If count = 0, omit the line.

## Standing rules

- **Sequential, not parallel.** Within one session, plans run one at a time. Parallelism happens by opening multiple Claude Code windows and naming different modules in each. Do not try to dispatch concurrent planner protocols from inside a single `/sprint-plan` invocation — agent ID collisions are possible (planner-341 in two parallel branches), and the orchestrator session can't manage two SendMessage threads cleanly.

- **No interactive operator gates between issues.** Once dispatched, the loop runs unattended. The underlying planner protocols handle their own operator interactions (Phase 2B reconnaissance routing).

- **Resumable by re-run.** A crashed or interrupted `/sprint-plan` recovers by re-running with the same module argument. The label filter ensures already-planned issues are skipped.

- **Auto-protocol from the scope verdict.** Do not override. If the operator wants a different protocol on a specific issue, they invoke `/plan-issue-three-round N` or `/plan-issue-one-round N` directly outside the sprint loop.

- **No Skill-tool dispatch of the planner.** This is the architectural lesson from v1's nested-dispatch failure. The orchestrator (this session) executes the planner protocol's phases directly. Subagents (planner-N, critic-N) are top-level dispatches, never nested.

- **Don't reimplement the planner.** This skill is a sequencer. All planning logic lives in `/plan-issue-three-round` and `/plan-issue-one-round`. If you find yourself drafting evidence trails or critic prompts here, read those skills instead.

- **Subagent IDs scope to one issue.** `planner-341` and `critic-341` are abandoned after issue 341's protocol completes. Issue 350 spawns fresh `planner-350` and `critic-350`. No cross-issue SendMessage. No reuse.

- **Failure recovery is per-issue, not per-sprint.** If issue 341's protocol fails mid-flight (subagent dies, SendMessage timeouts, etc.), abort that issue's protocol and move on to issue 350. The next `/sprint-plan` run will pick up issue 341 again because it won't have the `planned` label (and `planning` will have been stripped by the abort cleanup).

- **Worker semantic, not orchestrator.** This skill is a worker. It picks the next available batch, attacks the issues in it one at a time, and reports the outcome. It does NOT decide what to do about aborts — those are routed to `needs-operator` by the planner protocol and surface in `/sprint-walkthrough` for the operator. Aborts are *normal output*, not failures. The loop never panics, never restructures the sprint, never decides "this batch can't be planned, let's skip the whole thing." If individual issues abort, they abort — sprint-plan keeps going to the next available issue.

- **The `planning` label is the in-flight lock.** When the planner adds it, this issue is "taken." When the planner strips it (Phase 11 success or Phase 2 abort cleanup), it's available again. Concurrent /sprint-plan windows skip `planning`-labeled issues and find their next available work elsewhere. If a planner crashes and leaves a stale `planning` label, `/sprint-doctor` detects + strips it.

- **Do NOT read issue bodies in this skill.** The planner protocol's Phase 2 reconnaissance handles defer-signal scans, abort detection, and scope reconnaissance INSIDE the planner subagent — that's where it belongs. Pulling issue bodies (especially with GIC blocks, ~5-10k tokens each) into the orchestrator's main-session context bloats it for no quality gain. The orchestrator only needs labels and SCOPE-GATE comment verdicts to route issues into the loop. Bodies belong to the planner subagent's first-turn context, not the orchestrator's.

- **Do NOT use `jq` in this skill's bash.** `jq` is not always installed locally. Use `gh --template` syntax (Go templates, built into `gh`) for everything: filtering, counting, label parsing. Examples in Phase 1 step 1.2 and Step 4.1. If you find yourself reaching for `jq`, restructure as a `gh --template` instead.

- **Bulk-fetch label state once per Phase, not per issue.** Phase 1 step 1.2's bulk fetch is the source of truth for "is this issue unplanned?" — Phase 4.1's per-iteration check is only the race-safety re-fetch right before dispatch. Do not re-fetch the whole sprint's labels mid-loop.
