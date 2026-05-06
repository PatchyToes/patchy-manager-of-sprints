// Regenerates .claude/commands/ skill files from docs/templates/commands/.
// Edit the templates, then run: node scripts/generate-skills.mjs
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Defaults below are generic placeholders for the canonical/distribution repo.
// In a forked or installed repo, /setup-pipeline customizes these via Phase 4 to
// match the operator's name and the repo's actual top-level code directories.
const substitutions = {
  '{{OPERATOR}}': 'Operator',
  '{{PATH_PREFIXES}}': 'src|app|lib|api|tests|docs|scripts',
};
const skills = [
  'enrich-issue',
  'scope-issue',
  'batch-scope',
  'plan-issue-one-round',
  'plan-issue-three-round',
  'review-plans',
  'walkthrough-plans',
  'sprint-start',
  'sprint',
  'sprint-plan',
  'sprint-walkthrough',
  'sprint-implement',
  'sprint-end',
  'sprint-retro',
  'sprint-doctor',
];

// Build-time include macro: {{INCLUDE:name}} → contents of docs/templates/snippets/<name>.md.
// Inlined at write time so each runtime prompt contains the full text — no cross-file reads.
function expandIncludes(content, depth = 0) {
  if (depth > 5) throw new Error('INCLUDE recursion limit exceeded');
  return content.replace(/\{\{INCLUDE:([\w-]+)\}\}/g, (_, name) => {
    const path = join(root, 'docs/templates/snippets', `${name}.md`);
    if (!existsSync(path)) throw new Error(`INCLUDE failed: snippet not found: ${name}`);
    return expandIncludes(readFileSync(path, 'utf8').trim(), depth + 1);
  });
}

for (const skill of skills) {
  const src = join(root, 'docs/templates/commands', `${skill}.md`);
  const dest = join(root, '.claude/commands', `${skill}.md`);

  let content = readFileSync(src, 'utf8');
  content = expandIncludes(content);
  for (const [placeholder, value] of Object.entries(substitutions)) {
    content = content.replaceAll(placeholder, value);
  }

  // Preserve the derived-from comment that already exists in the live file's frontmatter
  const comment = `<!-- Derived from docs/templates/commands/${skill}.md — edit the template, not this file. Run \`node scripts/generate-skills.mjs\` to regenerate. -->`;
  content = content.replace(/^(---[\s\S]*?---\n)/, `$1${comment}\n`);

  writeFileSync(dest, content);
  console.log(`✓ ${skill}.md`);
}
