---
description: Probe a deployed URL for HTTP/content/module-script regressions. Server-side only — no Playwright. Auto-runs after `/sprint-ship` Phase 5.5; usable standalone for ad-hoc checks. Catches the chunk-load-fail signature (module-script reference returning Content-Type text/html) and landing-page regressions (HTTP 5xx, missing required content, failure markers).
argument-hint: [<url>]
---

# Canary Watch (v1)

{{INCLUDE:glossary}}

**Session model:** Haiku — thin wrapper around `scripts/canary-watch.mjs`. Reads JSON, renders a friendly report. No reasoning, no tool dispatch.

**What this skill does.** Runs the canonical canary script against a URL (arg or `.claude/canary-watch.json`), reads the resulting `tmp/canary-watch-latest.json`, and renders a fresh markdown report inline. The script is the source of truth — this skill is the operator-facing surface.

**What this skill is NOT.** It is not a runtime guard. It does not block deploys, doesn't open issues, doesn't modify state. It reports verdict + findings for a single point-in-time probe. Sustained watch, perf metrics, and console-error tracking are deliberately out of scope.

Optional `$1`:
- `<url>` — probe this URL instead of the configured one. Useful for ad-hoc one-off checks against staging, branch deploys, etc.

If neither `$1` nor `.claude/canary-watch.json` is set, the underlying script exits with verdict ERROR and the skill surfaces the error.

## Phase A: Announce

Before any tool calls, print this preamble exactly (with a trailing blank line). Plain text — do not wrap in code fences or add Markdown.

```
═══ CANARY · watch ═══
Probing the deployed URL for HTTP/content/module-script regressions. Server-side only.
```

## Phase 0: Tool-availability gate (fail-closed)

```bash
command -v node >/dev/null 2>&1 || { echo "Canary watch abort: node not in PATH."; exit 1; }
[ -f scripts/canary-watch.mjs ] || { echo "Canary watch abort: scripts/canary-watch.mjs not found — run from repo root."; exit 1; }
[ -n "$1" ] || [ -f .claude/canary-watch.json ] || { echo "Canary watch abort: pass a URL as \$1, or create .claude/canary-watch.json (see .claude/canary-watch.example.md)."; exit 1; }
```

## Phase 1: Run the canary script

```bash
node scripts/canary-watch.mjs $1 >/dev/null 2>&1 || true
```

The script's exit code is informational (0=HEALTHY/WARNING, 1=CRITICAL, 2=ERROR). Don't gate this skill on it — operator should still see the rendered report regardless. The script always writes `tmp/canary-watch-latest.json` (even on internal exception), which is the source of truth for Phase 2.

## Phase 2: Render report from the latest JSON

Read `tmp/canary-watch-latest.json` directly via `node -p`:

```bash
[ -f tmp/canary-watch-latest.json ] || { echo "Canary watch: script produced no JSON output. Investigate scripts/canary-watch.mjs failure."; exit 2; }
node -p "JSON.stringify(require('./tmp/canary-watch-latest.json'), null, 2)" > /dev/null  # parse sanity check
```

Then render the markdown table inline, parsing each field from the JSON (do NOT echo the on-disk timestamped `tmp/canary-watch-{ISO}.md` — that's an archival artifact; the live render is what the operator reads now).

Output template:

```
═══ CANARY REPORT — {url} — {today's ISO timestamp} ═══

Status: {HEALTHY ✓ | WARNING ⚠ | CRITICAL ✗ | ERROR}

| Check | Result | Threshold |
|---|---|---|
| HTTP status | {http_status or "n/a" if null} | == 200 |
| Response time | {response_time_ms or "n/a"}ms | < {warning_response_time_ms from config, or 2000 default}ms |
| Required content | {checks.required_present[0]}/{checks.required_present[1]} | all present |
| Failure markers | {checks.failure_markers_found.length} | == 0 |
| Module-script Content-Type | {checks.module_scripts_found - checks.module_scripts_html_typed}/{checks.module_scripts_found} | all application/javascript |

{If verdict in [WARNING, CRITICAL, ERROR] and findings.length > 0:}
## Findings
{For each finding in findings array: "- {finding}"}
{If error field is non-null: "- error: {error}"}
```

## Phase 3: Three-anchor close

Standard sprint-system anchoring contract:

```
**What just happened**
Probed {url}. Verdict: {verdict}. {If HEALTHY: "All checks passed."}{If WARNING: "Surfaced {findings.length} issue(s) — site responded but slow or marginal."}{If CRITICAL: "Surfaced {findings.length} issue(s) — site is broken or returning unexpected content."}{If ERROR: "Canary script could not complete the probe — see error above."}

**Where you are now**
{If HEALTHY: "Site looks healthy at probe time. Cache propagation race caveat: HEALTHY means the URL responded clean now, not necessarily that the most recent deploy is fully live."}
{If WARNING: "Site responded but exceeded a non-blocking threshold (typically slow response). Worth a glance; not an emergency."}
{If CRITICAL: "Site is broken at probe time. Findings above describe the failure mode. Typical causes: chunk-rewrite (missing /assets/X.js redirected to index.html as text/html), application error page, missing required content."}
{If ERROR: "Canary itself failed to run cleanly. Could be a network issue from the dev machine, a script bug, or a missing config. Check tmp/canary-watch-latest.json for the error field."}

**Your next step**
{If HEALTHY: "Continue with whatever you were doing — site is up. /sprint-test if this ran post-/sprint-ship."}
{If WARNING: "Re-run /canary-watch in a minute or two — if WARNING persists, investigate; if it clears, was a transient blip."}
{If CRITICAL: "Investigate the findings before /sprint-test. If chunk-rewrite, check the most recent Vercel deploy and the /assets/ asset list. If application-error, check Vercel build logs. Roll back if user-facing."}
{If ERROR: "Run scripts/canary-watch.mjs directly to see the raw error. If config-related, see .claude/canary-watch.example.md."}
```

## Standing rules

- **Read-only against the URL.** No POST, no auth-gated routes, no destructive probes. The canary fetches `/` (or whichever URL is configured) and the module scripts referenced in its body. That's it.
- **Verdict source-of-truth is `tmp/canary-watch-latest.json`.** The script writes; this skill and `/sprint-ship` Phase 5.5 both read. Never compute the verdict in the skill — always defer to the script.
- **Cache propagation race.** HEALTHY means "something is up at this URL" right now. It does NOT mean "the most recent deploy is fully live in every edge cache." A canary firing seconds after `git push` may still be probing the previous bundle.
- **Failures don't roll back deploys.** This skill surfaces findings; the operator decides what to do. If a CRITICAL surfaces post-`/sprint-ship`, the operator may revert the commit, deploy a fix, or accept the findings as a known issue.
- **The script is the canonical workhorse.** This skill exists so the operator gets a friendly rendered report. If you find yourself wanting to add probe logic to the skill, add it to `scripts/canary-watch.mjs` instead — that's where probe behavior lives.
