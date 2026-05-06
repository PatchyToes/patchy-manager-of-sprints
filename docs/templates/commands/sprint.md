---
description: Status oracle for the current sprint. Renders progress per module and lists available next actions. Never acts — pure read.
argument-hint: (none)
---

# Sprint Status

Execute the bash command below. Output its **entire stdout verbatim** to the user — no commentary, no summary, no introduction, no interpretation, no formatting changes. The script handles its own fencing (table portion is wrapped in a code fence so bars render in monospace; narrative below is plain markdown for bold headings). Do not add or remove fences.

```bash
node scripts/sprint.mjs
```

If the script exits non-zero, relay stderr verbatim and stop.

---

**Why this is a wrapper:** /sprint is mechanical — label-counting, bar rendering, and a deterministic recommendation chain. No reasoning required. The Node script in `scripts/sprint.mjs` runs in sub-second time with zero LLM tokens. Documentation for the state mapping, color logic, and largest-remainder rounding lives in the script's header comment so the docs travel with the implementation.

**Source of truth:** if /sprint behavior needs to change (new color, new state mapping, new recommendation rule, layout tweak), edit `scripts/sprint.mjs`, not this file.
