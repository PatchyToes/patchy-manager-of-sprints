#!/usr/bin/env node
// Post-deploy URL canary. Server-side only.
// Requires Node 18+ (built-in fetch).
//
// Usage:
//   node scripts/canary-watch.mjs <url>          // explicit URL arg
//   node scripts/canary-watch.mjs                // reads .claude/canary-watch.json
//
// Always emits JSON to stdout. Exit codes:
//   0 → HEALTHY or WARNING
//   1 → CRITICAL
//   2 → ERROR (config missing, internal exception)
//
// Side effects:
//   tmp/canary-watch-{ISO}.md           (timestamped human-readable report)
//   tmp/canary-watch-latest.json        (overwritten — for cheap downstream consumption)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const CONFIG_PATH = resolve(REPO_ROOT, '.claude/canary-watch.json');
const TMP_DIR = resolve(REPO_ROOT, 'tmp');
const LATEST_JSON = resolve(TMP_DIR, 'canary-watch-latest.json');

const DEFAULTS = {
  required_content: ['<!DOCTYPE html', '<title>', '<div id="root"'],
  failure_markers: ['Application error', '<title>404', 'Cannot connect'],
  warning_response_time_ms: 2000,
  module_script_check: true,
};

const MAX_RETRIES = 3;
const RETRY_GAP_MS = 5000;
const REQ_TIMEOUT_MS = 10000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadConfig() {
  const argUrl = process.argv[2];
  let cfg = { ...DEFAULTS };

  if (existsSync(CONFIG_PATH)) {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    // Defensive: skip any key starting with "_" (e.g., from an annotated example)
    for (const [k, v] of Object.entries(raw)) {
      if (!k.startsWith('_')) cfg[k] = v;
    }
  }

  if (argUrl) cfg.url = argUrl;
  return cfg;
}

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function extractModuleScripts(body) {
  const tags = body.match(/<script[^>]*>/gi) || [];
  return tags
    .filter((t) => /type=["']module["']/i.test(t))
    .map((t) => (t.match(/src=["']([^"']+)["']/i) || [])[1])
    .filter(Boolean);
}

async function checkModuleScript(scriptUrl, pageUrl) {
  // Resolve relative
  const resolved = new URL(scriptUrl, pageUrl).href;

  // Try HEAD first (cheaper); fall back to GET on 405 or other failure
  let res;
  try {
    res = await fetchWithTimeout(resolved, { method: 'HEAD' });
    if (res.status === 405 || res.status >= 500) {
      res = await fetchWithTimeout(resolved, { method: 'GET' });
    }
  } catch {
    res = await fetchWithTimeout(resolved, { method: 'GET' });
  }

  const ct = res.headers.get('content-type') || '';
  const isJs = /^(application|text)\/javascript/i.test(ct);
  return { url: resolved, contentType: ct, isJs, status: res.status };
}

async function probeOnce(cfg) {
  const startedAt = Date.now();
  const findings = [];
  const checks = {
    required_present: [0, cfg.required_content.length],
    failure_markers_found: [],
    module_scripts_found: 0,
    module_scripts_html_typed: 0,
  };

  let httpStatus = null;
  let body = '';

  // Step A/B: GET with timeout. Throws on DNS/conn-refused/timeout.
  const res = await fetchWithTimeout(cfg.url);
  httpStatus = res.status;
  body = await res.text();

  // Step C: failure markers (substring scan)
  for (const marker of cfg.failure_markers) {
    if (body.includes(marker)) checks.failure_markers_found.push(marker);
  }

  // Step D: required content (substring scan)
  let presentCount = 0;
  const missingRequired = [];
  for (const req of cfg.required_content) {
    if (body.includes(req)) presentCount++;
    else missingRequired.push(req);
  }
  checks.required_present[0] = presentCount;

  // Step E/F: module-script check (gated by config)
  if (cfg.module_script_check !== false) {
    const scripts = extractModuleScripts(body);
    checks.module_scripts_found = scripts.length;

    for (const src of scripts) {
      try {
        const r = await checkModuleScript(src, cfg.url);
        if (!r.isJs) {
          checks.module_scripts_html_typed++;
          findings.push(
            `module script ${r.url} returned Content-Type '${r.contentType || '(none)'}' (chunk-rewrite detected)`,
          );
          break; // one bad chunk is enough — declare CRITICAL
        }
      } catch (e) {
        findings.push(`module script ${src} fetch failed: ${e.message}`);
        break;
      }
    }
  }

  const responseTimeMs = Date.now() - startedAt;

  // Classify
  let verdict;
  if (httpStatus !== 200) {
    verdict = 'CRITICAL';
    findings.unshift(`HTTP status ${httpStatus} (expected 200)`);
  } else if (checks.failure_markers_found.length > 0) {
    verdict = 'CRITICAL';
    findings.unshift(`failure markers present: ${checks.failure_markers_found.join(', ')}`);
  } else if (missingRequired.length > 0) {
    verdict = 'CRITICAL';
    findings.unshift(`missing required content: ${missingRequired.join(', ')}`);
  } else if (checks.module_scripts_html_typed > 0) {
    verdict = 'CRITICAL'; // findings already populated above
  } else if (responseTimeMs > cfg.warning_response_time_ms) {
    verdict = 'WARNING';
    findings.unshift(`response time ${responseTimeMs}ms exceeds warning threshold ${cfg.warning_response_time_ms}ms`);
  } else {
    verdict = 'HEALTHY';
  }

  return { verdict, http_status: httpStatus, response_time_ms: responseTimeMs, checks, findings };
}

async function probeWithRetries(cfg) {
  let lastError = null;
  let result = null;
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      result = await probeOnce(cfg);
      // Stop retrying once we have a valid response (any verdict). The retry
      // loop is for transient network/DNS failures, not for policing CRITICAL
      // verdicts that came from the server.
      return result;
    } catch (e) {
      lastError = e;
      if (i < MAX_RETRIES - 1) await sleep(RETRY_GAP_MS);
    }
  }
  // All retries failed — network/DNS/timeout
  return {
    verdict: 'CRITICAL',
    http_status: null,
    response_time_ms: null,
    checks: {
      required_present: [0, cfg.required_content.length],
      failure_markers_found: [],
      module_scripts_found: 0,
      module_scripts_html_typed: 0,
    },
    findings: [`fetch failed after ${MAX_RETRIES} retries: ${lastError?.message || 'unknown error'}`],
  };
}

function isoStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function renderMarkdown(payload, cfg) {
  const { verdict, url, http_status, response_time_ms, checks, findings, error } = payload;
  const stamp = new Date().toISOString();
  const verdictBadge = { HEALTHY: '✓', WARNING: '⚠', CRITICAL: '✗', ERROR: '!' }[verdict] || '?';
  const lines = [
    `# Canary Report — ${url} — ${stamp}`,
    '',
    `**Status:** ${verdict} ${verdictBadge}`,
    '',
    '| Check | Result | Threshold |',
    '|---|---|---|',
    `| HTTP status | ${http_status ?? 'n/a'} | == 200 |`,
    `| Response time | ${response_time_ms ?? 'n/a'}ms | < ${cfg.warning_response_time_ms}ms |`,
    `| Required content | ${checks.required_present[0]}/${checks.required_present[1]} | all present |`,
    `| Failure markers | ${checks.failure_markers_found.length} | == 0 |`,
    `| Module-script Content-Type | ${checks.module_scripts_found - checks.module_scripts_html_typed}/${checks.module_scripts_found} | all application/javascript |`,
    '',
  ];
  if (findings.length || error) {
    lines.push('## Findings', '');
    findings.forEach((f) => lines.push(`- ${f}`));
    if (error) lines.push(`- error: ${error}`);
    lines.push('');
  }
  return lines.join('\n');
}

async function main() {
  let payload;
  let cfg;

  try {
    cfg = loadConfig();
    if (!cfg.url) {
      payload = { verdict: 'ERROR', url: null, error: 'no URL configured (pass as arg or set in .claude/canary-watch.json)' };
      console.log(JSON.stringify(payload, null, 2));
      process.exit(2);
    }

    const probe = await probeWithRetries(cfg);
    payload = {
      verdict: probe.verdict,
      url: cfg.url,
      http_status: probe.http_status,
      response_time_ms: probe.response_time_ms,
      checks: probe.checks,
      findings: probe.findings,
      error: null,
    };
  } catch (e) {
    payload = {
      verdict: 'ERROR',
      url: cfg?.url ?? null,
      http_status: null,
      response_time_ms: null,
      checks: { required_present: [0, 0], failure_markers_found: [], module_scripts_found: 0, module_scripts_html_typed: 0 },
      findings: [],
      error: e?.message || String(e),
    };
  }

  // Side effects
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
  const reportPath = resolve(TMP_DIR, `canary-watch-${isoStamp()}.md`);
  payload.report_path = reportPath.replace(REPO_ROOT + '/', '').replace(/\\/g, '/');
  payload.latest_path = LATEST_JSON.replace(REPO_ROOT + '/', '').replace(/\\/g, '/');

  writeFileSync(reportPath, renderMarkdown(payload, cfg ?? DEFAULTS));
  writeFileSync(LATEST_JSON, JSON.stringify(payload, null, 2));

  console.log(JSON.stringify(payload, null, 2));

  const exitCode = { HEALTHY: 0, WARNING: 0, CRITICAL: 1, ERROR: 2 }[payload.verdict] ?? 2;
  process.exit(exitCode);
}

main();
