---
description: Status oracle for the current sprint. Renders progress per module + a brief strategic advisory on what to tackle next. Never acts — pure read.
argument-hint: (none)
---

# Sprint Status

## Step 1: Render the deterministic state

Execute the bash command below via the Bash tool. **Then, in your assistant reply text, paste the script's complete stdout verbatim — every line, in order, exactly as the script emitted it.**

The Bash tool's UI widget collapses long output and is NOT what the user sees as the rendered chart. **Your reply text is the canonical render.** If you skip the paste, the user sees a truncated widget instead of the chart and bars. Paste it.

The script handles its own fencing (table portion is wrapped in a code fence so bars render in monospace; narrative below is plain markdown for bold headings). Do not add or remove fences. No commentary, no summary, no introduction, no interpretation around the paste.

```bash
node scripts/sprint.mjs
```

If the script exits non-zero, relay stderr verbatim and stop — do not continue to Step 2.

## Step 2: Add a brief strategic advisory

After the script output, append a short advisory paragraph that contextualizes the state and orders the next moves. The script's "Your next step" line is a deterministic single verb — fine for unambiguous states. The advisory's job is to handle the *ambiguous* states where multiple verbs are reasonable and ordering matters.

Format:

```

**Advisory**
[2-4 sentences on how to most efficiently tackle the rest of the sprint, given the current state.]
```

When the advisory adds genuine value:
- **Multiple ready + multiple needs-operator** → say which to walk through first and why (usually ready first to get them to greenlit + unblock the implementer; needs-operator second since they need more thought).
- **Mixed scoped + planning** → say whether to open another window for parallel planning, or wait for the in-flight plan to finish first (depends on how many are scoped — if 1-2, wait; if 5+, parallelize).
- **Multiple greenlit + needs-operator** → almost always implement first; greenlit work is fast, needs-operator wants attention.
- **Sprint-test items piling up** → recommend `/sprint-test` even if the script's deterministic verb is something else, because unverified shipped work blocks `/sprint-end`.
- **Local commits ahead of origin** → recommend `/sprint-ship` to get the batch deployed, after which the implementations become testable.

When the advisory should be brief or skipped:
- **Single dominant state** (e.g. 9 of 10 issues scoped, the rest terminal) → say "follow the script's recommendation" and stop. Don't pad.
- **Wait state** (everything in-flight, nothing actionable) → confirm the wait is intentional and note rough ETA if discernible. One sentence.
- **Sprint complete** → confirm `/sprint-end` is the right call. One sentence.

**The advisory is a SEPARATE block after the verbatim paste — different content, not a paraphrase.** The bars and summary line have already rendered (you pasted them in Step 1). The advisory's job is strategic ordering for ambiguous states, never a re-statement of what the bars said.

---

## Implementation notes

**Why a thin LLM layer:** /sprint was script-only by design (sub-second, tokenless). The advisory adds back ~200 tokens of operator-facing reasoning ONLY when state is ambiguous. The deterministic script does the heavy work; the LLM layer is the strategic glue.

**Source of truth for the table + recommendation chain:** `scripts/sprint.mjs`. If /sprint's bar/color/state-mapping behavior needs to change, edit the script, not this file.

**Source of truth for the advisory rules:** this file. Update the "When the advisory adds genuine value" section if new strategic ordering patterns emerge.

## Standing rules

- **Never acts — pure read.** This skill renders state and offers a strategic advisory. It does not edit labels, write comments, or modify any files. If a state mutation is needed, the advisory points to the verb that does it.
- **The Step-1 paste is mandatory; the Step-2 advisory is additive.** Always paste the script's full stdout verbatim in your reply text — that's the chart the user reads. The advisory comes AFTER as a separate block with different content (strategic ordering for ambiguous states), never a paraphrase of the bars or summary line.
- **Source of truth split.** Bar rendering / state mapping → `scripts/sprint.mjs`. Advisory framing → this file. Don't blur the line.
