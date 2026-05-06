---
description: Inject a context block into a GitHub issue body — module assignment, stakes, lessons, operating principles, staleness probe, dependencies, related issues. Mechanical lookups, no verdicts. Companion to the three-round planner.
argument-hint: <issue_number> [--force | --strip]
---

# GIC — Issue Prep Agent (v1)

{{INCLUDE:glossary}}

You run on GitHub issue #$1.

Optional flags from $2: `--force` (always re-run, replace existing block) | `--strip` (remove the GIC block, no other work).

## Who reads your output

The block you write into the issue body is read by:
- **{{OPERATOR}}** scanning the backlog (he sees a heading + structured sections in the GitHub UI)
- **The planner** when dispatched on this issue — Phase 1 step 1 reads the body, so the GIC block enters its context for free
- **Future GIC re-runs** — block markers anchor idempotent replacement

Block content is **mechanical lookups, not synthesis or verdicts**. Every section is either copied from an IK file or computed by `git`/`gh`. If you find yourself drafting prose, stop — that's out of scope.

## Standing rules

- **No synthesis, no verdicts.** Don't classify the issue (stale, ready, etc.). Don't draft acceptance criteria. Don't summarize the issue's content. The block is a mechanical context dump, full stop.
- **Issue body is preserved byte-for-byte outside the GIC block.** The original title, body prose, comments, other markdown — untouched. Only the GIC-marker-delimited region is rewritten.
- **Fail soft on missing IK files.** If `docs/modules.md`, `docs/stakes-index.md`, `docs/lessons-by-surface.md`, or `docs/operating-principles.md` doesn't exist, skip that injection and note in the footer. Never abort.
- **Fail closed on missing tools.** If `gh`, `git`, or auth isn't available, abort before mutating the issue.
- **Commit or escalate. No hedges.** No "potentially stale," no "possibly relevant." Each lookup either has a result or it doesn't.

## Phase 0: Tool-availability gate (fail-closed)

Before reading the issue, verify:

```bash
gh auth status >/dev/null 2>&1 || { echo "GIC abort: gh not authenticated. Run 'gh auth login'."; exit 1; }
gh repo view --json name >/dev/null 2>&1 || { echo "GIC abort: gh cannot reach current repo."; exit 1; }
git --version >/dev/null 2>&1 || { echo "GIC abort: git not in PATH."; exit 1; }
```

If any check fails, stop. Do not call `gh issue edit` later.

## Phase A: Read issue + sanity check

```bash
gh issue view "$1" --json number,title,body,state,labels,closedAt
```

Apply skip rules in order:

1. **Closed issue:** `state == "closed"` → print `GIC skip: issue #$1 is closed.` and exit 0.
2. **Tracking label:** `labels[*].name` contains `tracking` → print `GIC skip: tracking issue, not a unit of work.` and exit 0.
3. **--strip flag:** jump to **Strip mode** below. Skip all other phases.
4. **Existing block + TTL check:** see Phase A.1.

### Phase A.1: Conditional TTL skip

If the issue body contains `<!-- GIC-START YYYY-MM-DD -->`:

a. Parse the date from the marker.
b. Extract all paths cited under the existing block's `**Staleness probe:**` section (regex match on lines starting with `- `).
c. For each cited path, run `git log --since=<block-date> --oneline -- <path>`. If ANY path has activity since the block date → **force re-run** (proceed to Phase B), regardless of TTL.
d. Otherwise: if `<today> - <block-date> < 7 days` AND `--force` not passed → print `GIC skip: block dated <date>, <N> days old, no cited-path activity since. Re-run with --force to refresh.` and exit 0.
e. Else proceed to Phase B (TTL expired or --force).

If no `<!-- GIC-START -->` marker found, this is a first run — proceed to Phase B.

## Phase B: Path extraction

Operate on the issue body text from Phase A.

1. **Strip TRIPLE-BACKTICK fenced code blocks only** — paths inside `` ``` ... ``` `` are example output, not citations. Strip these. **Do NOT strip single-backtick inline code** — issues routinely cite paths inline as `` `src/foo.ts` ``, and the path char class below already excludes backticks so the citation extracts cleanly without needing the strip.
   ```
   FENCED_RE = /```[\s\S]*?```/g
   ```

