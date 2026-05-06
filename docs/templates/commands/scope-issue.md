---
description: Pre-planning triage. Reads a GitHub issue and determines whether it's ready to plan, should be deferred, or should be aborted — before committing to a planning session. Outputs a routing verdict and writes it back to GitHub.
argument-hint: <issue_number> [--dry-run | --force]
---

# Issue Scope Gate (v1)

{{INCLUDE:glossary}}

**Session model:** Sonnet. Haiku misses workstream-entanglement abort conditions. Opus is overkill. This skill runs fast and cheap — the cost of getting it wrong is a wasted planning session, not a shipped bug. The session model executes this skill — Claude Code does not enforce the model recommendation. On high-stakes triage runs (batch backlog, pre-release), verify the session is running on Sonnet before dispatch.

**Enforced at Phase 0.** Both planners check for `deferred` or `scope:abort` labels before loading context or firing a critic round. A DEFER or ABORT verdict stops the planner before it does any work.

**Scope-gate NEEDS-OPERATOR is not a question in-session.** When this gate emits NEEDS-OPERATOR, act on the underlying condition (file a plan, close a dependency, clarify scope), then re-run with `--force`. The gate does not wait for an answer.

You run on GitHub issue #$1.

Optional flags from $2: `--dry-run` (produce output, skip GitHub write-back) | `--force` (re-run even if recently scoped).

## Purpose

Answer one question before committing to a planning session: **is this issue ready to plan right now?**

The five possible answers:

1. **PLAN-3-ROUND** — scoped, dependencies met, non-trivial or cross-system work. Dispatch the three-round planner.
2. **PLAN-1-ROUND** — scoped, dependencies met, bounded single-surface work. Dispatch the one-round planner.
3. **DEFER** — conditions not met. Name the exact condition and re-trigger signal.
4. **ABORT** — should not be planned. Workstream decision needed, malformed issue, or explicitly parked with no measurable re-trigger. Recommend what to do instead.
5. **NEEDS-OPERATOR** — gate cannot make the call. Surface exactly what's blocking it.

## Phase 0: Tool-availability gate (fail-closed)

```bash
gh auth status >/dev/null 2>&1 || { echo "Scope gate abort: gh not authenticated. Run 'gh auth login'."; exit 1; }
gh repo view --json name >/dev/null 2>&1 || { echo "Scope gate abort: gh cannot reach current repo."; exit 1; }
git --version >/dev/null 2>&1 || { echo "Scope gate abort: git not in PATH."; exit 1; }
```

If any check fails, stop. Do not call `gh issue edit` later.

## Phase A: Read issue + fast-fail checks

```bash
gh issue view "$1" --json number,title,body,state,labels,closedAt
```

Apply skip rules in order:

1. **Closed:** `state == "closed"` → print `Scope gate skip: issue #$1 is closed.` and exit 0.
2. **Tracking label:** `labels[*].name` contains `tracking` → print `Scope gate skip: tracking issue, not a unit of work.` and exit 0.
3. **Already in reviewer state:** labels contain `ready` → print `Scope gate skip: issue #$1 already labeled ready — past planning, no scope gate needed.` and exit 0.
4. **TTL check:** labels contain `scoped` or `deferred` AND `--force` not passed →
   ```bash
   gh issue view $1 --comments --json comments
   ```
   Search comment bodies for `<!-- SCOPE-GATE -->`. Find the most recent comment containing that marker. Parse the comment's `createdAt` date.
   - If marker found and < 3 days ago → print `Scope gate skip: scoped <N> days ago. Re-run with --force to refresh.` and exit 0.
   - If marker found and ≥ 3 days → proceed (TTL expired).
   - If no `<!-- SCOPE-GATE -->`-marked comment found but label is present → treat as TTL-expired, proceed. Three possible causes: (a) pre-marker legacy run, (b) deleted comment, (c) partial write on prior API error. All three favor re-run over skip. Re-run cost is bounded; stale skip has no recovery path without `--force`.

## Phase B: Explicit defer/park signal scan

