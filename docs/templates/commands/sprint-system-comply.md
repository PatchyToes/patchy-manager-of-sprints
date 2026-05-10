---
description: Compliance audit for the sprint skill system. Static scan of every sprint-* skill against its contract (no-hedge vocab, fail-closed Phase 0, anchoring format, required phases). Optional --dynamic mode dispatches subagents to render skill outputs under 3 prompt strictness levels and classifies whether the rendered output still matches contract. Use when output quality drifts or before publishing the skill system to a sibling repo.
argument-hint: [<skill-name>] [--dynamic] [--write-report] [--quiet]
---

# Sprint System Comply (v1)

{{INCLUDE:glossary}}

**Session model:** Sonnet. Mostly mechanical (file scans + regex checks) plus some judgment for borderline contract violations. The optional `--dynamic` mode dispatches subagent simulations and uses an LLM classifier — that part is reasoning-heavy.

**What this skill is for.** The sprint pipeline has accumulated invariants over time — no-hedge contract, 4-beat walkthrough format, one-verb-per-turn, fail-closed Phase 0, "What just happened / Where you are now / Your next step" anchoring with bold mini-title labels on their own line. None of these are enforced by the harness. This skill enforces them.

**What this skill is NOT.** It is not a runtime guard. It runs on demand, scans skill source, optionally simulates rendered output, and reports drift. Fixing the drift is a separate operator action — typically editing `docs/templates/commands/<skill>.md` and re-running `node scripts/generate-skills.mjs`.

Optional `$1`:
- `<skill-name>` — audit one skill (e.g. `sprint-walkthrough`)
- `--dynamic` — also run Phase 3 (3-variant simulated render + LLM classifier per skill). Costs ~3 subagent runs per audited skill.
- `--write-report` — write the audit report to `tmp/sprint-system-comply-{TIMESTAMP}.md` instead of stdout-only
- `--quiet` — emit only the system verdict line + any FAIL findings; suppress the per-skill PASS/WARN table. Used by `/sprint-doctor`'s auto-chain to fold contract-drift into the pipeline-health report without doubling its output volume.

If no skill name is given, audits the full sprint-* set: `enrich-issue scope-issue batch-scope plan-issue-one-round plan-issue-three-round review-plans sprint-start sprint sprint-plan sprint-walkthrough sprint-implement sprint-ship sprint-test sprint-end sprint-retro sprint-doctor sprint-system-comply sprint-instinct-curator canary-watch`.

## Phase A: Announce

Before any tool calls, print this preamble exactly (with a trailing blank line). Plain text — do not wrap in code fences or add Markdown.

```
═══ SPRINT · system comply ═══
Auditing sprint-* skills against contract. Static scan first; --dynamic adds 3-variant render simulation.
```

## Phase 0: Tool-availability gate (fail-closed)

```bash
git --version >/dev/null 2>&1 || { echo "Sprint system comply abort: git not in PATH."; exit 1; }
[ -d "docs/templates/commands" ] || { echo "Sprint system comply abort: docs/templates/commands/ not found — run from repo root."; exit 1; }
[ -d ".claude/commands" ] || { echo "Sprint system comply abort: .claude/commands/ not found — run from repo root."; exit 1; }
```

If `--dynamic`, also verify Agent + SendMessage are available (the dispatch tools need `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`). If not available, downgrade silently to static-only and note in the report footer.

## Phase 1: Resolve target set

Build the list of skills to audit:

```bash
TARGETS=()
if [ -n "$1" ] && [ "$1" != "--dynamic" ] && [ "$1" != "--write-report" ]; then
  TARGETS+=("$1")
else
  TARGETS=(enrich-issue scope-issue batch-scope plan-issue-one-round plan-issue-three-round review-plans sprint-start sprint sprint-plan sprint-walkthrough sprint-implement sprint-ship sprint-test sprint-end sprint-retro sprint-doctor sprint-system-comply sprint-instinct-curator canary-watch)
fi
```

For each, verify both `docs/templates/commands/<name>.md` and `.claude/commands/<name>.md` exist. If the live (`.claude/commands/`) file is missing or older than the template, flag as `OUT-OF-SYNC` (the operator forgot to run the generator). Continue the audit using the template — that's the source of truth.

## Phase 2: Static contract audit

For each target, read its template and check the contract clauses below. Each clause emits `PASS`, `WARN`, or `FAIL` with file:line evidence.

### 2A. Universal clauses (apply to every sprint-* skill)

