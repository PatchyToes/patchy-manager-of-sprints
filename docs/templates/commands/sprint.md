---
description: Status oracle for the current sprint. Renders progress per module + a brief strategic advisory on what to tackle next. Never acts — pure read.
argument-hint: (none)
---

# Sprint Status

## Step 1: Render the deterministic state

Execute the bash command below. Output its **entire stdout verbatim** to the user — no commentary, no summary, no introduction, no interpretation, no formatting changes. The script handles its own fencing (table portion is wrapped in a code fence so bars render in monospace; narrative below is plain markdown for bold headings). Do not add or remove fences.

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

**Don't repeat the script's bars or summary line.** The advisory is *additional* signal — strategic ordering, not a re-statement.

---

## Implementation notes

**Why a thin LLM layer:** /sprint was script-only by design (sub-second, tokenless). The advisory adds back ~200 tokens of operator-facing reasoning ONLY when state is ambiguous. The deterministic script does the heavy work; the LLM layer is the strategic glue.

**Source of truth for the table + recommendation chain:** `scripts/sprint.mjs`. If /sprint's bar/color/state-mapping behavior needs to change, edit the script, not this file.

**Source of truth for the advisory rules:** this file. Update the "When the advisory adds genuine value" section if new strategic ordering patterns emerge.
