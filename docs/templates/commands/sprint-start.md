---
description: Sunday-night ritual. Picks the week's sprint from `scoped` issues — groups by module, flags rot, surfaces clusters, labels chosen issues `sprint`, writes a manifest. Run once per week.
argument-hint: [--size N | --dry-run]
---

# Sprint Start (v1)

{{INCLUDE:glossary}}

**Session model:** Sonnet. Picking is mechanical synthesis of label state + module map; no architectural reasoning required. Use Opus only if you suspect the picker's clustering is degenerating.

**One sprint at a time.** A "sprint" is the set of issues labeled `sprint` in GitHub. There is no concept of multiple concurrent sprints. If `sprint` label already exists on any open issue when this skill runs, refuse with a pointer to `/sprint-end`.

You produce a proposed sprint, get {{OPERATOR}}'s confirmation, then commit it by labeling issues and writing the manifest.

Optional flags from $1:
- `--size N` — target sprint size (default: 25 issues)
- `--dry-run` — produce the proposal, skip label writes and manifest

## Phase A: Announce

Before any tool calls, print this preamble exactly (with a trailing blank line). Plain text — do not wrap in code fences or add Markdown.

```
═══ SPRINT · start ═══
Picking this week's sprint from the scoped backlog. I'll propose, then wait for your confirmation before writing labels.
```

## Phase 0: Tool-availability gate (fail-closed)

```bash
gh auth status >/dev/null 2>&1 || { echo "Sprint start abort: gh not authenticated."; exit 1; }
gh repo view --json name >/dev/null 2>&1 || { echo "Sprint start abort: gh cannot reach current repo."; exit 1; }
git --version >/dev/null 2>&1 || { echo "Sprint start abort: git not in PATH."; exit 1; }
```

## Phase 1: Pre-flight checks

### 1A. Refuse if a sprint is already in flight

```bash
gh issue list --state open --label sprint --limit 1 --json number
```

If any open issue carries `sprint`: stop. Print:

```
Sprint already in flight. Run `/sprint-end` to close out the current sprint, then re-run `/sprint-start`.
Current sprint members:
  gh issue list --state open --label sprint
```

Do not propose a new sprint. Do not append. One sprint at a time, period.

### 1B. Compute sprint identifier

```bash
LAST_N=$(ls docs/sprints/S*.md docs/sprints/archive/S*.md 2>/dev/null | sed -n 's|.*/S0*\([0-9]\{1,\}\)\.md|\1|p' | sort -n | tail -1)
SPRINT_ID=$(printf 'S%03d' $(( ${LAST_N:-0} + 1 )))
```

Sprint IDs are sequential numbers, zero-padded to 3 digits (`S001`, `S002`, …, `S099`, `S100`, … through `S999`). Padding ensures stable lex sort across the full range and visual alignment in `/sprint` output. On first run with no existing `S{N}.md` manifests, defaults to `S001`. Each subsequent run increments the highest existing number found in `docs/sprints/` or `docs/sprints/archive/` (leading zeros stripped during numeric comparison). Used for the manifest filename and the manifest header. Week-numbered IDs (`2026-W19`) are retired — kept only for already-archived sprints.

### 1C. Confirm the modules map exists

```bash
[ -f docs/modules.md ] || { echo "Sprint start abort: docs/modules.md missing — module grouping is load-bearing for sprint picking."; exit 1; }
```

### 1D. Scoped-pool freshness — safety-net auto-refresh

In normal flow, `/sprint-end` refreshed the scoped pool when the previous sprint closed, so this check is usually a no-op. It exists as a safety net for: (a) first-ever sprint with no prior `/sprint-end`, (b) skipped weeks where no `/sprint-end` ran, (c) backlog hygiene drift.

Three signals are checked. **The action depends on which signal trips** — they need different remedies and different cost profiles.