| Clause | Check | Severity |
|---|---|---|
| **U1. YAML frontmatter present** | First line is `---`, contains `description:` field | FAIL |
| **U2. Phase A announce block** | Heading `## Phase A: Announce` exists, contains a `═══` preamble inside a code fence. **Required only for operator-flow skills** (sprint-start, sprint-plan, sprint-walkthrough, sprint-implement, sprint-ship, sprint-test, sprint-end, sprint-retro, sprint-doctor, sprint-system-comply, sprint-instinct-curator). Exempt: enrich-issue, scope-issue, batch-scope, plan-issue-one-round, plan-issue-three-round, review-plans, sprint (these are mechanical/triage/planning skills with no operator-facing session preamble) | FAIL when required |
| **U3. Phase 0 fail-closed gate** | Heading `## Phase 0:` exists, body contains a fail-closed gate. Accepted patterns: (a) bash gate with `exit 1` AND a tool-availability check (e.g. `gh auth status`); OR (b) prose abort gate with explicit `Stop.` / `halt` / `Surface to user` instruction AND an `ABORTED:` or `PROTOCOL FAILURE:` literal output marker (used by orchestrator-style skills where the "process" is the LLM, not a shell). Both forms are equivalent — what matters is that abort is unambiguous and machine-detectable | FAIL |
| **U4. Glossary include** | Source contains `{{INCLUDE:glossary}}` — required because skills reference `IK files`, `GIC block`, `pipeline labels`, etc. | WARN (skip for skills that genuinely use no glossary terms — e.g. `sprint`, the status oracle) |
| **U5. Anchoring closer** | Skill prints a closing block with three bold labels each on their own line: `**What just happened**`, `**Where you are now**`, `**Your next step**`. Exception: pure-mechanical skills with no operator-facing summary (`enrich-issue`, `batch-scope` write-mode) | FAIL when expected, otherwise N/A |
| **U6. Standing rules section** | Heading `## Standing rules` (or `## Standing notes`) exists at end of file, has at least one bullet | WARN |

### 2B. Forbidden vocabulary scan

Grep the template for vocabulary that violates the no-hedge / no-sidebars contract. Each match is a FAIL with file:line.

Patterns:
- `\bcould potentially\b`
- `\bworth considering\b`
- `\bfair point\b`
- `\bI think\b` (case-insensitive)
- `\bperhaps\b`
- `\bmay want to\b`
- `\bfeel free to\b`
- `\bif you want\b`
- `\bsomething to think about\b`

Allowed exceptions (matches inside a fenced code block that's an example of operator-facing OUTPUT — quoting verbatim what we'd say to a user — are still violations; this is the contract, not the meta-discussion of it). The audit treats every match as a real finding by default; false positives can be silenced by adding `<!-- comply:allow forbidden-vocab -->` on the same line. Prefer fixing the wording.

### 2C. Required-vocabulary patterns

For specific skills, certain output anchors must be present in the template body. Each missing anchor is a FAIL.

| Skill | Required anchor |
|---|---|
| `sprint-walkthrough` | All four 4-beat headers: `Context first`, `The problem`, `What this fix does`, `Trade-offs` |
| `sprint-walkthrough` | The literal phrase `WALKTHROUGH-DECISION` (must write this comment) |
| `scope-issue` | All five verdict tokens: `PLAN-3-ROUND`, `PLAN-1-ROUND`, `DEFER`, `ABORT`, `NEEDS-OPERATOR` |
| `scope-issue` | The literal phrase `SCOPE-GATE` (must write this comment) |
| `sprint-end` | A `## Phase 1.5` (pre-close gate) — early-close is destructive; the gate is load-bearing |
| `sprint-implement` | The literal phrase `Closes #` AND the phrase `ISSUE MANAGEMENT` (the dispatch brief contract) |
| `plan-issue-three-round` | The strings `R1`, `R2`, `R3` (the three critic rounds) AND `Agent(` AND `SendMessage(` |
| `plan-issue-one-round` | The strings `Agent(` AND `SendMessage(` (orchestrator pattern, no Skill-tool nesting) |
| `sprint-doctor` | All three verdict tokens: `HEALTHY`, `DEGRADED`, `BROKEN` |

### 2D. Phase numbering integrity

Phases must run Phase A then Phase 0 then ascending integers (`1`, `1.5`, `2`, `2A`, `2B`, ...). Gaps are WARNs (`Phase 0` → `Phase 2` with no `Phase 1`). Out-of-order is FAIL.

```bash
# Extract all "## Phase X" headings, verify ordering
grep -E '^## Phase [A-Z0-9.]+' docs/templates/commands/<name>.md
```

### 2E. Manifest path consistency

Skills that touch `docs/sprints/` should use the canonical resolution pattern:

```bash
ls docs/sprints/S*.md 2>/dev/null | sed -n 's|.*/\(S[0-9]\{1,\}\)\.md|\1|p' | sort -V | tail -1
```

Skills that hardcode a manifest filename or use a different glob get a WARN.