Scan the issue title and body for author-stated conditions that explicitly park the work. Quote the exact phrase — do not paraphrase.

**Signals that produce a DEFER candidate:**
- `park until` + condition phrase
- `blocked on #N` or `blocked by #N`
- `defer until` + condition phrase
- `waiting for` + condition phrase (when in context of a prerequisite, not a question)
- `depends on #N` (when #N is open)
- `after #N` or `once #N ships` (when #N is open)

**Signals that produce an ABORT candidate:**
- `won't fix`, `wontfix`, `by design`
- `not supported` (per CLAUDE.md — check your CLAUDE.md for any features or platforms explicitly marked as not supported)
- `park until there's signal` with no measurable re-trigger condition (vague indefinite park)

For each signal found: record the verdict candidate, the quoted phrase, and the surrounding sentence.

If no signals found: continue to Phase C.

## Phase C: Dependency resolution

Extract all `#N` references from the issue body using regex `#(\d+)`.

For each referenced issue number, run:
```bash
gh issue view <N> --json number,title,state,labels
```

Classify each reference as **prerequisite** or **related** using sentence-boundary scan:

For each sentence in the issue body that contains `#N` (a sentence is text terminated by `.`, `!`, `?`, or a newline), check whether that same sentence also contains a prerequisite keyword: `blocked by`, `depends on`, `after #N`, `fix #N first`, `requires #N`, `before this ships`, `once #N`.

- If the sentence matches both `#N` and a prerequisite keyword → **prerequisite**
- If `#N` appears in a sentence with no keyword → **related**
- If `#N` and a keyword appear in separate paragraphs (no shared sentence) → **related** (conservative — avoids false positives at the cost of occasional missed prerequisites)

For prerequisite references only: if `state == "open"` → DEFER candidate. Record: "#N ([title]) is open and listed as a prerequisite."

Do not gate on related references. Note them as context only.

## Phase D: Workstream entanglement

Three heuristics in priority order. Without a structured module system these are probabilistic — findings are "possible entanglement" unless D.1 produces a confirmed match.

**D.1 Master plan file scan (strongest signal)**
```bash
grep -rl "#$1\b" docs/plans/ 2>/dev/null
grep -rl "issue.*\b$1\b\|issue-$1\b" docs/plans/ 2>/dev/null
```
If any master plan file matches: read it. Check:
- Is the workstream marked active or in-progress?
- Is this issue assigned to a future phase with predecessor phases incomplete?
- Are there explicit ordering constraints ("do not start #N until phase X ships")?

Confirmed workstream entanglement + predecessor incomplete → DEFER candidate with the specific phase condition.

**D.2 Git recency on cited paths (velocity signal)**

Extract paths from issue body using PATH_RE:
```
/(?:^|[\s\(\[`])((?:{{PATH_PREFIXES}})\/[^\s\)\]`#:,]+)/g
```

For each path:
```bash
git log --since='7 days ago' --oneline -- <path> | head -5
```
If 3+ commits in 7 days on a cited path: flag as "Path `<X>` has N recent commits — possible in-flight work." This is context for the operator, not a blocking signal on its own.

**D.3 Adjacent open issues on same surface (cluster signal)**

For each unique top-level path fragment from the issue body:
```bash
gh issue list --search "<fragment>" --state open --limit 8 --json number,title,labels
```
Dedup against the current issue. If 3+ open issues share a surface: flag as "N open issues share surface `<X>` — consider whether these should be tackled via a shared master plan rather than individually." Context only, not blocking.

## Phase E: Scope sizing

Read the issue title, body, and GIC block if present (scan for `<!-- GIC-START -->`).

**Signals for PLAN-1-ROUND:**
- Single file cited or clearly implied by the issue description
- Bug fix with a clear root cause already stated
- Doc-only or config-only change
- No cross-system effects mentioned or implied
- No DB migration or schema change implied
- GIC block (if present) shows a single module, no cross-module Touches

