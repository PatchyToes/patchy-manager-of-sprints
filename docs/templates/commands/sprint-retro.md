---
description: Sprint retrospective. Auto-derives throughput + module ship-rates + cross-cutting trend from manifests and GitHub state, asks 3 pointed questions, synthesizes 1-3 actionable suggestions for next sprint. Runs as the final phase of /sprint-end, or standalone.
argument-hint: [<sprint_id> | --no-questions]
---

# Sprint Retro (v1)

{{INCLUDE:glossary}}

**Session model:** Sonnet. Synthesis work — reads quantitative data, asks three short questions, produces qualitative suggestions. Architectural reasoning isn't needed.

**The point of this skill:** sprints don't improve themselves. Without a feedback loop, each sprint runs on intuition that's never calibrated. The retro captures throughput, imbalance signals, and operator context, then synthesizes recommendations for the next sprint cycle. Run it consistently and the system gets smarter every week.

**Three layers:**
- **Layer 1 — Auto-derived data.** Throughput, module ship-rates, risk shipped, cross-cutting trend, roll-forward streaks, time-to-implement. All from `gh` queries + manifest reads. No operator input needed.
- **Layer 2 — Three pointed questions.** Captures qualitative context the data can't see. Two minutes max.
- **Layer 3 — Synthesis.** Surfaces 1-3 specific recommendations grounded in both layers.

Optional `$1`:
- `<sprint_id>` (e.g. `S020`) — retro a specific sprint. Default: most recent closed sprint (manifest with an `## Outcomes` section). Legacy `2026-W{N}` IDs still resolve for archived sprints.
- `--no-questions` — skip Layer 2 (auto-derived only). Useful when chained from `/sprint-end` and you want to skip the questions for now.

## Phase A: Announce

Before any tool calls, print this preamble exactly (with a trailing blank line). Plain text — do not wrap in code fences or add Markdown.

```
═══ SPRINT · retro ═══
Reviewing the closed sprint. I'll auto-derive metrics, ask three short questions, then suggest 1-3 specific changes for next sprint.
```

## Phase 0: Tool-availability gate (fail-closed)

```bash
gh auth status >/dev/null 2>&1 || { echo "Sprint retro abort: gh not authenticated."; exit 1; }
```

## Phase 1: Resolve target sprint

If `$1` is a sprint ID (matches `S\d+` or legacy `YYYY-WNN`), use it. For legacy IDs, also check `docs/sprints/archive/`.

Otherwise, find the most recent closed sprint:
```bash
ls docs/sprints/S*.md 2>/dev/null | sed -n 's|.*/\(S[0-9]\{1,\}\)\.md|\1|p' | sort -V -r | head -5
# Falls back to legacy if no S-numbered manifests exist
[ -z "$(ls docs/sprints/S*.md 2>/dev/null)" ] && ls docs/sprints/*.md 2>/dev/null | grep -v '/archive/' | sort -r | head -5
```
Read each in mtime order. The most recent one with an `## Outcomes` section is the target. If none has Outcomes, the most recent sprint hasn't been closed yet — print:
```
Sprint retro abort: no closed sprint found. Run /sprint-end first to close the current sprint, then re-run /sprint-retro.
```
Exit 0.

## Phase 2: Layer 1 — Auto-derived metrics

Read the target manifest. Extract:
- Sprint ID, start date, committed issue list (issue numbers + their module assignments)
- Classification snapshot (cross-cutting %, total candidates, modules represented, risk distribution, target vs committed size)
- Outcomes section (counts per outcome category)

For each issue in the committed list, query GitHub once:
```bash
gh issue view N --json number,title,state,closedAt,labels
```

Compute these metrics:

### 2A. Throughput
- **Committed:** N (from manifest)
- **Shipped:** count of committed issues now in `state: CLOSED`
- **Ship rate:** shipped / committed (as %)

