---
description: Pattern observer for the sprint pipeline. Reads recent debriefs, sprint manifests, scratchpads, and commit messages — surfaces recurring lessons, gotchas, and decisions that should become memories. Proposes ranked candidate updates to MEMORY.md with evidence and confidence scoring. Pull-model — no hooks. Run weekly during /sprint-retro or on demand when the operator senses they keep rediscovering the same things.
argument-hint: [--since <date>] [--write] [--no-decisions] [--target <user|feedback|project|reference>]
---

# Sprint Instinct Curator (v1)

{{INCLUDE:glossary}}

**Session model:** Sonnet for observation gathering and pattern clustering. Opus for the final candidate-vs-existing-memory dedupe judgment — that decision is load-bearing (a duplicate write pollutes MEMORY.md, a false-negative dedupe drops a real lesson). Cheap enough to pin Opus.

**What this skill is for.** The sprint pipeline produces rich observation signals — debriefs, manifest scratchpads, retro process notes, commit message bodies. These contain the lessons the team keeps rediscovering: SQL gotchas, deploy-ordering pitfalls, planner blindspots, scope-gate misses. Today those signals only flow to MEMORY.md when the operator manually notices and writes them down. This skill auto-surfaces patterns and proposes memory candidates — operator approves, edits, or rejects.

**What this skill is NOT.** It is not a hook-based observer. The continuous-learning-v2 system this is patterned after uses 100% reliable hooks; this is a pull-model pull-when-asked variant that reads existing artifacts. That's a deliberate trade — the operator wants a curated funnel reviewed on a cadence, not shadow memory writes between sessions.

Optional `$1`:
- `--since <YYYY-MM-DD>` — observation window. Default: last 30 days.
- `--write` — auto-accept candidates with confidence ≥ 0.85. Without this flag, every candidate requires explicit operator decision.
- `--no-decisions` — surface candidates and exit; skip the operator decision loop entirely. Used by `/sprint-end`'s auto-chain to render candidates without interrupting close-out. Operator runs the curator standalone later for the decision pass.
- `--target <user|feedback|project|reference>` — restrict candidate proposal to one memory type. Default: all four types.

## Phase A: Announce

Before any tool calls, print this preamble exactly (with a trailing blank line). Plain text — do not wrap in code fences or add Markdown.

```
═══ SPRINT · instinct curator ═══
Reading recent debriefs, manifests, and commits. Surfacing patterns that should become memories.
```

## Phase 0: Tool-availability gate (fail-closed)

```bash
git --version >/dev/null 2>&1 || { echo "Sprint instinct curator abort: git not in PATH."; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Sprint instinct curator abort: gh not authenticated."; exit 1; }
[ -d "docs/debriefs" ] || { echo "Sprint instinct curator abort: docs/debriefs/ not found."; exit 1; }
[ -d "docs/sprints" ] || { echo "Sprint instinct curator abort: docs/sprints/ not found."; exit 1; }
```

Resolve the memory directory. Claude Code's auto-memory dir lives at `~/.claude/projects/<project-key>/memory/`, where `<project-key>` is a path-encoded form of the current repo path. The encoding is harness-version-specific (Windows uses `--` and `-` substitutions; macOS/Linux differs). Don't hand-mangle the path — search for it:

```bash
PROJECT_NAME=$(basename "$(pwd)")
# Try basename match first — fast and works for unique repo names.
MEMORY_DIR=$(find "$HOME/.claude/projects" -maxdepth 2 -name "memory" -type d 2>/dev/null \
  | while read -r dir; do
      key=$(basename "$(dirname "$dir")")
      echo "$key" | grep -qi "$PROJECT_NAME$" && echo "$dir" && break
    done | head -1)

# Fallback: ask {{OPERATOR}} for the literal path.
if [ -z "$MEMORY_DIR" ]; then
  echo "Sprint instinct curator: could not auto-detect memory directory."
  echo "The auto-memory dir for this session was injected at session start — check the system context block at the top of conversation for the absolute path under ~/.claude/projects/.../memory/, then re-run with: MEMORY_DIR='<path>' /sprint-instinct-curator"
  exit 1
fi

[ -f "$MEMORY_DIR/MEMORY.md" ] && echo "Memory dir: $MEMORY_DIR (MEMORY.md exists, $(wc -l < "$MEMORY_DIR/MEMORY.md") lines)" \
  || echo "Memory dir: $MEMORY_DIR (MEMORY.md will be created on first write)"
```