**Signal 1 — last batch-scope run is >7 days old.**
```bash
LAST_BATCH=$(ls tmp/batch-scope-run-*.txt 2>/dev/null | sort -r | head -1 | sed 's/.*batch-scope-run-\(.*\)\.txt/\1/')
DAYS_SINCE=$(( ( $(date +%s) - $(date -d "$LAST_BATCH" +%s 2>/dev/null || echo 0) ) / 86400 ))
```
If `$DAYS_SINCE > 7` or `$LAST_BATCH` is empty → STALE-EXISTING. **Action:** `/batch-scope --force` (re-classifies the existing pool because aging classifications drift).

**Signal 2 — UNSCOPED open issues exceed 5.**

Critical: filter must exclude EVERY pipeline state label, not just `scoped`/`deferred`/`scope:abort`. State labels are mutually exclusive — an issue labeled `planned` or `ready` no longer carries `scoped`, but it's still past the scope gate and must not be re-counted as needs-triage. Use the full exclusion set:

```bash
gh issue list --state open --search \
  "-label:scoped -label:deferred -label:scope:abort -label:tracking \
   -label:planned -label:ready -label:needs-operator \
   -label:abandoned -label:greenlit -label:sprint" \
  --limit 50 --json number | jq 'length'
```

If `> 5` → NEW-ONLY-STALE. **Action:** `/batch-scope` *without* `--force` (TTL-skips the existing scoped pool, processes only the truly unscoped issues — typically ~5-15 gh writes, not the full 100+ a force run would do).

**Signal 3 — cross-cutting share exceeds 50% in the current scoped pool.**
Compute by sampling the most recent SCOPE-GATE comments on the scoped pool (cap at 30 issues for runtime). If `cross-cutting / sampled > 0.5` → STALE-EXISTING. **Action:** `/batch-scope --force` (the path-only heuristic from older runs is dominating; the new tier-2/tier-3 fallback needs to be applied).

**Combined action rule:**

| Tripped signals | Action |
|---|---|
| Signal 2 only | `/batch-scope` (no --force) — process only the new issues |
| Signal 1 OR Signal 3 (with or without 2) | `/batch-scope --force` — re-classify existing pool, sweeps new issues too |

**Print before refreshing (name the signal that tripped):**
```
⟳ Scoped pool needs refresh (signal: <reason>). Running <command> before picking.
[ETA estimate based on number of issues to process.]
```

Then use the Skill tool to invoke `batch-scope` with the appropriate arg (`--force` or no flag, per the action rule above). If skill-from-skill invocation fails, inline the batch-scope logic (Phases 0–6 of `/batch-scope`). After it completes, re-read the scoped pool and proceed to Phase 2 with the fresh classification.

**If no signal trips:** silently proceed. Do not announce "pool is fresh" — the absence of a refresh notice is itself the signal.

## Phase 2: Read the candidate pool

```bash
gh issue list --state open --label scoped \
  --search "-label:planned -label:ready -label:needs-operator -label:greenlit -label:implementing -label:abandoned" \
  --limit 500 --json number,title,body,labels
```

The `--search` exclusions are load-bearing. State labels are *supposed to be* mutually exclusive (an issue past planning shouldn't still carry `scoped`), but **label drift happens** — a `/scope-issue --force` re-run, a manual `gh issue edit` adding `scoped` back, or a sprint that ended without stripping `scoped` from rolled-forward `ready` issues all produce dual-labeled issues. Without the explicit exclusions, `--label scoped` will pull in past-planning issues that should stay where they are. This was the source of the W19b → W19 #475 in-flight collision (2026-05-06).

The exclusion set covers every state label downstream of `scoped`:
- `planned` — planner has already run
- `ready` — reviewer has cleared the plan
- `needs-operator` — reviewer escalated, awaiting operator decision (covers the merged needs-mike/needs-operator state)
- `greenlit` — walkthrough cleared, ready to ship
- `implementing` — implementation session in flight (parallel-window claim)
- `abandoned` — terminal-not-shipped (should be closed by `/sprint-end` Step 5A; included here defensively in case it leaked)

For each issue:

1. Read the most recent `<!-- SCOPE-GATE -->` comment (`gh issue view N --comments`)
2. Parse the scope-gate comment for **Module:** and **Risk:** values
3. Parse the scope-gate verdict header: `Scope gate: PLAN-3-ROUND` or `PLAN-1-ROUND`

Skip issues that:
- Have no parseable SCOPE-GATE comment (label without comment is corrupt state — log and skip)
- Are labeled `planned`, `ready`, `needs-operator`, `abandoned` (already past scope gate)

Discard `deferred` and `scope:abort` candidates entirely.

## Phase 3: Rot detection

For each candidate, run a fast staleness check on cited file paths in the issue body. Use the same path regex as `/enrich-issue` Phase B:

```
PATH_RE = /(?:^|[\s\(\[`])(({{PATH_PREFIXES}})\/[^\s\)\]`#:,]+)(?::(\d+(?:[-,\s]+\d+)*))?/g
```

