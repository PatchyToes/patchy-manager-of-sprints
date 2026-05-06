#!/usr/bin/env node
// Sprint status renderer — pure script, no LLM tokens.
// Invoked by the /sprint slash command. Run directly: node scripts/sprint.mjs
//
// Reads sprint state from GitHub (open + closed `sprint`-labeled issues) and
// the latest manifest in docs/sprints/, renders a normalized progress bar per
// module, lists implementing issues by name, and recommends the next verb.
//
// State → color mapping
// ---------------------
//   IMPLEMENTED                            🟩  shipped (closed with `Closes #N`)
//   PLANNED, READY, IMPLEMENTING           🟧  active progress in the pipeline
//   GREENLIT                               🟨  walkthrough cleared, ready to ship
//   SCOPED                                 ⬛  queued, planning hasn't started
//   ABANDONED                              🟦  closed terminal, won't be done
//   NEEDS-MIKE / NEEDS-OPERATOR            🟥  blocked, needs operator decision
//
// Display order within each bar (left to right):
//   🟩 → 🟧 → 🟨 → ⬛ → 🟦 → 🟥  (furthest-along to least-along)
//
// Each bar is always 10 cells = 100% of that module. Largest-remainder rounding
// keeps cell counts integer-summing to exactly 10 regardless of issue count, so
// a 2-issue module fully shipped looks the same as a 9-issue module fully
// shipped.
//
// Output format
// -------------
//   • Announce lines (plain markdown)
//   • Code-fenced table (monospace alignment for bars + module padding)
//   • "Where you are now" summary + optional "In progress:" punch list
//   • Optional "Needs your input" list for needs-operator items
//   • "Your next step" with a single recommended verb
//
// The fence is baked into the script's stdout so any caller (slash command, CI,
// human terminal) gets correctly-aligned output without extra wrapping. The
// trade-off is three literal ``` characters visible if you run it directly in
// a terminal — cosmetic only.

import { execSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const COLORS = {
  shipped: '🟩',
  active: '🟧',
  ready: '🟨',
  queued: '⬛',
  abandoned: '🟦',
  blocked: '🟥',
};

const DISPLAY_ORDER = ['shipped', 'active', 'ready', 'queued', 'abandoned', 'blocked'];

const STATE_TO_COLOR = {
  IMPLEMENTED: 'shipped',
  IMPLEMENTING: 'active',
  PLANNED: 'active',
  READY: 'active',
  GREENLIT: 'ready',
  SCOPED: 'queued',
  ABANDONED: 'abandoned',
  NEEDS_OPERATOR: 'blocked',
};

const SUMMARY_LABELS = {
  shipped: 'shipped',
  active: 'in-progress',
  ready: 'ready',
  queued: 'not-started',
  abandoned: 'abandoned',
  blocked: 'blocked',
};

function gh(args) {
  return execSync(`gh ${args}`, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function getISOWeek() {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function stateForIssue(issue, isClosed) {
  const labels = (issue.labels || []).map(l => (typeof l === 'string' ? l : l.name));
  if (isClosed) {
    if (labels.includes('abandoned')) return 'ABANDONED';
    return 'IMPLEMENTED';
  }
  if (labels.includes('abandoned')) return 'ABANDONED';
  if (labels.includes('needs-mike') || labels.includes('needs-operator')) return 'NEEDS_OPERATOR';
  if (labels.includes('implementing')) return 'IMPLEMENTING';
  if (labels.includes('greenlit')) return 'GREENLIT';
  if (labels.includes('ready')) return 'READY';
  if (labels.includes('planned')) return 'PLANNED';
  return 'SCOPED';
}

function bucketCounts(moduleIssues) {
  const counts = {};
  for (const c of DISPLAY_ORDER) counts[c] = 0;
  for (const issue of moduleIssues) {
    const color = STATE_TO_COLOR[issue.state];
    if (color) counts[color]++;
  }
  return counts;
}

function buildBar(counts, total) {
  if (total === 0) return COLORS.queued.repeat(10);
  const ints = {};
  const fracs = [];
  for (const c of DISPLAY_ORDER) {
    const f = (counts[c] / total) * 10;
    ints[c] = Math.floor(f);
    fracs.push({ color: c, frac: f - ints[c] });
  }
  let remainder = 10 - DISPLAY_ORDER.reduce((s, c) => s + ints[c], 0);
  fracs.sort((a, b) => b.frac - a.frac || DISPLAY_ORDER.indexOf(a.color) - DISPLAY_ORDER.indexOf(b.color));
  for (let i = 0; i < remainder; i++) ints[fracs[i].color]++;
  let bar = '';
  for (const c of DISPLAY_ORDER) bar += COLORS[c].repeat(ints[c]);
  return bar;
}

function summary(counts, total) {
  const parts = [];
  for (const c of DISPLAY_ORDER) {
    if (counts[c] > 0) {
      const pct = Math.round((counts[c] / total) * 100);
      parts.push(`${pct}% ${SUMMARY_LABELS[c]}`);
    }
  }
  return parts.join(' · ');
}

// Phase 0
try {
  execSync('gh auth status', { stdio: 'ignore' });
} catch {
  fail('Sprint status abort: gh not authenticated.');
}

// Phase A: announce
console.log('═══ SPRINT · status ═══');
console.log('Reading sprint state. No writes — pure status.');
console.log('');
console.log('```');

// Phase 1
const openRaw = JSON.parse(gh('issue list --state open --label sprint --limit 100 --json number,title,labels'));
if (openRaw.length === 0) {
  // Even with no open issues, check closed for context.
  const closedCheck = JSON.parse(gh('issue list --state closed --label sprint --limit 1 --json number'));
  if (closedCheck.length === 0) {
    console.log('No sprint in flight.');
    console.log('');
    console.log('Run `/sprint-start` to pick this week\'s sprint.');
    process.exit(0);
  }
}

const closedRaw = JSON.parse(gh('issue list --state closed --label sprint --limit 100 --json number,title,labels,closedAt'));

// Phase 2: resolve sprint identifier
let sprintId = null;
let manifestPath = null;
let manifestWarning = null;

try {
  const files = readdirSync('docs/sprints')
    .filter(f => f.endsWith('.md'))
    .sort()
    .reverse();
  if (files.length > 0) {
    sprintId = files[0].replace(/\.md$/, '');
    manifestPath = path.join('docs/sprints', files[0]);
  }
} catch {}

if (!sprintId) {
  sprintId = getISOWeek();
  manifestWarning = `No manifest found at docs/sprints/. Using fallback ID ${sprintId}.`;
}

// Phase 3: parse manifest
const issueToModule = {};
const manifestModuleOrder = [];

if (manifestPath) {
  const manifest = readFileSync(manifestPath, 'utf8');
  const lines = manifest.split('\n');
  let currentModule = null;
  for (const line of lines) {
    if (line.startsWith('---')) break;
    const moduleMatch = line.match(/^##\s+([a-z][\w-]*)\s+\((\d+)\)/);
    if (moduleMatch) {
      currentModule = moduleMatch[1];
      manifestModuleOrder.push(currentModule);
      continue;
    }
    if (currentModule) {
      const issueMatch = line.match(/^-\s+#(\d+)/);
      if (issueMatch) issueToModule[issueMatch[1]] = currentModule;
    }
  }
}

const issues = [];
const unassigned = [];

for (const i of openRaw) {
  const mod = issueToModule[String(i.number)] || 'unsorted';
  if (!issueToModule[String(i.number)]) unassigned.push(i.number);
  issues.push({ number: i.number, title: i.title, labels: i.labels, state: stateForIssue(i, false), module: mod, closed: false });
}
for (const i of closedRaw) {
  const mod = issueToModule[String(i.number)] || 'unsorted';
  if (!issueToModule[String(i.number)]) unassigned.push(i.number);
  issues.push({ number: i.number, title: i.title, labels: i.labels, state: stateForIssue(i, true), module: mod, closed: true });
}

// Group by module
const moduleStats = {};
for (const issue of issues) {
  if (!moduleStats[issue.module]) moduleStats[issue.module] = [];
  moduleStats[issue.module].push(issue);
}

const sortedModules = Object.keys(moduleStats).sort((a, b) => {
  if (a === 'cross-cutting') return 1;
  if (b === 'cross-cutting') return -1;
  return moduleStats[b].length - moduleStats[a].length;
});

// Render header
const totalIssues = issues.length;
const moduleCount = sortedModules.length;

console.log('==========================================');
console.log(`SPRINT ${sprintId} — ${totalIssues} issues across ${moduleCount} modules`);
console.log('==========================================');
console.log('');

const maxModuleWidth = Math.max(...sortedModules.map(m => m.length));

for (const mod of sortedModules) {
  const list = moduleStats[mod];
  const counts = bucketCounts(list);
  const bar = buildBar(counts, list.length);
  const sum = summary(counts, list.length);
  const allShipped = counts.shipped === list.length && list.length > 0;
  const allBlocked = counts.blocked === list.length && list.length > 0;
  const allAbandoned = counts.abandoned === list.length && list.length > 0;
  let suffix = '';
  if (allShipped) suffix = ' — fully shipped';
  else if (allBlocked) suffix = ' — needs operator decision';
  else if (allAbandoned) suffix = ' — wiped';
  const padded = mod.padEnd(maxModuleWidth);
  const sizeStr = `(${list.length})`.padStart(4);
  console.log(`  ${padded} ${sizeStr}: ${bar}  ${sum}${suffix}`);
}

console.log('```');
console.log('');

// Compute open buckets for recommendation
const openIssues = issues.filter(i => !i.closed);
const greenlitNotImpl = openIssues.filter(i => i.state === 'GREENLIT');
const readyNotGreenlit = openIssues.filter(i => i.state === 'READY');
const needsOperator = openIssues.filter(i => i.state === 'NEEDS_OPERATOR');
const planned = openIssues.filter(i => i.state === 'PLANNED');
const implementing = openIssues.filter(i => i.state === 'IMPLEMENTING');
const scoped = openIssues.filter(i => i.state === 'SCOPED');

const totalShipped = issues.filter(i => i.state === 'IMPLEMENTED').length;
const totalAbandoned = issues.filter(i => i.state === 'ABANDONED').length;

// Where you are now
console.log('**Where you are now**');
const parts = [`${totalShipped} shipped`];
if (implementing.length > 0) parts.push(`${implementing.length} implementing`);
if (greenlitNotImpl.length > 0) parts.push(`${greenlitNotImpl.length} greenlit`);
if (readyNotGreenlit.length > 0) parts.push(`${readyNotGreenlit.length} awaiting walkthrough`);
if (planned.length > 0) parts.push(`${planned.length} planning`);
if (scoped.length > 0) parts.push(`${scoped.length} scoped`);
if (needsOperator.length > 0) parts.push(`${needsOperator.length} blocked`);
if (totalAbandoned > 0) parts.push(`${totalAbandoned} abandoned`);
console.log(parts.join(', ') + '.');

// In progress (currently implementing) — anchor for "what was I working on"
if (implementing.length > 0) {
  console.log('');
  console.log('In progress:');
  for (const i of implementing) {
    console.log(`  - #${i.number} (${i.module}) — ${i.title}`);
  }
}

console.log('');

// Needs your input
if (needsOperator.length > 0) {
  console.log('**Needs your input**');
  for (const i of needsOperator) {
    console.log(`  - #${i.number} (${i.module}) — needs operator decision`);
  }
  console.log('');
}

// Recommendation
console.log('**Your next step**');
if (greenlitNotImpl.length > 0) {
  console.log('`/sprint-implement` — bootstraps a fresh implementation session for the next greenlit plan. Stay-at-keyboard ~30s for the brief, then walk away.');
} else if (readyNotGreenlit.length > 0 || needsOperator.length > 0) {
  console.log('`/sprint-walkthrough` — walk through cleared plans + escalations. Stay-at-keyboard.');
} else if (scoped.length > 0) {
  console.log('`/sprint-plan` — picks the next module and plans its issues. Stay-at-keyboard ~1min, then walk away.');
} else if (implementing.length > 0) {
  const list = implementing.map(i => '#' + i.number).join(', ');
  console.log(`Wait state — ${implementing.length} implementation${implementing.length > 1 ? 's' : ''} in flight (${list}). Re-run \`/sprint\` in a few minutes, then \`/sprint-end\` once they land.`);
} else if (planned.length > 0) {
  console.log(`Wait state — ${planned.length} plan${planned.length > 1 ? 's' : ''} still in reviewer. Re-run \`/sprint\` in a few minutes.`);
} else {
  console.log('`/sprint-end` — every sprint issue is in a terminal state. Close out and start the next sprint.');
}

// Footnotes
const footnotes = [];
if (manifestWarning) footnotes.push(manifestWarning);
if (unassigned.length > 0) {
  footnotes.push(`${unassigned.length} issue(s) not in manifest, assigned to "unsorted": ${unassigned.map(n => '#' + n).join(', ')}`);
}

if (footnotes.length > 0) {
  console.log('');
  console.log('---');
  for (const f of footnotes) console.log(`Footnote: ${f}`);
}
