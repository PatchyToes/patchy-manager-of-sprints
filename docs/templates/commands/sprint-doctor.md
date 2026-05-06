---
description: Pipeline health check + safe self-repair. Inspects IK files, label hygiene, plan-file integrity, sprint-state drift, and module-assignment quality. Reports HEALTHY/DEGRADED/BROKEN with concrete fix commands. Auto-repairs the small set of safely reversible drifts when --repair is passed.
argument-hint: [--repair] [--quiet]
---

# Sprint Doctor (v1)

{{INCLUDE:glossary}}

**Session model:** Sonnet. Diagnostic synthesis with a small auto-repair surface; no critic dispatches needed. The judgment work is in deciding what's a warning vs a hard failure — Sonnet handles that fine.

**Read-only by default.** Without `--repair`, the doctor reports findings and prints fix commands but writes nothing. With `--repair`, it auto-applies the small set of drifts whose reversal cost is cheap and whose blast radius is one label or one comment. Everything else stays diagnostic — fixes for non-trivial drift are suggested, never auto-applied.

**Designed to be run any time.** Before `/sprint-start`. After a long pause. When `/sprint` shows weird state. When you suspect drift. When you've installed the skillset in a new repo and want to know what's missing.

Optional flags from $1:
- `--repair` — apply the safe auto-repairs (see Phase 4)
- `--quiet` — suppress HEALTHY check output, only show DEGRADED and BROKEN
- `--quick` — run only the highest-leverage checks (1B label set, 2C module quality, 2E already-shipped audit). Skips comment-fetch heavy checks (2A corrupt scope-gate, 3A plan-file presence) and the slow Phase 3 sprint-state diff. ~30-60 sec runtime instead of multi-minute. Use this for routine "is anything obviously broken" sweeps; full doctor for end-of-sprint deep audits.

## Performance discipline (read before adding any new phase)

The doctor's runtime is dominated by per-issue `gh` calls. A single `gh issue view N --comments` costs 2-5 seconds in practice (network + harness overhead). At 80 scoped issues, that's 3-7 minutes per phase that does per-issue fetches.

**Rules for any check that needs comment data:**

1. **Bulk-fetch with `gh issue list --json comments`** instead of per-issue `gh issue view --comments`. One call returns all issues' comments at once.
   ```bash
   gh issue list --state open --label scoped --limit 200 --json number,title,createdAt,comments
   ```
2. **Cache the result** in a local variable / temp file at start of run. Subsequent checks reuse it instead of re-fetching.
3. **Skip per-issue fetches in `--quick` mode.** Quick mode operates only on data already in the bulk response.
4. **Time-budget each phase** in your head before adding it: if a phase needs N gh calls and N > 10, restructure to bulk fetch.

Phases that follow these rules: 1A (file checks, instant), 1B (single gh label list), 2C (uses cached comment data from 2A), 2E (uses bulk-fetched scoped list + local git log calls).

Phases that may exceed budget if not bulk-fetched: 2A (SCOPE-GATE comment scan — must use bulk), 3A (plan-file presence — uses cached label list, OK).

## Phase A: Announce

Before any tool calls, print this preamble exactly (with a trailing blank line). Plain text — do not wrap in code fences or add Markdown.

```
═══ SPRINT · doctor ═══
Checking pipeline health. Read-only by default — pass --repair to apply safe fixes.
```

## Phase 0: Tool-availability gate (fail-closed)

```bash
gh auth status >/dev/null 2>&1 || { echo "Sprint doctor abort: gh not authenticated. Run 'gh auth login'."; exit 1; }
gh repo view --json name >/dev/null 2>&1 || { echo "Sprint doctor abort: gh cannot reach current repo."; exit 1; }
git --version >/dev/null 2>&1 || { echo "Sprint doctor abort: git not in PATH."; exit 1; }
```

## Phase 1: Environment & IK checks

For each, classify HEALTHY / DEGRADED / BROKEN. Print one line per check.

### 1A. Required IK files