If the operator pre-set `MEMORY_DIR` in the environment, honor that and skip detection.

## Phase 1: Resolve observation window

```bash
SINCE_DATE="${SINCE:-$(date -d '30 days ago' +%Y-%m-%d 2>/dev/null || date -v-30d +%Y-%m-%d)}"
```

If `--since` was passed, use that. If not, default to 30 days ago. The window is intentionally short — older-than-30-day patterns either already became memories or are noise.

## Phase 2: Gather observation sources

For each source, gather raw text with context.

### 2A. Recent debriefs

```bash
find docs/debriefs -name '*.md' -newermt "$SINCE_DATE" | sort
```

For each: read the full file. Tag every section with its issue number (from frontmatter) and section heading. The post-debrief-format-upgrade structure means each debrief has 7 sections — pay particular attention to:
- `## What we tried that didn't work` — the highest-density signal source. Each entry is an explicit "we tried X, it failed because Y" lesson.
- `## Discoveries` — what execution revealed the plan didn't know.
- `## Plan quality` — patterns about what plans miss.

### 2B. Recent sprint manifests

```bash
find docs/sprints -maxdepth 1 -name '*.md' -newermt "$SINCE_DATE" | sort
```

For each manifest: extract these sections (they may not all be present):
- `## Process notes` — operator-driven workflow feedback captured during sprints (per `feedback_capture_sprint_process_notes`)
- `## Outcomes` — the close-out tally + roll-forward list
- `## Sprint scratchpad / ### Resolved` — entries that resolved with a stated resolution; "what we tried" data lives here
- `## Retro` — auto-derived metrics + qualitative notes

### 2C. Commit message bodies

```bash
git log --since="$SINCE_DATE" --pretty=format:'%H|%s|%b' --reverse
```

Commits whose body contains a "lesson," "fix," "regression," or "gotcha" framing — read the full body. These often carry the post-incident write-up.

### 2D. Recent reviewer verdicts on issues with `needs-operator`

```bash
gh issue list --state all --label needs-operator --search "updated:>=$SINCE_DATE" --json number,title,body,comments --limit 100
```

For each: read the most recent SCOPE-GATE, REVIEWER-VERDICT, or WALKTHROUGH-DECISION comment. Operator decisions on hard cases carry pattern-rich data: "I keep abandoning suggestions-system refactors" → operator instinct already surfaced.

### 2E. Existing MEMORY.md

```bash
cat "$MEMORY_DIR/MEMORY.md"
ls "$MEMORY_DIR"/*.md
```

Read the index plus every existing memory file. This is the dedupe corpus — Phase 3's classifier compares each candidate against existing memories and flags overlap.

## Phase 3: Cluster observations into pattern candidates

This is LLM work. Dispatch a Sonnet subagent with all observation sources from Phase 2 plus MEMORY.md context. Pass this prompt:

```
You are reviewing observation artifacts from a sprint pipeline to surface
patterns that should become persistent memories. The memory system stores four
types — user, feedback, project, reference — described in CLAUDE.md.

Inputs (verbatim, in order):
[2A] Recent debriefs:
<concatenated debriefs with issue-number prefixes>

[2B] Recent manifests (Process notes, Outcomes, Resolved scratchpad, Retro):
<concatenated manifest sections>

[2C] Recent commit messages with lesson/fix/regression framing:
<concatenated commit bodies>

[2D] Recent operator decisions on needs-operator issues:
<concatenated decision comments>

[2E] Existing memory corpus:
<MEMORY.md index + every memory file body>

For each pattern that appears 2+ times across distinct sources, propose a
candidate memory. Output as JSON array. Each candidate has:

{
  "pattern_summary": "one-line rule (the lesson)",
  "evidence": [
    {"source": "debrief|manifest|commit|decision", "ref": "issue-291 §What broke", "quote": "verbatim excerpt"},
    ...
  ],
  "memory_type": "user|feedback|project|reference",
  "proposed_filename": "snake_case_descriptor.md",
  "proposed_index_line": "- [Title](file.md) — one-line hook",
  "proposed_body": "<full memory body — for feedback/project, structure as: rule, **Why:** line, **How to apply:** line>",
  "confidence": 0.0-1.0,
  "dedupe_status": "NEW | OVERLAPS:<existing-file.md> | DUPLICATE:<existing-file.md>"
}

Confidence rubric:
  0.9+ — same lesson surfaced 4+ times across sources, no existing memory covers it
  0.8  — surfaced 3 times, no overlap
  0.6  — surfaced 2 times with high specificity, no overlap
  0.4  — surfaced 2 times but with weak evidence or partial overlap with existing memory
  <0.4 — single instance or near-duplicate of existing memory; suppress (do not output)

Dedupe rubric:
  NEW       — no existing memory addresses this pattern
  OVERLAPS  — existing memory addresses related but distinct aspect — propose UPDATE not new entry
  DUPLICATE — existing memory already covers this — suppress

DO NOT propose:
  - Code patterns derivable from current files (architecture, paths, conventions)
  - Git history facts derivable from `git log`
  - Debugging recipes whose fix is already in committed code
  - Transient state (in-progress work, current sprint context)
  - Anything Already documented in CLAUDE.md

Return ONLY the JSON array. No preamble, no commentary.
```

