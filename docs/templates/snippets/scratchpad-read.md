## Phase 0.5: Read sprint scratchpad

Before any work, read the sprint manifest's scratchpad — a running notepad of cross-issue context captured during the sprint:

```bash
SPRINT_ID=$(ls docs/sprints/*.md 2>/dev/null | sort -r | head -1 | xargs -I {} basename {} .md)
if [ -n "$SPRINT_ID" ] && [ -f "docs/sprints/${SPRINT_ID}.md" ]; then
  awk '/^### Active/{flag=1; next} /^### Resolved/ || /^---$/ && flag {flag=0} flag' "docs/sprints/${SPRINT_ID}.md"
fi
```

**Read ONLY the `### Active` subsection.** The `### Resolved` subsection is archive — entries already actioned, kept for trail not for live consumption. Do not read or surface resolved entries.

Filter the active entries to those that apply right now:
- Lines mentioning the target issue (`#$1` if `$1` is set, or any issue in your in-flight cohort)
- Lines tagged `general:` (apply to every sprint run)
- Lines tagged `operator:` (free-form notes from the operator for downstream skills)

If any relevant entries are found, surface them at the top of your output:

```
SCRATCHPAD NOTES (active, relevant to this run):
- [date] · [from #M] — <note>
- [date] · general — <note>
```

If no relevant entries, proceed silently — do not announce "(scratchpad clean)" or similar.

**If your work resolves an active entry,** move that entry from `### Active` to `### Resolved` in the manifest, with a one-line resolution note:

```
- ~~2026-05-06 · #341 → affects #350: shipped flag X~~ → resolved 2026-05-07: implemented in #350 commit a3f7b2c
```

This is the lifecycle. Write to active when impact is discovered; move to resolved when impact is addressed. Without this, stale entries perpetuate alarm across many AI calls for an issue that's already fixed.

**Why this matters:** entries in the active section are how cross-issue impact propagates between parallel implementation sessions. A decision shipped on issue #341 that affects #350's plan will only reach the implementer of #350 if it was written here. Read before deciding; resolve once addressed.