- `docs/modules.md` — **BROKEN if missing.** Module assignment is load-bearing for sprint planning.
- `docs/stakes-index.md` — DEGRADED if missing. Planner can run, just less grounded.
- `docs/lessons-by-surface.md` — DEGRADED if missing.
- `docs/operating-principles.md` — DEGRADED if missing.

### 1B. Required labels in repo

Fetch label list once: `gh label list --limit 200 --json name --jq '.[].name'`

Required set: `scoped`, `deferred`, `scope:abort`, `planned`, `ready`, `needs-operator`, `abandoned`, `sprint`, `greenlit`, `implementing`, `tracking`.

For each missing label: DEGRADED. **Auto-repair candidate.**

### 1C. Sprints directory

`docs/sprints/` — informational only. Note the most recent manifest file by mtime, or "no manifests found."

## Phase 2: Backlog hygiene

### 2.0 — Bulk fetch (run ONCE, cache, all subsequent checks read from cache)

Before running 2A–2E, fetch the data they all need in **two** calls (not per-issue):

```bash
# Call 1: ALL open issues (for mutex check, label state)
gh issue list --state open --limit 500 --json number,title,createdAt,labels,body > /tmp/sd-all-open.json

# Call 2: Scoped/deferred/scope:abort with comments (for SCOPE-GATE parsing — Module/Risk/verdict)
gh issue list --state open --search "label:scoped OR label:deferred OR label:scope:abort" \
  --limit 200 --json number,title,createdAt,labels,body,comments > /tmp/sd-scoped-with-comments.json
```

**Forbidden:** `gh issue view N --json comments` per issue. The 80+ sequential calls cost 5-10 minutes and are the dominant runtime in the v1 doctor. Always read from the bulk cache files.

All subsequent checks (2A–2E) operate on these two cached files. If a check needs data not in the cache, add a third bulk call here — never per-issue fetches.

### 2A. Corrupt scope-gate state

Issues labeled `scoped`/`deferred`/`scope:abort` without a `<!-- SCOPE-GATE -->` marker in their `comments[].body`. The cached `/tmp/sd-scoped-with-comments.json` has everything you need — iterate locally, do not re-fetch.

For each corrupt: DEGRADED. Suggest `/scope-issue N --force` per issue.

### 2B. Conflicting state labels

The state label set is mutually exclusive: an open issue should carry at most one of `{scoped, deferred, scope:abort, planned, ready, needs-operator, abandoned}`.

Iterate `/tmp/sd-all-open.json` locally — every open issue, not just sample queries — and check label combinations. The v1 implementation queried 8 separate state-label lists and missed conflicts in issues that didn't appear in any of them. The bulk-fetch approach catches everything.

For any issue carrying two or more state labels: BROKEN. List the issue + the conflicting labels. Do NOT auto-strip — the operator must decide which is correct.

### 2C. Module assignment quality

Iterate `/tmp/sd-scoped-with-comments.json`. For each scoped issue, parse the most recent comment containing `<!-- SCOPE-GATE -->` for its `Module:` value. Compute cross-cutting %.

- 0–40% cross-cutting: HEALTHY
- 40–60%: DEGRADED — suggest `/batch-scope --force` (the new tier-2 + tier-3 fallback may rescue these)
- >60%: BROKEN — `docs/modules.md` is likely missing entries for live surfaces. Suggest auditing the modules map against current code.

### 2D. Module map drift (trend check)

Read the classification snapshot from each of the last 4 sprint manifests at `docs/sprints/*.md`. Extract the `Cross-cutting share in pool:` line.

If 3+ consecutive sprints show RISING cross-cutting %:
- DEGRADED — `docs/modules.md` likely missing entries for new code surfaces. Suggest auditing the modules map against recent commit paths.
- Render the trend so the operator can see it:
  ```
  Cross-cutting trend (last 4 sprints):
    2026-W16: 47%  baseline
    2026-W17: 55%  +8
    2026-W18: 62%  +7
    2026-W19: 71%  +9  ⚠ rising
  ```

