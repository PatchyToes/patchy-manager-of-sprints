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
SPRINT_ID=$(date +%G-W%V)
```

This is the ISO-year-and-week (e.g. `2026-W19`). Used for the manifest filename and the manifest header.

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
   -label:planned -label:ready -label:needs-operator -label:needs-mike \
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
gh issue list --state open --label scoped --limit 500 --json number,title,body,labels
```

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

## Phase 5: Propose the sprint

Sort modules by candidate count, descending. `Cross-cutting` always last regardless of count.

Within each module, sort issues by:
1. Risk: HIGH → MEDIUM → LOW (high-risk first so they get planned with full attention)
2. Issue number ascending

Render the proposal:

```
==========================================
SPRINT PROPOSAL — {SPRINT_ID}
==========================================

Candidate pool: N scoped issues, M after rot filter.

Proposed sprint ({TARGET_SIZE} issues across K modules):

## module-a (8 issues)
- #341 — [title] · HIGH · PLAN-3
- #350 — [title] · MED · PLAN-3
- #361 — [title] · MED · PLAN-1
...

## module-b (6 issues)
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

Create `docs/sprints/{SPRINT_ID}.md`:

```markdown
# Sprint {SPRINT_ID}

**Started:** YYYY-MM-DD
**Issues:** N across K modules

## module-a (8)
- #341 — Title — HIGH · PLAN-3-ROUND
- #350 — Title — MED · PLAN-3-ROUND
...

## module-b (6)
- #N — Title — risk · protocol
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

<!-- This section is the sprint's running state. Any sprint-* skill (plan,
walkthrough, implement) reads this before starting work and surfaces entries
relevant to its target issue. Append a line whenever you ship something or
make a decision that affects sibling sprint issues. Format:

  - YYYY-MM-DD · #shipped → affects #N: one-line note
  - YYYY-MM-DD · general: one-line note (no specific target issue)
  - YYYY-MM-DD · operator: free-form note for downstream skills

Entries persist for the sprint's lifetime. /sprint-end carries unresolved
items into the retro. -->

(empty — entries will be appended during the sprint)

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

Done: {N} issues locked in across {K} modules. Manifest at docs/sprints/{SPRINT_ID}.md.
You are here: sprint set, nothing planned yet.

Next: /sprint-plan {largest-module-slug}
  Plans {M} {largest-module-slug} issues sequentially in this window. ~30-60 min — start it and walk away.
  When done, those {M} are ready for /sprint-walkthrough.
```

**The three beats are non-negotiable.** Done = what just happened. You are here = where in the loop. Next = command + plain-English explanation of what it does + ETA + posture.

**Banned in this output:** any tail commentary about sidebar items, rot, singletons, "worth considering," "available to bolt on," "may also want to," etc. The cleanup queue (7D) captures all of that silently.

If you have a strong recommendation for the next module (largest, highest-risk), name it. If genuinely ambiguous, name `/sprint-plan` (no arg — picker will auto-pick) and adjust the explanation accordingly.

## Standing rules

- **One sprint at a time.** Never two `sprint`-labeled cohorts coexist. If you find yourself wanting to "add to the current sprint," that's a separate operation (file as a future skill, do not bolt on here).
- **Picking is operator-driven.** The proposal is a starting point, not a committed set. Always wait for `yes` before writing any label.
- **Rot is excluded silently from the proposal but surfaced in the output.** Operator decides what to do about rotten issues out-of-band.
- **No re-scoping in this skill.** If `scoped` issues look stale, they're a `/batch-scope --force` problem, not a sprint-pick problem. Don't reach into other skills' jobs.
- **Manifest is for humans.** No skill reads it at runtime — labels are the source of truth. The manifest is your audit trail.