Capture the JSON. If the subagent returns malformed JSON, retry once with a stricter prompt. If still malformed, abort with the raw output written to `tmp/instinct-curator-malformed-{TIMESTAMP}.txt` for operator inspection.

## Phase 4: Dedupe verification (Opus pass)

Subagent in Phase 3 may have hallucinated overlaps or missed real ones. Spawn a second subagent (Opus this time) with just the candidate list and the existing memory corpus. Pass:

```
You are auditing dedupe judgments on memory candidates. For each candidate
below, the previous pass tagged it NEW, OVERLAPS, or DUPLICATE relative to
existing memories.

Verify each tag. Specifically check:
  - For NEW: scan all existing memories for substantive overlap. If found,
    re-tag as OVERLAPS:<file> or DUPLICATE:<file>.
  - For OVERLAPS:<file>: read the named existing memory; verify the candidate
    is meaningfully distinct (an update or a sibling lesson, not a restatement).
    If actually duplicate, re-tag DUPLICATE.
  - For DUPLICATE:<file>: confirm or downgrade.

Output as JSON array, same shape as input plus a "dedupe_verified" field
("CONFIRMED" or "REVISED" with the new tag).

Candidates:
<JSON from Phase 3>

Existing corpus:
<MEMORY.md + all memory files>
```