If trend is flat or declining → HEALTHY (informational only).

If fewer than 3 historical snapshots exist → SKIP (insufficient data — not enough sprints have run yet).

### 2E. Backlog-noise audit (multi-state classification)

For each scoped open issue ≥14 days old that's NOT in the active sprint, classify the issue body and the cited-path state to recommend the right action. This phase exists because the v1 heuristic ("scoped + recent commits = already shipped") produced 80% false positives — most "shipped" candidates were actually BLOCKED, decision-needed, or rotten. Each state needs a different action.

**Algorithm:**

1. Read `/tmp/sd-all-open.json` (cached). Filter to: open + has `scoped` label + NOT `sprint` label + NOT `deferred` + NOT `scope:abort` + createdAt ≥14 days ago.

2. For each candidate, run body-content classification BEFORE the path-commit check. **First match wins** — these are mutually exclusive states:

   **A. BLOCKED** — body contains any of: `Status: BLOCKED`, `park until`, `blocked on`, `blocked by`, `not ready to build`, `waiting for` (in prerequisite context). Action: move to `deferred` label, capture the parking condition from body. NOT a shipped candidate.

   **B. DECISION-NEEDED** — body contains a heading or bold marker matching `Decisions needed`, `Decision:`, `Decision required`, or starts with `Decision:` in title. Action: move to `needs-operator` label. NOT a shipped candidate.

   **C. ROTTEN** — for each cited file path, check `[ -e <path> ]`. If ALL cited paths no longer exist, the issue is rotten. Action: surface for "close as moot OR re-cut body if the work transferred to a new path." NOT a shipped candidate.

   **D. LIKELY-SHIPPED** — none of A/B/C trip, AND ≥1 cited path has commits since issue creation. Action: close with autoclose-bookkeeping comment. This is the original audit target.

   **E. CLEAN** — none of A/B/C/D trip. The issue is genuinely scoped, not stale, not classified into another state. No action — it's plannable as-is.

3. Path extraction uses the same PATH_RE used elsewhere:
   ```
   /(?:^|[\s\(\[`])((?:{{PATH_PREFIXES}})\/[^\s\)\]`#:,]+)(?::(\d+))?/g
   ```
   Strip triple-backtick fenced code blocks first (those are example output, not citations).

4. For each cited path, run:
   ```bash
   git log --since="<issue.createdAt>" --oneline --no-merges -- <path> | head -5
   ```

5. The classification from step 2 (A through E) gives the action. Step 3-4 path-and-commit data only matters for category D — for A/B/C the verdict is body-derived.

**Severity (combined across all classified states):**
- 0 issues in A/B/C/D: HEALTHY
- 1-5 issues across categories: DEGRADED
- 6+ issues across categories: BROKEN — backlog hygiene needs an audit pass before next sprint

**Output format (each state in its own subsection with its own action):**

```
⚠ DEGRADED: K scoped issues ≥14 days old need cleanup before resuming /sprint-plan

A. BLOCKED ([count]) — issues parked deliberately, should move to `deferred`:
  #N (XXd old)  "Status: BLOCKED" — [parking condition from body]
  Action: gh issue edit N --add-label deferred --remove-label scoped sprint --comment "Moved to deferred per body status: [condition]"

B. DECISION-NEEDED ([count]) — issues waiting on operator judgment, should move to `needs-operator`:
  #N (XXd old)  [decision phrase]
  Action: gh issue edit N --add-label needs-operator --remove-label scoped sprint

C. ROTTEN ([count]) — cited paths no longer exist:
  #N (XXd old)  cited <path> → file deleted
  Action: gh issue close N --comment "Cited path no longer exists; closing as moot. File a new issue against current code if work is still relevant."

D. LIKELY-SHIPPED ([count]) — fix appears to have landed, autoclose was missed:
  #N (XXd old)  <path> → recent commits: <sha1>, <sha2>
  Action: gh issue close N --comment "Closes via <sha> — autoclose was missed when commit landed without 'Closes #N' in body. Bookkeeping cleanup."
  (verify the commit actually addresses the issue before closing — false positives possible if commit touched the path for unrelated reasons)
```

