---
description: Walk through completed READY plans one at a time in manager-grade language. Reads plan files plus reviewer verdicts plus related context, then surfaces each plan's load-bearing question, fix, and trade-offs so the operator can decide whether to ship the work — without re-reading the technical artifact. (Requires: issues labeled `ready` with plan files at docs/protocol-test-runs/.)
argument-hint: [<label>]
---

# Plan Walkthrough (v1)

{{INCLUDE:glossary}}

**Session model:** Sonnet. Translation work, not architectural reasoning. If a specific plan turns out to need deeper analysis mid-walkthrough, the operator can spawn an Opus session for that one plan.

**Translation, not evaluation.** The reviewer already cleared these plans as dispatch-ready (`ready` label). This skill does not re-grade plan quality. It translates the technical artifact into the form the operator needs to decide whether to ship the work — what the work is, why, and what it affects. Worth-it is the operator's call; the walkthrough surfaces the context that call requires.

**One at a time. No upfront list.** The operator does not want a table of contents. Dive into Plan 1 of N. Pause between plans for the operator to respond before moving on.

You run on `$1` (optional secondary label filter) — defaults to all open issues with the `ready` label if no filter is passed.

## Phase 0: Tool-availability gate (fail-closed)

```bash
gh auth status >/dev/null 2>&1 || { echo "Walkthrough abort: gh not authenticated."; exit 1; }
gh repo view --json name >/dev/null 2>&1 || { echo "Walkthrough abort: gh cannot reach current repo."; exit 1; }
```

## Phase 1: Plan enumeration

Fetch all open issues labeled `ready`:

```bash
gh issue list --state open --label ready --limit 100 --json number,title,body,labels
```

If `$1` was passed, intersect — only issues that carry BOTH `ready` AND `$1`.

For each issue, locate its plan file:
```bash
find docs/protocol-test-runs -name "issue-${N}-*.md" 2>/dev/null
```

If multiple plan files exist (e.g., one-round and three-round), use the most recent by mtime. If no plan file exists, mark the issue `skipped: no plan artifact found` — do not invent context, do not synthesize from the issue body alone.

## Phase 1.5: Module grouping

Read `docs/modules.md` if it exists. Parse module entries — each module has a name (H2 heading) and one or more "Primary code" path entries. Build a `path → module` index from longest-prefix to shortest (so `api/checkout/stripe/` resolves to its specific module before `api/checkout/` resolves to a more general one).

For each plan:
1. Parse the plan file body for cited file paths (anything matching the `{{PATH_PREFIXES}}/` regex used elsewhere in this pipeline).
2. Look up each path in the module index. Tally hits per module.
3. The plan's **primary module** is the one with the most path hits. Ties broken by alphabetical module name.
4. If no paths resolve to any module (config-only changes, doc-only, etc.), assign `Cross-cutting`.
5. If `docs/modules.md` doesn't exist, fall back to a single `Unsorted` group — the skill still runs, just without grouping benefit.

**Sort the queue:**
1. Group plans by primary module.
2. Order modules by the highest-priority plan inside (module with a `p1-now` plan goes before module with only `p2-next` plans). `Cross-cutting` always goes last.
3. Within each module, sort by priority (`p1-now` → `p2-next` → `p3-later` → unlabeled), then issue number ascending.

Print exactly: `Found N plans across M modules. Starting with Plan 1 of N — [module name].` Then proceed directly to Phase 2 — do not list the remaining plans.

## Phase 2: Per-plan walkthrough loop

For each plan in the sorted list:

1. Read the plan file in full
2. Read the issue body and the most recent reviewer comment (look for `**Review complete.**` marker)
3. If the plan references a master plan in `docs/plans/`, skim the relevant section so you can answer "how does this fit the bigger picture?"
4. Produce the walkthrough output using the Phase 3 format
5. **Pause.** Wait for the operator to respond before continuing.

Operator response handling:
- **"next" / "ship it" / "yes" / "good"** → record GREENLIT, move to the next plan
- **"skip" / "abandon" / "close this" / "don't do this"** → record ABANDONED with the operator's stated reason, move on
- **"close and replace" / "file a new issue for X"** → record CLOSE_AND_REPLACE with the new issue intent, move on
- **A question** → answer it. Do not proceed until the operator signals readiness ("ok next," "got it," etc.)
- **A scope correction** ("can we bundle this with X?", "two more meta tags wouldn't be hard") → record AMENDED with the change, then move on

Do not write to GitHub during the walkthrough. All bookkeeping is verbal/in-session. The closing tally captures decisions for follow-up action.

## Phase 3: Walkthrough output format (per plan)

Exactly four beats. Manager-grade language. No undefined jargon.

**Module transition.** When the plan being walked through is the first one in a new module (i.e., the previous plan was in a different module), prepend a single transition line above the plan header:

```
--- Now in: [Module Name] · [count] plans in this module ---
```

Skip the transition line for Plan 1 (the position header already names the module). Skip it when consecutive plans are in the same module.

