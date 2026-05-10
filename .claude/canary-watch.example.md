# Canary Watch — Configuration

Copy this file to `.claude/canary-watch.json` and edit the values for your repo.

The canary script (`scripts/canary-watch.mjs`) reads this config when invoked without a URL arg, and `/sprint-ship` Phase 5.5 reads it to decide whether to run the post-deploy probe at all (no config → canary skipped).

## Schema

| Key | Type | Default | Purpose |
|---|---|---|---|
| `url` | string (required) | — | Public origin URL of the deployed app |
| `required_content` | string[] | `["<!DOCTYPE html", "<title>", "<div id=\"root\""]` | Substrings that must appear in the response body. Missing any = CRITICAL. |
| `failure_markers` | string[] | `["Application error", "<title>404", "Cannot connect"]` | Substrings that, if present, indicate a broken deploy. Any present = CRITICAL. |
| `warning_response_time_ms` | number | `2000` | Response time threshold for WARNING tier (ms) |
| `module_script_check` | boolean | `true` | If true, fetch every `<script type="module">` asset and assert its Content-Type starts with `application/javascript`. Catches the SPA-rewrite-to-index.html signature ("chunk-load-fail"). |

## Example

Minimal valid config:

```json
{
  "url": "https://YOUR-DOMAIN.example",
  "required_content": ["<!DOCTYPE html", "<title>"],
  "failure_markers": ["Application error", "<title>404"],
  "warning_response_time_ms": 2000,
  "module_script_check": true
}
```

## Tuning required_content

Run the canary once after configuring `url`:

```bash
node scripts/canary-watch.mjs
```

If verdict is CRITICAL with `missing required content: <X>`, the substring isn't actually in your homepage. Check what your site emits with `curl -sS <your-url> | head -5` and adjust `required_content` to match. For example, Vite-built SPAs typically emit lowercase `<!doctype html>` not uppercase `<!DOCTYPE html>`.

## Tuning failure_markers

Defaults catch most generic SaaS error pages. Add framework-specific markers if your app has known error states (e.g., `<h1>Server Error`, `<title>Maintenance`).

## Disabling module-script check

If your site doesn't ship as an SPA with module scripts (server-rendered, no `<script type="module">` tags), set `module_script_check: false` to skip steps E + F entirely. Otherwise the canary will report `module_scripts_found: 0` but still pass — the check just becomes a no-op.

## Notes

- The script defensively skips any config key starting with `_` — useful if you copy an annotated example and forget to strip comment-style keys.
- This config is per-repo. The canonical distribution repo (this one) ships without `.claude/canary-watch.json` so first-install operators set their own URL.
- Don't commit secrets here — the canary is unauthenticated. If you need to probe an auth-gated route, that's out of scope for v1.