If still valid (commits touched the path but the bug persists), update the issue body to reflect current state and re-run /scope-issue N --force.
```

**No auto-repair.** Each candidate needs operator verification — the commit may have touched the cited path without fixing the issue. False positives are the failure mode if we auto-close. Surface and let {{OPERATOR}} judge.

**Performance:** Cap at 200 issues, 5 paths each, 1 git log per path = ~1000 fast local calls. Should complete in <30 seconds. If runtime becomes an issue at higher scale, sample (audit 50 oldest first, recommend re-run for the tail).

### 2F. Scope-gate freshness

Two checks, independent of module quality:

**Last batch-scope run:**
```bash
LAST_BATCH=$(ls tmp/batch-scope-run-*.txt 2>/dev/null | sort -r | head -1 | sed 's/.*batch-scope-run-\(.*\)\.txt/\1/')
```
- ≤7 days ago: HEALTHY
- 7–14 days ago: DEGRADED — suggest `/batch-scope --force`
- >14 days ago, or no log file: DEGRADED — same suggestion. Note that `/sprint-start` will auto-refresh on next run, but doctor surfaces it now.

**Truly unscoped open issues** (no pipeline state label at all):
```bash
gh issue list --state open --search \
  "-label:scoped -label:deferred -label:scope:abort -label:tracking \
   -label:planned -label:ready -label:needs-operator \
   -label:abandoned -label:greenlit -label:sprint" \
  --limit 100 --json number | jq 'length'
```

The exclusion list MUST cover every pipeline state label. State labels are mutually exclusive — an issue past the scope gate (e.g., labeled `planned` or `ready`) no longer carries `scoped`, but it has been triaged and must not be re-counted as "needs scoping." Use the full set above.

- 0–5: HEALTHY
- 6–15: DEGRADED — these issues are invisible to the sprint picker until scoped. Suggest `/batch-scope` (no --force needed; these are unlabeled).
- >15: BROKEN — backlog hygiene has slipped significantly. Suggest `/batch-scope` and a brief audit of why so many slipped through.

## Phase 3: Plan + sprint integrity

### 3.0 — Plan-file index (build once, reuse for 3A and 3B)

```bash
ls docs/protocol-test-runs/issue-*.md 2>/dev/null > /tmp/sd-plan-files.txt
```

Parse into a `Set<issue_number>` of issues that have a plan file. Both 3A and 3B read this — no second `ls`.

Also fetch the closed-issue list ONCE (used by 3B):
```bash
gh issue list --state closed --limit 500 --json number,labels > /tmp/sd-closed.json
```

### 3A. Plan-file presence

For each issue in `/tmp/sd-all-open.json` (cached in 2.0) labeled `planned`/`ready`/`needs-operator`/`abandoned`: check if its number is in the plan-file set from 3.0. If missing → DEGRADED.

For each missing plan file: two probable causes — (a) the planner aborted before writing, (b) plan was archived/deleted manually. Suggest `/plan-issue-three-round N` to re-run, or strip the label if intentionally abandoned.

### 3B. Orphan plan files

Inverse direction. For each issue number IN the plan-file set from 3.0:
1. Check if it appears in `/tmp/sd-all-open.json` → if yes, has an open issue, NOT orphan
2. Check if it appears in `/tmp/sd-closed.json` AND has any state label still → NOT orphan (still in pipeline)
3. Otherwise → orphan candidate

The v1 implementation hit 24 sequential `gh issue view N` calls for orphan classification because closed-issue lookup happened lazily. Bulk-fetching closed list once collapses those 24 calls to a Node Set lookup.

For each orphan: HEALTHY (informational). Note the path so the operator can archive if desired. Do NOT auto-delete.

### 3C. Sprint-state drift

If a sprint is in flight (any open issue carries `sprint`):

- **Closed issue with `sprint` label** — drift. **Auto-repair candidate.** Strip `sprint` from closed issues.
- **Issue in current manifest but missing `sprint` label** — drift. List the diff. Do NOT auto-add (operator may have explicitly removed it).
- **Issue with `sprint` label but not in current manifest** — drift. List the diff. Do NOT auto-strip (operator may have explicitly added it).

If no sprint is in flight: HEALTHY (informational).

### 3D. Stale plan files

Plan files where the issue is still open and the plan file's mtime is >30 days old: DEGRADED. Code may have moved underneath the plan. Suggest re-planning before dispatch.

## Phase 4: Auto-repair (only if --repair passed)

For each repair candidate identified above, apply the fix. Print one line per repair: `[REPAIRED] <action>`.

Safe auto-repairs:
1. **Create missing required labels** — `gh label create <name> --color <color> --description <desc> 2>/dev/null || true`. Color/description per the existing pattern in `/scope-issue` and `/review-plans`.
2. **Strip `sprint` from closed issues** — `gh issue edit N --remove-label sprint`. Closed-issue cleanup is unambiguous; reversal cost is one label add.

Do NOT auto-apply:
- Re-scoping corrupt issues (touches comments, may overwrite operator notes)
- Re-planning issues missing plan files (expensive, may not be intended)
- Stripping conflicting state labels (judgment call which to keep)
- Adding/removing `sprint` label to reconcile manifest drift (operator intent unclear)

If `--repair` was not passed, skip this phase. The DEGRADED/BROKEN sections of the report will still list the suggested fix commands.

## Phase 5: Output report

```
==========================================
PIPELINE HEALTH — YYYY-MM-DD
==========================================