For each cited path:
- `[ -e <path> ]` — if the file no longer exists → flag the issue as **rotten**
- If the issue cites line numbers, compare `max_line` to `wc -l <path>` — out of range → flag as **rotten**

Rotten issues are excluded from the proposal. Surface them in the output as a "Rot detected" section so {{OPERATOR}} knows to fix or close them.

This is the one thing the planner does NOT catch up-front (its Phase 2B staleness probe runs only after a sprint commitment). Catching rot here saves a wasted planning session.

## Phase 4: Group by module

Build a map from module name → array of candidate issues. Use the `Module:` value parsed in Phase 2 (e.g. `Module A`, `Multi Word Module`, `Cross-cutting`).

For display, render module slugs as kebab-case (e.g. `module-a`, `multi-word-module`) — these are the strings `/sprint-plan` accepts as arguments.

## Phase 4.5: Batch large modules (cap = 10 issues per batch)

A "planning batch" is what one `/sprint-plan` invocation processes end-to-end. Cap is 10 issues per batch — beyond that, planner protocols accumulate too much in one orchestrator session and quality degrades (subagent context pressure, harder operator pause/resume, longer recovery on failure).

For each module after Phase 4, count the issues. If `count <= 10`, the module is one batch; slug stays as `<module-slug>` (e.g., `module-a`).

