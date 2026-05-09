---
description: Batch-deploy the current sprint's commits. Pushes local main to origin, runs `supabase functions deploy`, runs `supabase db push`. One push, one deploy, one migration cycle for the whole sprint. Pairs with `/sprint-test` for the post-deploy UAT sweep. (Requires: at least one sprint commit on local main, ahead of origin/main.)
argument-hint: (none)
---

# Sprint Ship

{{INCLUDE:glossary}}

You are the **Batch Deploy** for the active sprint. Sprint-implement sessions commit but do not push — this skill is the single moment in the sprint when local commits go live.

**Why this exists:** parallel sprint-implement windows pushing per-issue causes AI agents to trip on dirty git state (uncommitted files, mid-flight pushes, diverged remotes) and burn tokens investigating false alarms. Batching the push to once-per-sprint eliminates that contention. Also: one Vercel deploy, one functions deploy, one db push — cleaner deploy ordering, deterministic migration apply order.

## Phase A: Announce

```
═══ SPRINT · ship ═══
Pushing the sprint's commits as a batch. One push, one deploy, one migration cycle. This may take a few minutes depending on what's queued.
```

## Phase 0: Tool-availability gate (fail-closed)

```bash
gh auth status >/dev/null 2>&1 || { echo "Sprint ship abort: gh not authenticated."; exit 1; }
git rev-parse --git-dir >/dev/null 2>&1 || { echo "Sprint ship abort: not in a git repo."; exit 1; }
command -v supabase >/dev/null 2>&1 || { echo "Sprint ship abort: supabase CLI not in PATH."; exit 1; }
```

## Phase 1: Pre-flight checks (fail-closed, no-op if nothing to ship)

### 1A. Detect commits to push

```bash
git fetch origin main
AHEAD=$(git rev-list --count origin/main..HEAD)
```

If `AHEAD == 0`: print `Sprint ship: nothing to push — local main is already in sync with origin/main. Run /sprint-implement first.` and exit 0. **No-op is a valid outcome.**

### 1B. Detect uncommitted changes

```bash
[ -z "$(git status --porcelain)" ] || { echo "Sprint ship abort: working tree is dirty. Commit or stash before /sprint-ship — partial commits cause unclear deploy state."; git status --short; exit 1; }
```

### 1C. Verify on main

```bash
BRANCH=$(git branch --show-current)
[ "$BRANCH" = "main" ] || { echo "Sprint ship abort: not on main (current: $BRANCH). This codebase ships from main directly."; exit 1; }
```

### 1D. Surface what's about to ship

```bash
echo "About to ship $AHEAD commit(s) to origin/main:"
git log --oneline origin/main..HEAD
echo ""
echo "Issues that will auto-close on push (from Closes #N keywords):"
git log origin/main..HEAD --pretty=format:"%B" | grep -oE "(Closes|Fixes|Resolves) #[0-9]+" | sort -u
```

This is informational — surfacing what's queued so a glance confirms the batch matches operator expectation. No prompt, no wait.

## Phase 2: Detect deploy footprint

```bash
CHANGED=$(git diff --name-only origin/main..HEAD)
HAS_FUNCTIONS=$(echo "$CHANGED" | grep -c '^supabase/functions/' || true)
HAS_MIGRATIONS=$(echo "$CHANGED" | grep -c '^supabase/migrations/' || true)
HAS_FRONTEND=$(echo "$CHANGED" | grep -cE '^(src/|public/|index\.html|package\.json|vite\.config|tsconfig)' || true)

echo "Deploy footprint:"
[ "$HAS_FRONTEND" -gt 0 ] && echo "  - Frontend: $HAS_FRONTEND file(s) — Vercel will auto-deploy on push"
[ "$HAS_FUNCTIONS" -gt 0 ] && echo "  - Edge functions: changes detected, will run \`supabase functions deploy\`"
[ "$HAS_MIGRATIONS" -gt 0 ] && echo "  - DB migrations: changes detected, will run \`supabase db push\`"
[ "$HAS_FUNCTIONS" -eq 0 ] && [ "$HAS_MIGRATIONS" -eq 0 ] && [ "$HAS_FRONTEND" -eq 0 ] && echo "  - No deploy-touching files (commits are docs/scripts/etc.)"
```

This drives Phase 4. Functions and migrations get explicit deploy commands; frontend rides the push.

## Phase 3: Push to origin/main

```bash
git push origin main
```

If push fails (rejected, network, etc.): abort with `Sprint ship abort: push failed. Resolve the underlying issue and re-run /sprint-ship.` and stop. Do not proceed to functions/db deploy — those would be applied without the corresponding code on origin.

GitHub auto-closes every issue with `Closes #N` in a pushed commit's body. The sprint progress bar updates accordingly.

## Phase 4: Deploy edge functions (if any changed)

```bash
if [ "$HAS_FUNCTIONS" -gt 0 ]; then
  supabase functions deploy
fi
```

`supabase functions deploy` (no arg) deploys all functions. This is the recommended pattern per CLAUDE.md — the cost of redeploying unchanged functions is small; the cost of forgetting one is real.

## Phase 5: Apply DB migrations (if any pending)

```bash
if [ "$HAS_MIGRATIONS" -gt 0 ]; then
  supabase db push --dry-run
  supabase db push
fi
```

The dry-run prints the SQL that's about to apply — surfaced for the record. Then the actual push. Migrations apply in filename order (Supabase CLI handles this).

If dry-run shows unexpected SQL or db push errors: stop immediately and print the error verbatim. The migration is partially applied at that point and needs operator review.

## Phase 6: Final summary

```bash
node scripts/sprint.mjs
```

Print verbatim. The /sprint output reflects the post-push state — issues that just auto-closed will show as shipped (green); the bars reflect the real-time post-deploy reality.

After the script output, append:

```
**What just happened**
Pushed N commits to origin/main. Vercel deploying frontend; supabase functions and migrations applied. GitHub auto-closed K issues from `Closes #N` keywords in the commits.

**Where you are now**
The sprint is on production. Tests haven't run yet — the implementations are deployed but not verified.

**Your next step**
`/sprint-test` — walk the sprint manifest's `## Test plan` section as a consolidated UAT checklist. Failures get reopened with `needs-fix`; passes stay closed.
```

## Standing rules

- **Single push, no per-issue retries.** If the push fails, fix the underlying cause (rebase onto origin if needed, resolve conflicts, retry network) and re-run /sprint-ship. Don't try to push individual commits.
- **No partial deploys.** If migrations fail mid-apply, that's an operator-investigation moment — do not "skip the broken one and continue." Stop, surface the error, let the operator decide.
- **No automatic test invocation.** /sprint-ship doesn't run /sprint-test for you. The test sweep is a separate operator-attention slot — bundling them would chain a long-running interactive walk onto a fast deploy operation.
- **Idempotent on no-op.** Running /sprint-ship when there's nothing to push is fine — it prints the "nothing to ship" message and exits 0. Use it as a sanity check anytime.
- **Failure recovery is git-native.** If the push lands but functions deploy fails, the commits are on origin (issues auto-closed) but functions are stale. Re-run `supabase functions deploy` directly — the next /sprint-ship would no-op on push because there's nothing new. This is fine; the contract is "deploy what's queued," not "atomic across all three."
