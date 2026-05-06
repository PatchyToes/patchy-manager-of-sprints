## Phase 0.5: Read sprint scratchpad

Before any work, read the sprint manifest's scratchpad to absorb cross-issue context captured during the sprint:

```bash
SPRINT_ID=$(ls docs/sprints/*.md 2>/dev/null | sort -r | head -1 | xargs -I {} basename {} .md)
if [ -n "$SPRINT_ID" ] && [ -f "docs/sprints/${SPRINT_ID}.md" ]; then
  awk '/^## Sprint scratchpad/{flag=1; next} /^---$/ && flag {flag=0} flag' "docs/sprints/${SPRINT_ID}.md"
fi
```

Filter the scratchpad entries to those that apply right now:
- Lines mentioning the target issue (`#$1` if `$1` is set, or any issue in your in-flight cohort)
- Lines tagged `general:` (apply to every sprint run)
- Lines tagged `operator:` (free-form notes from the operator for downstream skills)

If any relevant entries are found, surface them at the top of your output as:

```
SCRATCHPAD NOTES (relevant to this run):
- [date] · [from #M] — <note>
- [date] · general — <note>
```

If no relevant entries, proceed silently — do not announce "(scratchpad clean)" or similar.

**Why this matters:** entries here are how cross-issue impact propagates between parallel implementation sessions. A decision shipped on issue #341 that affects #350's plan will only reach the implementer of #350 if it was written here. Read before deciding.