If `count > 10`, split into `ceil(count / 10)` batches as evenly as possible, then assign batch numbers in the same risk-then-issue-number order from Phase 5 (HIGH first, then issue # ascending). Batch slugs are `<module-slug>-batch-N` (e.g., `module-a-batch-1`, `module-a-batch-2`).

Even-split algorithm:
- 11 → 2 batches: ceil(11/2)=6 and 5 → batch-1 has 6, batch-2 has 5
- 14 → 2 batches: 7 and 7
- 21 → 3 batches: 7, 7, 7
- 25 → 3 batches: 9, 8, 8
- 30 → 3 batches: 10, 10, 10

Implementation:
```
batches_needed = ceil(count / 10)
base_size = count // batches_needed
remainder = count % batches_needed
# First `remainder` batches get base_size+1; remaining batches get base_size
```

Example for `count=14`, `batches_needed=2`: `base_size=7`, `remainder=0` → both batches size 7.
Example for `count=11`, `batches_needed=2`: `base_size=5`, `remainder=1` → batch-1 size 6, batch-2 size 5.

Record the batch structure for each module: list of `(batch_slug, [issue_numbers])` tuples. This drives both Phase 5's proposal rendering and Phase 7C's manifest format.

## Phase 5: Propose the sprint

Sort modules by candidate count, descending. `Cross-cutting` always last regardless of count.

Within each module, sort issues by:
1. Risk: HIGH → MEDIUM → LOW (high-risk first so they get planned with full attention)
2. Issue number ascending

Render the proposal. Single-batch modules render as before. Multi-batch modules render with a module heading + nested `### Batch N` subsections — each batch is a distinct `/sprint-plan` target:

```
==========================================
SPRINT PROPOSAL — {SPRINT_ID}
==========================================

Candidate pool: N scoped issues, M after rot filter.

Proposed sprint ({TARGET_SIZE} issues across K modules, B batches):

## module-a (8 issues)
- #341 — [title] · HIGH · PLAN-3
- #350 — [title] · MED · PLAN-3
- #361 — [title] · MED · PLAN-1
...

## module-b (14 issues, 2 batches)

### Batch 1 — module-b-batch-1 (7 issues)
- #401 — [title] · HIGH · PLAN-3
- #410 — [title] · MED · PLAN-3
...

### Batch 2 — module-b-batch-2 (7 issues)
- #428 — [title] · MED · PLAN-1
...

## cross-cutting (2 issues)
...

ROT DETECTED (excluded — fix or close before next sprint):
- #N — [title] — `<path>` no longer exists
- #N — [title] — line 1196 cited but file has 800 lines

NOT INCLUDED ({remaining} issues): see `gh issue list --label scoped` for the full pool.

---
Confirm? Reply with one of:
  yes              → commit the proposal as-is
  drop #N #N #N    → remove specific issues, then commit
  add #N #N #N     → add specific scoped issues, then commit
  smaller N        → propose a smaller sprint (target N)
  cancel           → abort
```

If `--size N` was passed, target `N` issues instead of 25. Picking strategy: take all issues from each module in the order above until target size hit; never split a module across the boundary unless absolutely necessary (prefer slightly over or under target to keep modules whole).

## Phase 6: Operator interaction

Wait for {{OPERATOR}}'s reply. Handle:

- **`yes`** → proceed to Phase 7
- **`drop #N #N`** → remove those issues from the proposal, re-render, ask again
- **`add #N #N`** → verify each is `scoped` and not rotten, add to proposal (assigned to its own module), re-render, ask again
- **`smaller N`** → re-pick at target N, re-render, ask again
- **`cancel`** → exit without writing anything

Loop until `yes` or `cancel`. Do not escalate, do not auto-decide — picking is the operator's call.

## Phase 7: Commit (skip if --dry-run)

### 7A. Create the `sprint` label idempotently

```bash
gh label create "sprint" --color "5319e7" --description "Active sprint member" 2>/dev/null || true
```

### 7B. Add the label to each chosen issue

```bash
gh issue edit N --add-label "sprint"
```

Process sequentially. On any single-issue failure: log it and continue. At the end, report `sprint label written: M of N succeeded. Failures: [list].`

### 7C. Write the manifest

Create `docs/sprints/{SPRINT_ID}.md`. Single-batch modules render as before (one ## heading, flat issue list). Multi-batch modules render with `### Batch N — <batch-slug> (count)` subsections under the module heading:

```markdown
# Sprint {SPRINT_ID}

**Started:** YYYY-MM-DD
**Issues:** N across K modules (B batches)

## module-a (8 issues)
- #341 — Title — HIGH · PLAN-3-ROUND
- #350 — Title — MED · PLAN-3-ROUND
...

## module-b (14 issues, 2 batches)

### Batch 1 — module-b-batch-1 (7 issues)
- #401 — Title — HIGH · PLAN-3-ROUND
- #410 — Title — MED · PLAN-3-ROUND
...

### Batch 2 — module-b-batch-2 (7 issues)
- #428 — Title — MED · PLAN-1-ROUND
...

---

## Classification snapshot (at commit)

- Total candidates considered: 84
- Healthy after rot filter: 80
- Cross-cutting share in pool: 62%
- Modules represented in sprint: 6 (module-a, module-b, module-c, module-d, module-e, module-f)
- Risk distribution committed: 8 HIGH · 14 MED · 4 LOW
- Issues excluded as rotten: 4 (#274, #375, #378, #422)
- Sprint target size: 25 (committed: 26)

---

## Sprint scratchpad

<!-- The sprint's running state. /sprint-plan, /sprint-walkthrough, and
/sprint-implement read the ### Active subsection before starting work and
surface entries relevant to their target issue.

WRITE RULE: only append an entry if your work materially changes another
sprint issue's plan. Examples that qualify:
  - You shipped a flag #350's plan assumed wouldn't exist
  - You changed a function signature #341 referenced
  - You found the issue body for #N is wrong and didn't fix it
Examples that don't qualify (don't write — would just be noise):
  - "I touched the same file as another issue" (not enough — needs a
     behavior change, not just a touch)
  - "Be careful with X" (too vague — say what specifically changed)
  - "Tests broke" (your problem, not theirs)

LIFECYCLE: write to ### Active when impact is discovered; move the entry
to ### Resolved (with strikethrough + resolution note) when no longer
applies. Without resolution, stale entries pollute every downstream
read. Format:

  Active:    - YYYY-MM-DD · #shipped → affects #N: one-line note
  General:   - YYYY-MM-DD · general: one-line note (no specific target)
  Operator:  - YYYY-MM-DD · operator: free-form note for downstream skills
  Resolved:  - ~~YYYY-MM-DD · #shipped → affects #N: original note~~
              → resolved YYYY-MM-DD: how it was addressed -->

### Active

(empty — entries will be appended during the sprint)

### Resolved

(empty — entries move here when their impact is addressed)

---
Status snapshot: see `gh issue list --label sprint` for live state.
Run `/sprint` for a rendered status view.
```

The classification snapshot is read by `/sprint-retro` for trend analysis. Five lines, computed from data already on hand during Phase 5 (proposal rendering). Don't re-query — reuse what was computed.

`mkdir -p docs/sprints/` first if needed. Overwrite if file exists (sprints can be re-started in the same week if `/sprint-end` was run cleanly).

### 7D. Cleanup queue (silent — write to manifest, do NOT surface in operator output)

If the sprint pick had any sidebar items — rotten issues that weren't fixed, singleton-module issues not committed, drift signals — append them to the manifest under a `## Cleanup queue` section. Create the section if missing. Format:

```markdown
## Cleanup queue

- YYYY-MM-DD · /sprint-start · 4 rotten issues sit outside the sprint with stale code references: #N1, #N2, #N3, #N4 — fix paths or close
- YYYY-MM-DD · /sprint-start · 6 singleton-module issues uncommitted: module-a (#X), module-b (#Y), ... — bolt on next sprint or roll
```

These items are NOT surfaced in the final summary. `/sprint-retro` Phase 5 reads them and either auto-actions or recommends.

### 7E. Final summary (anchored — three plain-English beats)

```
==========================================
SPRINT {SPRINT_ID} — committed
==========================================

**What just happened**
{N} issues locked in across {K} modules. Manifest at `docs/sprints/{SPRINT_ID}.md`.

**Where you are now**
Sprint set, nothing planned yet.

**Your next step**
`/sprint-plan {largest-module-slug}` — plans {M} {largest-module-slug} issues sequentially in this window. ~30-60 min; start it and walk away. When done, those {M} are ready for `/sprint-walkthrough`.
```

**The three beats are non-negotiable, formatted as bold mini-titles each on their own line, content underneath.** *What just happened* recaps what the skill produced. *Where you are now* names the position in the sprint loop. *Your next step* is the explicit operator action — command + plain-English explanation + ETA + posture, so a user returning from a break can pick up cold.

**Banned in this output:** any tail commentary about sidebar items, rot, singletons, "worth considering," "available to bolt on," "may also want to," etc. The cleanup queue (7D) captures all of that silently.

If you have a strong recommendation for the next module (largest, highest-risk), name it. If genuinely ambiguous, name `/sprint-plan` (no arg — picker will auto-pick) and adjust the explanation accordingly.

## Standing rules

- **One sprint at a time.** Never two `sprint`-labeled cohorts coexist. If you find yourself wanting to "add to the current sprint," that's a separate operation (file as a future skill, do not bolt on here).
- **Picking is operator-driven.** The proposal is a starting point, not a committed set. Always wait for `yes` before writing any label.
- **Rot is excluded silently from the proposal but surfaced in the output.** Operator decides what to do about rotten issues out-of-band.
- **No re-scoping in this skill.** If `scoped` issues look stale, they're a `/batch-scope --force` problem, not a sprint-pick problem. Don't reach into other skills' jobs.
- **Manifest is for humans.** No skill reads it at runtime — labels are the source of truth. The manifest is your audit trail.