[If --quiet was passed, omit the ✓ section. Otherwise:]

✓ HEALTHY ([count])
  - docs/modules.md present
  - docs/stakes-index.md present
  - All required labels present
  - 0 conflicting state labels
  - Module assignment quality: 28% cross-cutting (threshold 40%)
  - 0 orphan plan files
  - No sprint-state drift

⚠ DEGRADED ([count])
  - docs/operating-principles.md missing
    Fix: copy from template or create
  - 2 issues labeled `scoped` with no SCOPE-GATE comment: #284, #312
    Fix: /scope-issue 284 --force; /scope-issue 312 --force
  - 1 plan file older than 30 days for open issue: docs/protocol-test-runs/issue-89-three-round.md
    Fix: /plan-issue-three-round 89 (re-plan)

✗ BROKEN ([count])
  - Issue #145 carries conflicting labels: planned + ready
    Fix: gh issue edit 145 --remove-label <one-of>

[If --repair was passed and any repairs were applied:]

REPAIRS APPLIED ([count])
  - Created label: greenlit
  - Stripped sprint label from closed issue #128

[Footer:]

**Your next step**
- Address BROKEN items first (pipeline is in inconsistent state)
- Then DEGRADED items (pipeline works but degraded)
- Then re-run `/sprint-doctor --quiet` to verify clean state
- Or proceed with normal workflow if all that's left is informational
```

## Self-check note

This skill itself depends on:
- `gh` auth, `git` in PATH (Phase 0)
- The labels and comment markers used by other skills

If this skill ever produces output that doesn't match the actual repo state, the most likely cause is the underlying skill's contract changed (label name, comment marker format) without updating this skill. Audit the relevant skill's Phase H or its label/comment writes, then update the corresponding probe here.

## Standing rules

- **Never write without --repair.** The default mode is read-only by contract. Operators rely on being able to run this any time without consequence.
- **Auto-repair surface stays small.** Only repairs whose reversal cost is one label add/remove and whose intent is unambiguous (closed-issue cleanup, missing-label creation). Anything that touches comments, plan files, or open-issue labels is diagnostic-only.
- **Surface, don't summarize.** When a check fails, surface the specific issue numbers, file paths, and fix commands. "2 issues are corrupt" is useless without the numbers.
- **Recheck-cycle is the test.** A healthy pipeline survives `/sprint-doctor --quiet` with no DEGRADED or BROKEN output. That's the regression target.