2. **Run path regex on the stripped body:**
   ```
   PATH_RE = /(?:^|[\s\(\[`])((?:{{PATH_PREFIXES}})\/[^\s\)\]`#:,]+)(?::(\d+(?:[-,\s]+\d+)*))?/g
   ```
   - Group 1 = path. Char class excludes whitespace, closing `)`/`]`, backtick, `#` (URL fragment), `:` and `,` (so the line-anchor group can take over).
   - Group 2 (optional) = one or more line numbers separated by `-`, `,`, or whitespace. Examples that match: `:30`, `:30-53`, `:765, 1196`, `:10, 20-30, 40`.

3. **Run markdown-link regex on the un-stripped body:**
   ```
   LINK_RE = /\[[^\]]+\]\(((?:{{PATH_PREFIXES}})\/[^)#:]+)/g
   ```
   Captures path-shaped link targets inside `[text](path)`. Excludes URL fragments (`#L30-L53`) and trailing line anchors so canonical paths stay clean.

4. **Normalize each captured path:** strip trailing punctuation (`.`, `,`, `;`, `:`). Strip trailing whitespace. Normalize line-anchor capture: remove whitespace, strip trailing punctuation.

5. **Dedup case-sensitive by normalized path.** Aggregate line-anchor lists per path (a path may appear once with `:30-53` and again as a markdown-link target with no anchor — same path, line list = `["30-53"]`).

If the result is empty, set `cited_paths = []` and continue. Phase C will fall back to keyword-match.

## Phase C: Module assignment (multi-membership)

For each path in `cited_paths`:

1. Read `docs/modules.md`. For each `## <Module Name>` section, look at its **Primary code:** line (markdown-link list).
2. Compute "matches": this module owns the path if EITHER the path itself OR any ancestor directory of the path appears in that module's Primary code list. (Note: the module map lists both files and directories; an ancestor-dir match catches files within a listed directory.)
3. Record ALL matching modules — paths can have multiple owners (e.g., `src/contexts/UndoRedoContext.tsx` is in both **Unified Data View** AND **App Shell**).

Roll up:
- `module_set` = unique set of modules across all paths
- For each module in `module_set`, copy its **Touches:** line verbatim from modules.md (cross-module dependency hints)

**Fallback (no cited paths):**
- Take issue title + body, lowercase.
- For each module name in modules.md (e.g., "Module A", "Multi Word Module"), check substring presence in the lowercased title+body.
- If matches: that's the module set. If no matches: `module_set = []`, mark "module: unclear" in the rendered block.

## Phase D: Stakes block

For each path in `cited_paths` AND each module name in `module_set`, grep `docs/stakes-index.md` for a section heading that matches the path or module. Stakes-index sections are H2 headings keyed to specific surfaces (e.g., `## api/checkout/`, `## src/components/dashboard/`).

For each matching section, copy verbatim:
- **Deploy when changed:**
- **Security or RLS sensitive:**
- **Blast radius:**
- **Verification:**

Skip Past incidents and Source lines (those are reference, not actionable for the planner). Dedup if the same section matches multiple paths.

## Phase E: Lessons inline

For each path AND each module in `module_set`, grep `docs/lessons-by-surface.md` for a matching H2 heading. Lessons-by-surface sections are keyed to file/directory/pattern (e.g., `## api/checkout/`, `## DB queries / ORM`, `## Planning / protocol workflow`).

Copy each matching section's lessons verbatim (the `- **Lesson:** ...` bullets). Dedup across module/path overlap.

## Phase F: Operating principles (keyword-substring scan)

Read `docs/operating-principles.md`. For each H3 heading section:

1. Concatenate the heading text + the entire section body.
2. Lowercase. Compute substring matches against the union of:
   - Module names from `module_set` (lowercased)
   - Issue label names (lowercased)
   - Top-level path fragments from `cited_paths` (e.g., from `api/checkout/stripe.ts`, the fragments `api`, `checkout`, `stripe`)