### 2F. Generator-list membership

Verify every audited skill is listed in [scripts/generate-skills.mjs](../../../scripts/generate-skills.mjs)'s `skills` array. If not, the live skill in `.claude/commands/` is orphaned (won't regenerate). FAIL.

## Phase 3: Dynamic 3-variant simulation (only if `--dynamic`)

Skip this phase entirely unless `--dynamic` was passed. Costs roughly 3–4 subagent runs per audited skill.

The premise: even when source-code static checks pass, the LLM running the skill may quietly drift — adding hedges under prompt pressure, skipping the 4-beat format, dropping anchoring blocks. This phase tests that under three prompt strictness levels.

### 3A. Generate fixture

Pick one recent representative input per skill type:

| Skill | Fixture |
|---|---|
| `scope-issue`, `enrich-issue`, `plan-issue-*` | A small, well-formed open issue body — pull the most recent `scoped` issue's title+body via `gh issue view <N> --json title,body` |
| `sprint-walkthrough` | A synthesized minimal sprint manifest with one ready plan + plan file content |
| `sprint-doctor` | The current repo state (the doctor reads live state — the simulation just runs a dry-run-style render) |
| `sprint-implement` | An existing greenlit issue + plan file path |
| `sprint-end`, `sprint-start`, `sprint-retro`, `sprint-ship`, `sprint-test` | Skip dynamic phase — these have heavy side effects and irreducible state dependencies; static audit is sufficient |

Cache the fixture in `tmp/sprint-system-comply-fixtures/<skill>.json` so re-runs are deterministic and cheap.

### 3B. Three prompt variants

For each audited skill, build three variants of an instruction wrapper:

**Variant 1 — supportive** (operator wants the skill executed correctly):
```
You're running /<skill> against the fixture below. Follow the spec precisely.
Render exactly what you'd output on stdout. DO NOT call any tools, write any
files, or post any GitHub comments. Just render.

Fixture:
<fixture content>
```

**Variant 2 — neutral** (operator gives a minimal nudge):
```
Walk this through /<skill>:

<fixture content>
```

**Variant 3 — competing** (operator implicitly asks for a different shape; the contract is what should win):
```
Just give me the bottom line on this — keep it short, skip ceremony, gut call only.

<fixture content>
```

### 3C. Dispatch the simulation

For each (skill × variant), use the Agent tool to spawn a Sonnet subagent with the variant prompt. Each subagent renders one output. Collect 3 outputs per skill.

```
Agent({
  description: "Comply render: <skill> variant <N>",
  subagent_type: "general-purpose",
  model: "sonnet",
  prompt: "<variant prompt with fixture interpolated>"
})
```

Render-only — agents are explicitly told not to call tools. If a subagent ignores the constraint and tries to call `gh` / `git` / `Edit`, that's itself a contract violation (record as FAIL: "skill simulator side-effected under variant N").

### 3D. Classifier

Spawn one Opus classifier per audited skill (one classifier reviews all 3 variants). Pin Opus — judgment over which renders match contract is high-stakes and we don't want classifier drift in the audit itself.

Pass to the classifier:
- The skill's contract clauses (from Phase 2C plus universal U2/U5)
- The 3 rendered outputs
- A scoring rubric:
  ```
  For each contract clause × each variant, score:
    PASS  — clause satisfied
    PARTIAL — clause partially satisfied (e.g., 3 of 4 walkthrough beats present)
    FAIL  — clause violated or missing
  ```

Classifier returns a 3×N matrix of scores plus a one-paragraph "drift summary" — what shape of drift appears under prompt pressure, if any. The competing variant is the most diagnostic; supportive should always pass.

### 3E. Record dynamic findings

Append to the report. Flag any clause that PASSED static (Phase 2) but FAILED dynamic (Phase 3) — these are the highest-leverage findings, indicating the source-code looks fine but the LLM under pressure doesn't follow it. Common causes: spec is ambiguous, anchor is buried in prose, or the skill's instructions are too long for the LLM to honor under prompt competition.

## Phase 4: Aggregate verdict + report

For each target, aggregate Phase 2 + (optional) Phase 3 findings into one of:

- **HEALTHY** — all clauses PASS, no FAILs, no WARN-grade issues that affect behavior
- **DEGRADED** — at least one WARN, no FAILs (skill works but contract is loose)
- **BROKEN** — at least one FAIL (contract violation that affects behavior)

Across all targets, compute the system-level verdict using the same scale.

Print the report:

```
═══ SPRINT SYSTEM COMPLY — {TIMESTAMP} ═══
Mode: static{ + dynamic if --dynamic}

System verdict: {HEALTHY | DEGRADED | BROKEN}

Per-skill summary:
| Skill | Static | Dynamic | Verdict |
|---|---|---|---|
| enrich-issue | 6/6 | n/a | HEALTHY |
| scope-issue | 5/6 (1 WARN) | n/a | DEGRADED |
| sprint-walkthrough | 4/6 (2 FAIL) | 0.7/1.0 | BROKEN |
| ...

Findings (FAIL first, WARN after):

[FAIL] sprint-walkthrough — U5 anchoring
  Skill closes with old "Done / You are here / Next" labels at line 234,
  but contract requires bold mini-title labels on their own line per
  feedback memory `feedback_sprint_output_anchoring`.
  Fix: replace with **What just happened** / **Where you are now** / **Your next step**.

[FAIL] sprint-walkthrough — 2C 4-beat
  Missing the literal heading "What this fix does" — the third 4-beat
  header is paraphrased as "What this changes" at line 312.
  Fix: change to canonical "What this fix does".

[WARN] scope-issue — 2D phase numbering
  Phase 1 → Phase 2A → Phase 2B → Phase 4 (no Phase 3).
  Fix: renumber Phase 4 to Phase 3, or add a stub Phase 3.

[Phase 3 dynamic findings, if --dynamic was passed]:

[FAIL-DYNAMIC] sprint-walkthrough — competing variant
  Classifier verdict: under the competing prompt, render dropped 4-beat
  format and produced a single-paragraph summary instead. Static check
  passes, but the LLM under prompt pressure doesn't follow the contract.
  Drift summary: "the spec's 4-beat requirement appears in line 245 of
  the template but is buried in 1200 words of phase descriptions; the
  LLM honors it under supportive prompt only."
  Fix: hoist the 4-beat requirement into Phase 0 invariants or pin a
  literal output template at the render site.
```

If `--write-report`, also write the same content to `tmp/sprint-system-comply-{TIMESTAMP}.md`. The directory `tmp/` is gitignored.

If `--quiet` was passed, suppress the per-skill summary table and emit only:

```
═══ SPRINT SYSTEM COMPLY (quiet) ═══
System verdict: {HEALTHY | DEGRADED | BROKEN}
{If any FAILs, list them — one line each:}
  [FAIL] <skill> — <clause> — <one-line description>
{If --dynamic was passed and dynamic FAILs surfaced, prefix with [FAIL-DYNAMIC].}
```

This format is what `/sprint-doctor` consumes when it auto-invokes comply during its Phase 3.5 contract check.

## Phase 5: Exit code

- HEALTHY → exit 0
- DEGRADED → exit 0 (still usable, but stderr-print the warn count)
- BROKEN → exit 1 (CI / pre-publish gates can wire this)

## Standing rules

- **Static is always run; dynamic is opt-in.** Static is cheap, deterministic, fast (<5s for the full set). Dynamic costs subagent runs and an Opus classifier — only run before publishing the skill system to a sibling repo, after a major refactor, or when output quality has visibly drifted.
- **Source of truth is the template, not the live skill.** If a `.claude/commands/<skill>.md` file is OUT-OF-SYNC with its template, that's a finding, but the audit reads the template. Operator runs `node scripts/generate-skills.mjs` to resolve.
- **The audit never modifies skills.** Only reports. Fixing drift is operator-driven. (Exception: a future `--repair` flag could auto-fix the small set of safely reversible drifts, e.g. forbidden-vocab one-liner replacements — not in v1.)
- **Contract evolves; the audit catches up.** If a feedback memory adds a new contract clause (e.g., "all sprint outputs must end with anchoring"), that clause goes into Phase 2A/2C of this skill. The audit lags the contract by one edit; that's fine — the system's invariants live in MEMORY.md, not in this skill's checklist.

**What just happened**
Audited the sprint-* skill set against contract. Static scan found {N} FAILs and {M} WARNs. {If --dynamic was passed: dynamic simulation surfaced {K} additional drift findings.} The full report is above {if --write-report: and was also written to tmp/sprint-system-comply-{TIMESTAMP}.md}.

**Where you are now**
The audit is read-only — no skills were modified. {If FAILs found: System verdict is BROKEN; the FAILs above are blocking issues that affect skill behavior.} {If only WARNs: System verdict is DEGRADED; warnings are non-blocking but worth fixing before the next system-level edit.} {If clean: System verdict is HEALTHY.}

**Your next step**
{If FAILs: Fix the FAILs in `docs/templates/commands/<skill>.md` then run `node scripts/generate-skills.mjs` to regenerate `.claude/commands/`. Re-run `/sprint-system-comply` to confirm clean.} {If only WARNs: Address WARNs at the next routine edit pass, no immediate action.} {If clean and --dynamic was not run: Consider running `/sprint-system-comply --dynamic` before the next public release of the skill system.}
