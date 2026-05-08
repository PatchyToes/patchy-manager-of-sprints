---
description: Non-interactive scope sweep. Runs the scope-issue triage logic across all open GitHub issues in batch. Writes labels and SCOPE-GATE comments. Designed for weekly scheduled hygiene or on-demand backlog triage.
argument-hint: [--label <name>] [--force] [--dry-run] [--enable-writes]
---

# Batch Scope Sweep (v1)

{{INCLUDE:glossary}}

**Session model:** Sonnet. Same reasoning as `/scope-issue` — Haiku misses workstream-entanglement abort conditions; Opus is overkill for checklist routing.

**Non-interactive only.** This skill processes all qualifying open issues sequentially without operator input. For a single issue with interactive routing, use `/scope-issue <N>`.

**NEEDS-MANUAL-SCOPE is not a question in-session.** When the batch gate emits NEEDS-MANUAL-SCOPE for an issue, run `/scope-issue N` on it directly. The batch run does not collect questions or wait for answers.

## Flags

Parse all flags from the argument string:

- `--label <name>` — only process issues carrying this label
- `--force` — bypass TTL; re-scope all qualifying issues regardless of when they were last scoped
- `--dry-run` — produce verdict table, skip all GitHub write calls
- `--enable-writes` — write `batch-scope-writes: enabled` to `.claude/pipeline-setup.md`, then exit. Does not run the sweep. One-time operation to graduate past the staging gate after reviewing dry-run output.

## Phase 0: Tool-availability gate (fail-closed)

```bash
gh auth status >/dev/null 2>&1 || { echo "Batch scope abort: gh not authenticated. Run 'gh auth login'."; exit 1; }
gh repo view --json name >/dev/null 2>&1 || { echo "Batch scope abort: gh cannot reach current repo."; exit 1; }
git --version >/dev/null 2>&1 || { echo "Batch scope abort: git not in PATH."; exit 1; }
```

If any check fails, stop. Write run log with error. Do not proceed.

## Phase 1: Staging gate check

Read `.claude/pipeline-setup.md` if it exists. Check for the line `batch-scope-writes: enabled`.

- If present: writes are enabled. Respect `--dry-run` flag normally.
- If absent (or file missing): staging gate is active. Force dry-run mode for this run regardless of other flags. Log: `[STAGING GATE ACTIVE] Writes suppressed — run /batch-scope --enable-writes after reviewing dry-run output.`

If `--enable-writes` flag was passed:
1. Open `.claude/pipeline-setup.md` (create if missing).
2. Append `batch-scope-writes: enabled` if not already present.
3. Print: `Writes enabled. Next /batch-scope run will write labels.`
4. Exit 0. Do not run the sweep.

## Phase 2: Issue enumeration

Fetch all open issues:
```bash
gh issue list --state open --limit 500 --json number,title,body,labels,state
```

If `--label <name>` was passed, filter to issues where `labels[*].name` contains the specified label.

For each issue, apply skip rules in order:

### Always-skip (never subject to TTL or --force)

Skip immediately and add to skip count if any of these match:

1. `state == "closed"` — defensive guard
2. labels contain `tracking`
3. labels contain `scope:abort` — terminal verdict; re-scope only via `/scope-issue N --force`
4. labels contain `ready` — past scope gate, in reviewer state or cleared
5. labels contain `planned` — past scope gate, planner has run
6. labels contain `needs-operator` — reviewer verdict, awaiting operator judgment
7. labels contain `abandoned` — terminal reviewer verdict

### TTL-skip (applies only to issues with `scoped` or `deferred` label)

Apply only if not already always-skipped AND labels contain `scoped` or `deferred`:

```bash
gh issue view <N> --comments --json comments
```

Search comment bodies for `<!-- SCOPE-GATE -->`. Find the most recent comment containing that marker. Parse `createdAt`.

- No marker found → treat as TTL-expired (proceed to triage)
- Marker found and < 3 days ago AND `--force` not passed → skip. Add to TTL-skip count.
- Marker found and ≥ 3 days → proceed (TTL expired)

Issues that pass both skip checks enter the triage loop.

## Phase 3: Per-issue triage loop

For each non-skipped issue, run Phases B through F:

### Phase B: Explicit defer/park signal scan

Scan title and body. Signals for DEFER candidate:
- `park until` + condition phrase
- `blocked on #N` or `blocked by #N`
- `defer until` + condition phrase
- `waiting for` + condition phrase (prerequisite context)
- `depends on #N` (when #N is open)
- `after #N` or `once #N ships` (when #N is open)

Signals for ABORT candidate:
- `won't fix`, `wontfix`, `by design`
- `not supported`
- `park until there's signal` with no measurable re-trigger (vague indefinite park)

### Phase C: Dependency resolution

Extract `#N` references from body. For each:

```bash
gh issue view <N> --json number,title,state,labels
```

Classify prerequisite vs related via sentence-boundary scan: a reference is a prerequisite if the sentence containing `#N` also contains a keyword from `blocked by`, `depends on`, `after #N`, `fix #N first`, `requires #N`, `before this ships`, `once #N`. Open prerequisites → DEFER candidate.

### Phase D: Workstream entanglement (D.1 and D.2 only — D.3 skipped in batch)

**D.1 Master plan file scan:**
```bash
grep -rl "#<N>\b" docs/plans/ 2>/dev/null
```

If any master plan file matches: read it. Check whether the workstream is active, whether this issue is assigned to a future phase with predecessor phases incomplete, and whether there are explicit ordering constraints.

**Confirmed D.1 entanglement + predecessor incomplete → NEEDS-MANUAL-SCOPE.** No label write. Record: `NEEDS MANUAL SCOPE: #N (active workstream entanglement in <file>) — run /scope-issue N.`

**D.2 Git recency on cited paths:**

Extract paths from body using PATH_RE:
```
/(?:^|[\s\(\[`])((?:{{PATH_PREFIXES}})\/[^\s\)\]`#:,]+)/g
```