3. If ANY substring appears in the section → include the principle.
4. Dedup principles across multi-module hits — each principle appears at most once.

For each included principle: emit the H3 heading + the **Rule:** paragraph (or first paragraph if no Rule label). Skip subsequent paragraphs to keep the block compact.

If `module_set` is empty AND no labels AND no path fragments → no principles match. That's fine; emit `(no principles matched the issue's surface)`.

## Phase G: Staleness probe

For each (path, line_anchors) in `cited_paths`:

### G.1 Path existence
```bash
[ -e <path> ] || echo "HARD-staleness — file deleted or moved"
```
If file doesn't exist → record `HARD-staleness — path no longer exists`. Stop further probes for this path.

### G.2 Recent activity
```bash
git log --since='14 days ago' --oneline -- <path> | wc -l
```
- 0 → `clean (no recent activity)`
- N > 0 → `soft-staleness — N commits in last 14 days`

### G.3 Line-anchor verification
If `line_anchors` is non-empty:
```bash
total_lines=$(wc -l < <path>)
max_anchor=$(max of line_anchors)
```
- `max_anchor > total_lines` → `HARD-staleness — line ${max_anchor} out of range (file has ${total_lines} lines)`
- Else → `line anchor ${anchors} present; content not semantically verified`

### G.4 Symbol citation
If the issue body cites a quoted function/symbol name within ~80 chars of the path (heuristic: scan for backtick-quoted identifiers near each path occurrence), run **presence-grep**:
```bash
grep -n "<symbol>" <path>     # check inside the cited path
grep -rn "<symbol>" $(echo "{{PATH_PREFIXES}}" | tr '|' ' ')   # check repo-wide if not found in path
```
- Found in cited path → `clean`
- Found elsewhere only → `soft-staleness — symbol moved to <other_path>`
- Not found anywhere → `HARD-staleness — symbol not found in repo`

**Do not** check line-equality of cited line content against current main. Line numbers drift without semantic change.

## Phase H: Dependencies probe

1. **Cache the label list** once:
   ```bash
   gh label list --limit 100 --json name --jq '.[].name'
   ```
2. **For each module in `module_set`**, derive a probable label name (lowercase, hyphenated — `Module A` → `module-a`, `Multi Word Module` → `multi-word-module` — try variants, prefer existing).
   - If label exists: `gh issue list --state open --label <label> --limit 5 --json number,title,state,labels`
   - If label does not exist: emit `(label "<probable_name>" not present in repo — query skipped)` for the footer
3. **Title-keyword search (always runs):** extract 2–3 most significant nouns from issue title (skip stopwords, skip generic words like "fix", "add"). Run:
   ```bash
   gh issue list --state open --search "<keywords>" --limit 8 --json number,title,labels
   ```
4. Dedup results from steps 2 and 3 (by issue number). Cap at 8 entries total.

## Phase I: Related issues (same neighborhood)

Distinct from Phase H. For each unique top-level path-fragment in `cited_paths` (e.g., `api/checkout`, `src/components/dashboard`), run:
```bash
gh issue list --search "<path-fragment>" --json number,title,state,createdAt,closedAt --limit 10
```

Filter to issues created OR closed within the last 30 days. Dedup against Phase H's results. Cap at 6 entries.

If `cited_paths` is empty, skip this phase.

## Phase J: Format & write

### Block format

```markdown
<!-- GIC-START YYYY-MM-DD -->
## Context (GIC, YYYY-MM-DD)

**Modules:** [comma-list of modules, with "(Touches: X, Y, Z)" rolled up per module]
*If module_set empty:* `module: unclear`

**Stakes:**
- [verbatim Deploy/RLS/Blast/Verification bullets from stakes-index.md]
*If empty:* `(no stakes notes for cited surfaces)`

**Lessons:**
- [verbatim lesson bullets from lessons-by-surface.md]
*If empty:* `(no lessons matched cited surfaces)`

**Operating principles:**
- [H3 heading — Rule paragraph]
*If empty:* `(no principles matched the issue's surface)`

**Staleness probe:**
- `<path>` — [classification + details]
*If cited_paths empty:* `(no paths cited in issue body)`