### 2B. Module ship-rates
For each module in the manifest, count committed and shipped. Render:
```
module-a:    5 committed, 0 shipped (0%)   ⚠ no progress
module-b:    5 committed, 4 shipped (80%)
module-c:    9 committed, 7 shipped (78%)
```
Flag modules with 0% ship as `⚠ no progress`. Flag modules with 100% ship as `✓ complete`.

### 2C. Risk distribution shipped
Compare risk distribution committed (from snapshot) vs risk distribution shipped (parse SCOPE-GATE Risk lines for shipped issues). Surface if HIGH-risk issues are systematically NOT shipping while LOW are. That's a calibration signal.

### 2D. Time-to-implement (per issue)
For each shipped issue:
```bash
gh issue view N --json closedAt,timelineItems --jq '...'
```
Get `closedAt` and the `labeled` event for `greenlit`. Compute `closedAt - greenlitAt` in hours.
- Median time-to-implement
- Outliers (>2x median)

If `greenlit` label history isn't available (issue closed via direct commit with `Closes #N` but `greenlit` was never set), skip that issue from the median.

### 2E. Cross-cutting trend
Read the last 4 manifests' classification snapshots. Plot the cross-cutting % over time:
```
S016: 47%  ▼ baseline
S017: 55%  ▲ +8
S018: 62%  ▲ +7
S019: 71%  ▲ +9
```
Flag rising trend (3+ sprints of increase) as `⚠ module map likely needs an audit`.

### 2F. Roll-forward streak
For each issue still open from the target sprint, check the last 4 manifests for prior membership. Issues that appear in 3+ consecutive manifests without shipping:
```
#350 — rolled 4 sprints in a row, never touched. Consider closing or restructuring.
```

## Phase 3: Render Layer 1

```
==========================================
SPRINT RETRO — {SPRINT_ID}
==========================================

THROUGHPUT
  Committed:  N issues
  Shipped:    K (X%)
  Rolled:     R back to scoped pool
  Abandoned:  A

MODULE SHIP-RATES
  [per-module breakdown from 2B]

RISK SHIPPED
  HIGH: shipped P of Q committed
  MED:  shipped P of Q
  LOW:  shipped P of Q

TIME-TO-IMPLEMENT
  Median: X hours
  Outliers: #N (Yh), #M (Zh)

CROSS-CUTTING TREND (last 4 sprints)
  [4-line plot from 2E]

ROLL-FORWARD WATCHLIST
  [issues rolled 3+ sprints — from 2F]
```

## Phase 4: Layer 2 — Operator questions (skip if --no-questions)

Print the three questions one at a time. Wait for each response before moving on.

### Question 1
```
1/3 — Did the sprint feel right-sized?
   Reply: too-big | right | too-small | (free-text if you want to elaborate)
```

### Question 2
```
2/3 — What blocked the unfinished work?
   One sentence. (Common shapes: capacity, dependencies, lost interest, scope creep, hit usage limits, etc.)
```

### Question 3
```
3/3 — Anything you wished was in the sprint that wasn't?
   One sentence. (Optional — reply "nothing" if not.)
```

Capture responses verbatim.

## Phase 4.5: Layer 1.5 — Process notes (auto-captured during sprint)

Read the manifest's `## Process notes` section if present. This section is appended-to during the sprint by the agent whenever the operator pushes back on something, sets a new preference, or surfaces a workflow friction point. It captures qualitative context the operator never had to interactively provide.

If the section is empty or missing, skip and continue.

If present, surface the entries verbatim so they feed into Phase 5 synthesis. Format:
```
PROCESS NOTES (captured during sprint)
- [date] — [note as written]
- [date] — [note as written]
```

These notes are first-class input to the recommendation synthesis. A note like "{{OPERATOR}}: 'sprint-walkthrough's pre-answer questions feel redundant'" is exactly the kind of signal that should drive a Layer-3 recommendation to revise that section of the skill.

## Phase 4.6: Layer 1.6 — Cleanup queue (auto-captured during sprint)