Apply revisions. Suppress every DUPLICATE candidate (don't even surface to operator). OVERLAPS candidates surface as "UPDATE" proposals against the named existing file.

## Phase 5: Render report

Sort surviving candidates by confidence descending. For each, render a block:

```
[★ {confidence}] {pattern_summary}
  Type: {memory_type}
  Proposed file: {proposed_filename}
  Status: {NEW | UPDATE existing-file.md}

  Evidence ({count} sources):
    1. {source} {ref}
       "{quote excerpt, max 200 chars}"
    2. {source} {ref}
       "{quote excerpt, max 200 chars}"
    ...

  Proposed index entry:
    {proposed_index_line}

  Proposed body:
    ────────────────
    {proposed_body, full content}
    ────────────────

  [a]ccept  [e]dit  [r]eject  [d]efer  [s]how-overlap (if UPDATE)
```

If `--write` is set AND confidence ≥ 0.85 AND status is NEW, the candidate is auto-accepted (write performed in Phase 6, no prompt). All other candidates require operator decision.

## Phase 6: Operator decision loop (skip if --write auto-accepted everything OR --no-decisions)

If `--no-decisions` was passed, skip this phase entirely — the candidates were rendered in Phase 5 as the report; that's the deliverable for this run. Continue to Phase 7 with zero writes pending. The next standalone curator invocation (without the flag) gives the operator a chance to act on what surfaced.

Otherwise, for each non-auto-accepted candidate, pause and capture {{OPERATOR}} response:

- **`a` accept** — write `<MEMORY_DIR>/<proposed_filename>` with the proposed body, append the index entry to MEMORY.md.
- **`e` edit** — open the proposed body in a code-fenced rendered block, ask for the edited version. Use that. Then write.
- **`r` reject** — discard. Write a one-liner to `tmp/instinct-curator-rejected-{TIMESTAMP}.txt` recording the rejection and the candidate summary, so future curator runs don't re-propose the same pattern. Future runs read this file and treat its entries as a "do not propose again" list (until the file is manually cleared).
- **`d` defer** — leave for next run. No action; pattern will resurface if signal persists.
- **`s` show-overlap** (UPDATE only) — display the existing memory file's body, then re-prompt with `a/e/r/d` for the merged version.

For UPDATE proposals: when accepted, instead of creating a new file, edit the existing file. Preserve the existing frontmatter; append or replace the body section per the proposed body's structure.

## Phase 7: Index hygiene

After all writes:

```bash
# Sort the MEMORY.md index entries within each section, alphabetically by title
# (sections themselves stay in original order — they're semantic, not alphabetical)
```

The index has section headers (`## Workflow rules`, `## Project state`, `## Reference`, `## Product model`, `## Diagnostic gotchas`, `## Key Architecture Patterns`, `## User Preferences`). Within each section, entries should be alphabetically sorted by title. Re-sort if any new entries were added. Do not reorder section headers.

Also enforce the 200-line cap on MEMORY.md (per the system instructions: "lines after 200 will be truncated"). If the index exceeds 200 lines, ask {{OPERATOR}} which low-confidence entries to consolidate or drop. Do not silently truncate.

## Phase 8: Summary

```
═══ SPRINT INSTINCT CURATOR — observation window {SINCE_DATE}..today ═══

Sources scanned:
  - {N} debriefs
  - {M} sprint manifests
  - {K} commits with lesson/fix framing
  - {J} needs-operator decisions
  - {L} existing memories (dedupe corpus)

Candidates surfaced: {C}
Auto-accepted (--write, ≥0.85): {A}
Operator-accepted: {OA}
Operator-edited: {OE}
Operator-rejected: {OR}
Operator-deferred: {OD}
Suppressed as duplicate: {S}

Memory writes:
  - {filename1} (NEW)
  - {filename2} (UPDATE — was named-existing-file)
  - ...
```

## Standing rules

- **Never silent-write.** Even with `--write`, only candidates ≥0.85 confidence get auto-written, and the report still surfaces them. The operator should never discover a memory file they didn't see proposed.
- **Pattern threshold is 2+ instances across distinct sources.** A single debrief mention is not a pattern; it's a one-time event. The whole point of memory is to capture signal that recurs.
- **Dedupe is conservative.** When in doubt about overlap, propose as UPDATE rather than NEW. Two memories saying the same thing is a worse failure mode than one combined memory.
- **Rejected candidates have a TTL.** The `tmp/instinct-curator-rejected-*.txt` file is consulted on the next run to avoid re-proposing rejected patterns. But it's `tmp/` (gitignored) and operator can clear it whenever — old rejections shouldn't suppress signals that resurface with new evidence.
- **No memory writes for ephemeral state.** If a pattern is "current sprint X is doing Y" — that's not a memory, that's sprint state. The CLAUDE.md guidance "What NOT to save" overrides candidate generation.
- **The curator does not write CLAUDE.md.** CLAUDE.md is hand-curated project doctrine; this skill writes only to the auto-memory directory. If a candidate genuinely belongs in CLAUDE.md (e.g., a permanent architectural rule), surface it as a recommendation in the report — operator decides.

**What just happened**
Scanned {N} debriefs, {M} manifests, and {K} commits in the last {DAYS} days. Surfaced {C} candidate patterns above the threshold (2+ instances across distinct sources, not duplicates of existing memories). Operator accepted {OA}, edited {OE}, rejected {OR}, deferred {OD}; auto-write applied to {A}.

**Where you are now**
Memory writes (if any) are committed to `~/.claude/projects/.../memory/` and indexed in MEMORY.md — they will be available in the next session. Rejections are logged in `tmp/instinct-curator-rejected-{TIMESTAMP}.txt` to suppress re-proposal until cleared.

**Your next step**
{If candidates were deferred: Re-run `/sprint-instinct-curator` after the next sprint cycle — deferred patterns may strengthen with more evidence and become higher-confidence candidates.} {If high-confidence candidates were accepted: Use them. Future planning sessions will see the new memories injected at session start.} {If 0 candidates surfaced: The pipeline is producing memories at saturation — either the patterns aren't recurring at threshold, or every recurring pattern is already memorialized. No action needed.}