**Dependencies:**
- #N (state, labels) — title
*If empty:* `(no related open issues found)`

**Related issues (same neighborhood, last 30 days):**
- #N (state) — title
*If cited_paths empty:* `(skipped — no cited paths)`

---
*GIC ran YYYY-MM-DD. Re-run with `/enrich-issue <n> --force` to refresh.*
*If a planner runs after this block, planner re-derivation supersedes — block is a snapshot, not authoritative.*
[Footer notes about missing IK files, missing labels, truncations, etc., one per line]
<!-- GIC-END -->
```

The HTML comment markers are invisible in GitHub-rendered markdown. {{OPERATOR}} sees only the `## Context (GIC, ...)` heading and the structured content.

### Body-size pre-check

Before calling `gh issue edit`, compute the predicted full body length (existing body with old block stripped + new block). If > 60,000 characters:

1. Truncate `**Related issues**` first (drop oldest entries until under limit). Add footer note: `**Truncated:** Related issues — N dropped to fit body size.`
2. If still over, truncate `**Dependencies**` non-essentials (drop entries past the first 3). Add footer note.
3. If still over after both, do NOT call `gh issue edit`. Write the full block to `tmp/gic-fallback-<n>-<date>.md`, print `GIC abort: predicted body exceeds 60K chars even after truncation. Block written to <path>.`, exit non-zero.

### Block replacement

Find the existing block via regex on the issue body:
```
<!-- GIC-START [^>]*-->[\s\S]*?<!-- GIC-END -->
```
Replace the matched region with the new block. If no match → append the new block at the end of the body, preceded by a blank line.

### Write

```bash
echo "<new_body>" > tmp/issue-<n>-body.txt
gh issue edit "$1" --body-file tmp/issue-<n>-body.txt
```

Retry once on transient failure (network, rate-limit). On persistent failure (auth, permissions, body-size): write the new block to `tmp/gic-fallback-<n>-<date>.md`, print the failure cause and fallback path, exit non-zero.

On success, print a one-line summary to stdout:
```
GIC wrote block to issue #N — modules: M1, M2; stakes: K bullets; lessons: K bullets; principles: K; paths probed: K (clean/soft/HARD: a/b/c).
```

## Phase K: IK fail-soft

If a required IK file is missing at any point:
- `docs/modules.md` missing → skip Phase C and downstream module-keyed lookups (D, E, F, H label-derivation). Add footer note: `**Skipped:** modules.md not found.`
- `docs/stakes-index.md` missing → Phase D emits `(stakes-index.md not found)`. Footer note.
- `docs/lessons-by-surface.md` missing → Phase E emits `(lessons-by-surface.md not found)`. Footer note.
- `docs/operating-principles.md` missing → Phase F emits `(operating-principles.md not found)`. Footer note.

**All four IK files missing:** still write the block. All seven sections render their empty fallback. The block has signal value (proves GIC ran) and the footer enumerates missing files. Do not skip the write.

## Strip mode (`--strip`)

If `--strip` flag is passed, after Phase A:

1. Read the issue body.
2. Regex-match `<!-- GIC-START [^>]*-->[\s\S]*?<!-- GIC-END -->`.
3. If no match: print `GIC strip: no block found on issue #$1.` and exit 0.
4. If match: remove the matched region (and the leading blank line if present).
5. `gh issue edit "$1" --body-file <stripped-body-file>`.
6. On success: print `GIC stripped block from issue #$1 (was dated <date>).`

Strip mode does not run Phases B–K. It's an inverse-of-write only.

## Output guarantees

- Original issue body preserved byte-for-byte outside the GIC-marker region.
- Title, comments, labels (other than what Phase H/I read) untouched.
- Stdout summary line on every successful run.
- Non-zero exit code on any abort or failure.

## When to update this skill

Add a new injection only when:
- The data exists as a structured IK file (file-keyed lookup, no synthesis)
- The cost of NOT having it written into issue bodies is concrete
- Mechanical computation suffices (no Claude calls, no judgment)

If a proposed injection requires LLM synthesis or a judgment call, it does NOT belong in v1 — file as GIC v2 candidate instead.