Read the manifest's `## Cleanup queue` section if present. This section accumulates sidebar items that sprint-* skills noticed during the sprint but did NOT surface in the operator's main output (per the no-hedges, no-sidebars rule). Examples: rotten issues sitting outside the sprint, singleton-module issues that didn't make the pick, drift signals from `/sprint-doctor` runs, etc.

If the section is empty or missing, skip and continue.

If present, classify each entry:
- **Auto-actionable** (e.g., "issue is rotten because cited path was renamed — rewrite the path") → action it now during the retro. Print `[CLEANUP] <action> — done` per item.
- **Operator-decision-required** (e.g., "rotten issue might be moot — close or fix?") → surface as one of the 1-3 actionable Layer-3 recommendations. Don't auto-act.

The principle: items captured in the cleanup queue exist BECAUSE they didn't fit the immediate output shape. The retro is the venue for resolving them. Do not re-defer ("will look at next sprint") — either action or escalate to a recommendation, then clear the entry from the queue (mark with `~~strikethrough~~` so the audit trail survives).

## Phase 5: Layer 3 — Synthesis

Combine Layer 1 + Layer 1.5 + Layer 2 into 1-3 specific, actionable recommendations. Each recommendation should:
- Cite the data or note that motivated it
- Name a concrete action (a command to run, a file to edit, an issue to file/close)
- Be testable next sprint

Examples (illustrative — generate the actual suggestions from the actual data):

```
RECOMMENDATIONS

1. Right-size next sprint to 12 issues.
   Why: 3-sprint average ship rate is 38% (10/26). You said "too-big" this week.
   Action: /sprint-start --size 12

2. Audit modules.md before next sprint.
   Why: Cross-cutting % rose 47% → 71% over 4 sprints. New code surfaces are likely missing.
   Action: review docs/modules.md against recent commit paths; add any new module sections.

3. Close or restructure #350.
   Why: Rolled 4 sprints in a row without being touched. Likely either dead or needs splitting.
   Action: gh issue close 350 with a "won't fix" reason, OR file a new issue with narrower scope.
```

If neither layer produces signals strong enough for actionable recommendations, surface that honestly:
```
RECOMMENDATIONS
   No actionable patterns surfaced this sprint. The data and your answers were consistent — keep the current cadence.
```

Do not pad. Three recommendations is the cap; one is fine; zero is fine if the data genuinely doesn't warrant them.

## Phase 6: Write the retro doc

Append to the sprint manifest under a new `## Retro` section:

```markdown
## Retro ({YYYY-MM-DD})

### Auto-derived metrics
[Phase 3 output, verbatim]

### Operator answers
1. Right-sized? **{response}**
2. What blocked unfinished work? {response}
3. Wished-for additions? {response}

### Recommendations for next sprint
[Phase 5 output, verbatim]
```

Don't create a separate file — keeping the retro inline with the manifest means future retros can read all the prior data from one location per sprint.

## Phase 7: Print final summary

```
==========================================
RETRO COMPLETE — {SPRINT_ID}
==========================================

**What just happened**
Stored: `docs/sprints/{SPRINT_ID}.md` (`## Retro` section).

**Your next step**
- Apply recommendations to your `/sprint-start` command (e.g., `--size` override)
- Run `/sprint-doctor` to verify clean state before next sprint
- `/sprint-start` when ready
```

## Standing rules

- **Don't ask more than three questions.** This is a 2-minute check-in, not a meeting. If you find yourself drafting question 4, cut question 1.
- **Don't pad recommendations.** Zero recommendations is a valid output if the data is uninformative. Made-up "improvements" rot the trust in this skill.
- **All data sources are local or `gh`.** No external services, no DBs, no scraping. The manifest + GitHub state is the truth.
- **Append to the manifest, don't fork.** Future retros need to read prior retros to detect trends. One manifest per sprint, growing over time, is the correct shape.
- **Run me consistently or don't run me at all.** A retro every 4 weeks gives no trend data. A retro every sprint, even when the answers are "right-sized / no blockers / nothing wished," builds the calibration history that makes Layer 3 useful three months from now.