```
## Plan N of M — Issue #XXX ([reviewer verdict: READY]) · [Module Name]

**Context first:**
[2-3 sentences. What the system in question even IS. Analogies to consumer products are fine
("a 'command palette' is the Cmd+K shortcut feature you've used in Linear or Notion").
Assume the operator did not write the code and may not remember it.]

**The problem:** *(or "The drift," "The dead code," "The opportunity" — match the issue shape)*
[2-4 sentences. What the issue actually surfaces. Lead with the load-bearing question —
the one whose answer could invalidate the rest. If it's a real bug, name the user impact.
If it's dead code, say so directly. If it's a feature, say what users get.]

**What this fix does:**
- [Concrete bullet. Files or surfaces touched.]
- [Concrete bullet. Behavior change.]
- [Concrete bullet. What the operator or a user would notice.]
- [Optional: deploy footprint — frontend only, edge function deploy, migration, etc.]

**Trade-offs and sibling findings:**
[What the critic rounds surfaced (Round 1 structural critiques, Round 2 evidence gaps,
Round 3 tensions). What the reviewer flagged or resolved. If the reviewer split work
into multiple PRs but bundling would be cheaper, say so. If the plan reveals "we should
question whether we even want this feature long-term," surface it here.]
```

After this block: STOP. Wait for operator response.

## Phase 4: Pre-answer the recurring questions

The operator asks the same questions across plans. Pre-answer them in the body where applicable so the operator does not have to interrupt:

- **Scope: universal or per-user/workspace?** If a fix changes behavior for everyone vs. just paid users vs. just admins, name that scope explicitly.
- **Does this lock us in, or make deprecation easier?** If the work is patching a feature the operator might want to remove long-term, surface that the work makes the eventual removal cheaper (or harder).
- **"If we designed from scratch?"** If the plan is patching a smell rather than fixing it, name the smell. Be ready to answer this when asked.
- **Reviewer over-scoping.** If the reviewer split scope into multiple plans/PRs and bundling would obviously be cheaper (e.g., "two more meta tags would't be a separate issue"), default to recommending the bundle.
- **Strategic fit.** If the plan touches an area the operator has expressed strategic skepticism about, surface it. The walkthrough is the venue for "should we even be doing this?"

When the operator says **"ask me a question that, knowing the answer, would let you make the call"** — produce ONE binary question. Do not waffle. Do not list options. One question, one answer, one decision.

## Phase 5: Closing tally

After the last plan is walked through, print the tally **grouped by module** — so the operator can see at a glance which parts of the system are getting attention this sprint, and whether the ship/abandon mix concentrates in one area:

```
==========================================
WALKTHROUGH COMPLETE — N plans reviewed across M modules
==========================================

### [Module Name] ([count] plans · [k greenlit, j abandoned, etc.])
- GREENLIT: #N1, #N2 — [one-line outcomes from operator]
- ABANDONED: #N3 — [operator's reason]
- AMENDED: #N4 — [scope change agreed]
- CLOSE + REPLACE: #N5 → new issue: [intent]

### [Next Module Name] ([count] plans · ...)
- ...

[After all module sections, the cross-cutting items:]

SIBLING ISSUES TO FILE ([count]):
- [title] — [why this surfaced during walkthrough] — touches: [module]

SKIPPED ([count]):
- #N — [reason: no plan artifact / etc.]

NEXT STEPS:
- Implement greenlit plans? Y/N
- File the close-and-replace + sibling issues now? Y/N
- Close the abandoned ones with the recorded reason? Y/N
```

The next steps are operator decisions — do not act on them automatically. Walkthrough ends at the tally; follow-up actions are explicit operator authorization.

## Standing rules

- **Manager language.** No jargon without explanation. The operator is competent but did not write the code and is not reading along. Define what a "feature flag," "RLS policy," "cron handler," "migration" is *if it appears in the plan you're walking*.
- **One plan at a time.** Never dump multiple plans in one response. Pacing is set by the operator's readiness, not a queue.
- **Lead with the load-bearing question.** Every plan has one — the question whose answer could change the verdict. Surface it in the "problem" beat, not at the end.
- **No reviewer second-guessing on plan quality.** The reviewer already cleared this. If the plan looks technically wrong, that's a separate `/review-plans --force` call — don't relitigate during walkthrough.
- **Surface contradictions, don't hide them.** If the walkthrough reveals the work shouldn't happen, say so directly. That is the *purpose* of this skill — the reviewer can't catch worth-it judgments because it doesn't carry the operator's strategic context.
- **No GitHub writes during the walkthrough.** Closing issues, filing siblings, opening PRs all happen after the tally, with explicit operator authorization. The walkthrough is a translation layer, not a write layer.
- **Honor scope corrections without litigation.** If the operator says "bundle these," do it. If they say "split this," do it. The reviewer's verdict is advisory in the walkthrough — the operator's call is final.
- **Module coherence over priority order.** Plans within one module stay adjacent. The operator's mental model is per-module — context switching between modules during a walkthrough loses the stack from the previous module. Module ordering is by highest-priority plan inside; within a module, priority + issue number. Never split a module's plans across the queue.