For each path:
```bash
git log --since='7 days ago' --oneline -- <path> | head -5
```

D.2 findings (3+ commits in 7 days): route to PLAN-* verdict with a SCOPE NOTES entry. Not a NEEDS-MANUAL-SCOPE trigger — "context only, not blocking" per scope-issue Phase D.

**D.3 skipped.** At scale, D.3 adds ~3 gh calls per issue for signal scope-issue.md explicitly labels "context only, not blocking." The runtime cost is not justified in batch.

### Phase E: Scope sizing

**Signals for PLAN-1-ROUND:**
- Single file cited or clearly implied
- Bug fix with a clear root cause already stated
- Doc-only or config-only change
- No cross-system effects mentioned or implied
- No DB migration or schema change implied

**Signals for PLAN-3-ROUND:**
- Multiple files or surfaces cited
- New feature, new component, or new system behavior
- DB migration or schema change implied
- Cross-system effects mentioned
- Requires verifying or establishing a design decision before implementing

Default to PLAN-3-ROUND when ambiguous.

### Phase E.4: Module assignment

Read `docs/modules.md` once at start of run. For each `## <Module Name>` section, capture three things:
1. **Primary code paths** — from the `Primary code:` line (markdown links). Index longest-prefix first.
2. **What-it-does line** — the prose description after `**What it does:**` — used as a keyword bag.
3. **Path leaf names** — for each primary code path, extract the leaf (e.g. `redeem-promo-code` from `supabase/functions/redeem-promo-code/`). Used to catch issues that mention the function/component by name without the full path.

Per issue, run the assignment in tiers and stop at the first tier that produces a hit:

**Tier 1 — Path match (strongest):** parse cited paths from the body using the same PATH_RE from Phase D.2. Look each up in the path index, tally hits, primary module = most hits (ties alphabetical).

**Tier 2 — Leaf-name match:** if Tier 1 found nothing, lowercase the issue title+body. For each module, check whether any of its path leaves appears as a substring (word-boundary, e.g. `redeem-promo-code` matches but `re-deem` does not). Tally hits across modules, pick winner.

**Tier 3 — Module-name + description match:** if Tier 2 also found nothing, for each module check whether the module name (e.g. `Module A`) OR any 2+ word phrase from its What-it-does line appears as a substring in the lowercased title+body. Tally hits, pick winner.

**Final fallback:** still no match → assign `Cross-cutting`. This is now a real signal — the issue cites no code, no leaf names, no module vocabulary. It really is cross-cutting.

If `docs/modules.md` doesn't exist → assign `Unsorted` and skip this phase quietly.

**Health flag.** After processing all issues, compute `cross-cutting %` of the assigned pool. If >40%, append a footer warning to the verdict table:

```
[HEALTH WARNING] N% of scoped issues assigned to Cross-cutting (threshold: 40%).
This usually means either (a) docs/modules.md is missing entries for surfaces in the codebase,
or (b) the issue bodies are too symptom-shaped to match by keyword. Run /scope-issue N --force
on a few cross-cutting issues to inspect, or extend modules.md with the missing surface(s).
```

### Phase E.5: Risk assessment

Assign one implementation risk tier: **LOW**, **MEDIUM**, or **HIGH**. Does not affect routing — metadata for the implementer.

**HIGH — any single signal triggers this tier:**
- Billing, Stripe, payments, credits, subscription, checkout, promo code
- Authentication, JWT, RLS, security, permissions, privilege escalation, injection, exposure
- Mutations of existing production rows (backfill --apply, bulk DELETE, data migration)
- External system writes (webhooks, OAuth callbacks, third-party API side effects)
- Labels include `cost-safety` or `security`

**LOW — all must be true:**
- No HIGH signals present
- No DB migration implied (code-only change)
- Touches one surface, or is doc/config/cleanup/delete-dead-code only
- No cross-system effects

**MEDIUM — default.** Anything not clearly LOW or HIGH.

### Phase F: Verdict assembly

Priority order — first matching rule wins:

1. Any hard ABORT signal from Phase B → **ABORT**
2. D.1 confirmed entanglement + predecessor incomplete → **NEEDS-MANUAL-SCOPE** (no label write)
3. Any open prerequisite from Phase C → **DEFER**
4. Any explicit defer/park signal from Phase B with measurable re-trigger → **DEFER**
5. D.2 findings alone → **PLAN-*** with SCOPE NOTES (not NEEDS-MANUAL-SCOPE)
6. No blocking signals + scope sized → **PLAN-3-ROUND** or **PLAN-1-ROUND**

## Phase 4: Output

Print the verdict table after processing all issues:

```
==========================================
BATCH SCOPE — [YYYY-MM-DD] — [N] issues processed
==========================================

PLAN-3-ROUND ([count]):
- #N — [title] · [Module] · [LOW | MED | HIGH]
  [SCOPE NOTES if any — one line. Omit if none.]
- ...

PLAN-1-ROUND ([count]):
- #N — [title] · [Module] · [LOW | MED | HIGH]
- ...

DEFER ([count]):
- #N — [title]
  Defer until: [condition — one line]
- ...

ABORT ([count]):
- #N — [title]
  Reason: [one line]
- ...

NEEDS MANUAL SCOPE ([count]):
- #N — [title] — run /scope-issue N
  Reason: active workstream entanglement in [file]
- ...

SKIPPED ([count]):
  [N] always-skip (closed / terminal / past scope gate)
  [N] TTL-skip (scoped or deferred < 3 days)

[If staging gate active, append:]
STAGING GATE ACTIVE — no writes. Review verdicts above, then run /batch-scope --enable-writes.
```

## Phase 5: GitHub write-back

Skip entirely if dry-run mode (explicit `--dry-run` flag OR staging gate active).

**Create labels idempotently:**
```bash
gh label create "scoped"      --color "0075ca" --description "Scope gate: ready to plan"    2>/dev/null || true
gh label create "deferred"    --color "e4e669" --description "Scope gate: conditions unmet"  2>/dev/null || true
gh label create "scope:abort" --color "b60205" --description "Scope gate: do not plan"       2>/dev/null || true
```

For each non-always-skipped, non-TTL-skipped issue with a PLAN-*, DEFER, or ABORT verdict:

**PLAN-3-ROUND or PLAN-1-ROUND:**
```bash
gh issue edit <N> --remove-label "scoped,deferred,scope:abort" 2>/dev/null || true
gh issue edit <N> --add-label "scoped"
gh issue comment <N> --body "<!-- SCOPE-GATE -->
**Scope gate: PLAN-3-ROUND** *(batch run)* · Module: [Primary module] · Risk: [LOW | MEDIUM | HIGH]

[ROUTING: one sentence — what to dispatch next]

[SCOPE NOTES section if non-empty — omit if none]"
```

**DEFER:**
```bash
gh issue edit <N> --remove-label "scoped,deferred,scope:abort" 2>/dev/null || true
gh issue edit <N> --add-label "deferred"
gh issue comment <N> --body "<!-- SCOPE-GATE -->
**Scope gate: DEFER** *(batch run)* · Module: [Primary module] · Risk: [LOW | MEDIUM | HIGH]

[ROUTING: one sentence]

Defer until:
[DEFER UNTIL bullets — one condition per bullet, measurable]"
```

**ABORT:**
```bash
gh issue edit <N> --remove-label "scoped,deferred,scope:abort,planned,ready,needs-operator,abandoned" 2>/dev/null || true
gh issue edit <N> --add-label "scope:abort"
gh issue comment <N> --body "<!-- SCOPE-GATE -->
**Scope gate: ABORT** *(batch run)*

[ABORT REASON — one paragraph]

Recommendation: [RECOMMENDATION]"
```

**NEEDS-MANUAL-SCOPE:** No label write, no comment. Flagged in output and run log only.

## Phase 6: Run log

Always write a run log, regardless of dry-run or staging gate status. Create `tmp/` if it does not exist.

Write to `tmp/batch-scope-run-YYYY-MM-DD.txt` (ISO date in filename):

```
[YYYY-MM-DD HH:MM UTC] batch-scope: N processed (K scoped, M deferred, P aborted, Q needs-manual-scope, R skipped). Runtime: Xs.
```

Append flags on the same line if active: `[STAGING GATE — dry run]` or `[--dry-run]`.

If a file for today already exists (re-run on same day), append a new line rather than overwriting.

## Standing rules

- **Process sequentially.** Do not parallelize gh calls. GitHub API secondary rate limits apply, and sequential processing keeps the run log runtime meaningful.
- **Fail open on individual issues.** If a single issue's gh call fails (network error, rate limit), log the error in the output table and continue. Do not abort the entire run.
- **No question collection.** NEEDS-MANUAL-SCOPE issues are flagged for human re-run only. Do not collect questions, accumulate a question pile, or wait for answers.
- **TTL is TTL.** A 2.9-day-old scoped issue gets skipped. No rounding.
- **--force bypasses TTL, not always-skip.** `scope:abort`, `planned`, `ready`, `needs-operator`, `abandoned` are always-skipped regardless of --force. Only `scoped` and `deferred` TTL checks are bypassed by --force.
- **D.2 findings are SCOPE NOTES, not blockers.** Velocity on a cited path routes to PLAN-* with a note, never to NEEDS-MANUAL-SCOPE.