**Signals for PLAN-3-ROUND:**
- Multiple files or surfaces cited
- New feature, new component, or new system behavior
- DB migration or schema change implied
- Cross-system effects mentioned (cron workers, edge functions, frontend consumers)
- Requires verifying or establishing a design decision before implementing
- GIC block shows multiple modules or cross-module Touches entries
- `enhancement`, `feature`, `architecture` labels

Default to PLAN-3-ROUND when ambiguous. PLAN-1-ROUND is an optimization, not a fallback.

## Phase E.4: Module assignment

Read `docs/modules.md` if it exists. For each `## <Module Name>` section, capture three things:
1. **Primary code paths** — from the `Primary code:` line. Index longest-prefix first.
2. **What-it-does line** — the prose description after `**What it does:**` — used as a keyword bag.
3. **Path leaf names** — for each primary code path, extract the leaf (e.g. `redeem-promo-code` from `supabase/functions/redeem-promo-code/`). Used to catch issues that name the function/component without the full path.

Run the assignment in tiers and stop at the first tier that produces a hit:

**Tier 1 — Path match (strongest):** parse cited paths from the body using PATH_RE:
```
/(?:^|[\s\(\[`])((?:{{PATH_PREFIXES}})\/[^\s\)\]`#:,]+)/g
```
Look each up in the path index. Tally hits per module. Primary module = most hits (ties alphabetical).

**Tier 2 — Leaf-name match:** if Tier 1 found nothing, lowercase the issue title+body. For each module, check whether any of its path leaves appears as a substring (word-boundary). Tally hits across modules, pick winner.

**Tier 3 — Module-name + description match:** if Tier 2 also found nothing, for each module check whether the module name OR any 2+ word phrase from its What-it-does line appears as a substring in the lowercased title+body. Tally hits, pick winner.

**Final fallback:** still no match → assign `Cross-cutting`. This is now a real signal (issue cites no code, no leaf names, no module vocabulary).

If `docs/modules.md` doesn't exist → assign `Unsorted` and skip this phase silently.

## Phase E.5: Risk assessment

Assign one implementation risk tier: **LOW**, **MEDIUM**, or **HIGH**. This is metadata for the implementer — it does not affect routing.

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

## Phase F: Verdict assembly

Collect all signals from Phases B–E. Apply in priority order — first matching rule wins:

1. Any hard ABORT signal from Phase B (won't fix / not supported / vague indefinite park) → **ABORT**
2. Any confirmed workstream entanglement from Phase D.1 → **DEFER** with the specific phase condition
3. Any open prerequisite dependency from Phase C → **DEFER** with the specific issue(s)
4. Any explicit defer/park signal from Phase B with a measurable re-trigger → **DEFER** with the quoted signal
5. Phase D.2 or D.3 findings alone (velocity, adjacent cluster) with no other blocking signal → **PLAN-*** with a SCOPE NOTES entry. D.2/D.3 are context, never NEEDS-OPERATOR triggers — velocity on a path is not a routing question.
6. No blocking signals + scope sized → **PLAN-3-ROUND** or **PLAN-1-ROUND**

**On NEEDS-OPERATOR:** Reserved for genuine ambiguity the gate cannot resolve from available data — typically a missing prerequisite reference or a contradiction between issue body and master plan. If you can apply a conservative default, apply it and note it. Do not escalate because something *might* be an issue.

## Phase G: Output

```
==========================================
SCOPE: Issue #N — [title]
==========================================

VERDICT: [PLAN-3-ROUND | PLAN-1-ROUND | DEFER | ABORT | NEEDS-OPERATOR]
MODULE: [Primary module name | Cross-cutting | Unsorted]
RISK: [LOW | MEDIUM | HIGH]

ROUTING:
[One sentence: what to dispatch next, or what must happen first.]

SIGNALS:
- [Bullet list of what drove this verdict. Quoted phrases for B signals. Issue numbers and titles for C signals. File paths and commit counts for D signals. Concrete only — no generalities.]

[If DEFER, add:]
DEFER UNTIL:
- [Specific, measurable re-trigger condition]
- [e.g.: "#425 closes" or "scripts/backfill-canonical-workflow-metadata.mjs --apply confirmed run in production"]
- [One condition per bullet. No vague conditions.]

[If ABORT, add:]
ABORT REASON:
[One paragraph. What makes this unplannable.]

RECOMMENDATION:
[Specific next action: file tracking issue, consolidate into master plan, close as won't fix, re-open after X ships, etc.]

[If NEEDS-OPERATOR, add:]
BLOCKED ON:
- [Exact question. Answerable with a sentence. One question per bullet.]

[If PLAN-*, add:]
SCOPE NOTES:
- [D.2/D.3 findings or other context worth knowing before the planner starts — not blockers]
- [Or: "None."]
```

## Phase H: GitHub write-back

Skip entirely if `--dry-run` was passed.

**Marker integrity note:** The `<!-- SCOPE-GATE -->` marker in comment bodies is advisory TTL state, not authoritative verdict state. Unauthorized removal causes re-runs; unauthorized addition causes TTL-skips. Neither produces a wrong verdict — the gate re-derives its verdict from live GitHub + git state on every run.

**Create labels idempotently:**
```bash
gh label create "scoped"     --color "0075ca" --description "Scope gate: ready to plan"    2>/dev/null || true
gh label create "deferred"   --color "e4e669" --description "Scope gate: conditions unmet"  2>/dev/null || true
gh label create "scope:abort" --color "b60205" --description "Scope gate: do not plan"      2>/dev/null || true
```

**Per verdict:**

PLAN-3-ROUND or PLAN-1-ROUND:
```bash
gh issue edit $1 --remove-label "scoped,deferred,scope:abort" 2>/dev/null || true
gh issue edit $1 --add-label "scoped"
gh issue comment $1 --body "<!-- SCOPE-GATE -->
**Scope gate: PLAN-3-ROUND** · Module: [Primary module] · Risk: [LOW | MEDIUM | HIGH]

[ROUTING line]

[SCOPE NOTES if non-empty — omit section if none]"
```

DEFER:
```bash
gh issue edit $1 --remove-label "scoped,deferred,scope:abort" 2>/dev/null || true
gh issue edit $1 --add-label "deferred"
gh issue comment $1 --body "<!-- SCOPE-GATE -->
**Scope gate: DEFER** · Module: [Primary module] · Risk: [LOW | MEDIUM | HIGH]

[ROUTING line]

Defer until:
[DEFER UNTIL bullets]"
```

ABORT:
```bash
gh issue edit $1 --remove-label "scoped,deferred,scope:abort,planned,ready,needs-mike,abandoned" 2>/dev/null || true
gh issue edit $1 --add-label "scope:abort"
gh issue comment $1 --body "<!-- SCOPE-GATE -->
**Scope gate: ABORT**

[ABORT REASON]

Recommendation: [RECOMMENDATION]"
```

NEEDS-OPERATOR:
No label change. Print output to stdout only. Do not comment on the issue — the operator must act on the underlying condition and re-run with `--force`. No state write before the operator answers the blocking questions.

## Standing rules

- **Commit or escalate. No hedges.** Every verdict is a committed call. "Probably fine" is not a verdict. DEFER names the specific unmet condition. ABORT names the specific reason. NEEDS-OPERATOR names the specific question.
- **Quote, don't paraphrase.** When citing a B-signal from the issue body, quote the exact phrase and its surrounding sentence.
- **Conservative on routing.** Default to PLAN-3-ROUND over PLAN-1-ROUND when ambiguous. Default to DEFER over PLAN-* when a dependency state is genuinely unclear.
- **Do not plan.** This skill ends at the routing verdict. No implementation decisions, no code reads beyond path extraction, no evidence trail. If you find yourself reasoning about how to implement the issue, stop.
- **NEEDS-OPERATOR is not a default.** It requires a genuine question that cannot be answered from GitHub state, git history, or master plan files. D.2 and D.3 findings are SCOPE NOTES, never NEEDS-OPERATOR — velocity on a path is not a routing question.
