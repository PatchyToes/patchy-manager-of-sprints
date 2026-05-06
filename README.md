# Patchy Manager of Sprints

Claude Code slash commands for triaging GitHub issues, planning implementations with adversarial review, walking through plans with an operator, and orchestrating sprint cycles. Designed for solo operators with an AI partner — every prompt is self-contained so your AI can fill in the blanks without asking.

This is the system that runs my own backlog. I'm putting it in the world because it's saved me a lot of context-switching, and I think it'll save other people the same.

## What it does

Issues flow through a labeled state machine driven by skills:

```
open issue
   │
   ▼  /scope-issue (single)  or  /batch-scope (bulk)
   │     Triage gate — emits PLAN-3-ROUND / PLAN-1-ROUND / DEFER / ABORT / NEEDS-OPERATOR
   │     Writes labels: scoped | deferred | scope:abort
   ▼
scoped issues
   │
   ▼  /plan-issue-three-round  or  /plan-issue-one-round
   │     Drafts a plan, dispatches a fresh subagent as critic, integrates feedback
   │     Writes plan artifact to docs/protocol-test-runs/issue-N-*.md
   │     Writes label: planned
   ▼
planned issues
   │
   ▼  /review-plans
   │     Reviewer pass — READY / NEEDS-OPERATOR / ABANDON
   │     Adversarial filter on over-cautious escalations
   │     Writes labels: ready | needs-operator | abandoned
   ▼
ready issues
   │
   ▼  /sprint-walkthrough  (or /walkthrough-plans for read-only)
   │     Operator-facing 4-beat walkthrough
   │     Decides greenlit / abandoned
   ▼
greenlit issues
   │
   ▼  /sprint-implement
         Bootstraps a fresh implementation session with the handoff brief
```

Sprint orchestration layered on top: `/sprint-start` (pick the cohort), `/sprint-plan` (auto-dispatch planners across the sprint), `/sprint-walkthrough` (decide each ready plan), `/sprint-implement`, `/sprint-end`, `/sprint-retro`, `/sprint-doctor` (health check), `/sprint` (status oracle).

## Install

You'll need:
- **Claude Code** (any plan that exposes the `Task` / `Agent` tool — required by the planner skills)
- **`gh` CLI** authenticated against the repo you want to plan (`gh auth login`)
- **Git** in PATH
- **A GitHub repo** with at least 2 open issues for the smoke tests

Install steps:

1. **Fetch `setup-pipeline.md`** from this repo into your repo's `.claude/commands/` directory:

   ```bash
   mkdir -p .claude/commands
   gh api repos/PatchyToes/patchy-manager-of-sprints/contents/docs/templates/commands/setup-pipeline.md \
     --jq '.content' | base64 -d > .claude/commands/setup-pipeline.md
   ```

2. **Run `/setup-pipeline` in Claude Code.** It interviews you for ~10 minutes (deploy process, high-stakes surfaces, team, operator name), then:
   - Installs the other 14 skills
   - Scaffolds the four IK files (`docs/modules.md`, `docs/stakes-index.md`, `docs/lessons-by-surface.md`, `docs/operating-principles.md`)
   - Pre-creates required directories (`docs/sprints/`, `docs/protocol-test-runs/`, `docs/plans/`, `docs/debriefs/`, `tmp/`)
   - Creates 11 pipeline labels in your repo (with collision warnings if any name already exists)
   - Runs three smoke tests against real issues

3. **Done.** You can now run `/scope-issue`, `/sprint-start`, etc.

The IK files are the system's memory. They start sparse and get more useful over time — every plan reads them; every incident is one entry away from being captured forever.

| File | What it holds |
|------|---------------|
| `docs/modules.md` | Module map — what each part of your codebase is and why it's a unit |
| `docs/stakes-index.md` | High-stakes surfaces, deploy steps, RLS sensitivity, verification scripts |
| `docs/lessons-by-surface.md` | Incident lessons keyed to files (grows over time from real bugs) |
| `docs/operating-principles.md` | Workflow rules — how you work, not which code |

## Pipeline labels

`/setup-pipeline` creates these in your repo (skipping any that already exist with a warning):

- `scoped` — passed triage, ready to plan
- `deferred` — out of scope this cycle
- `scope:abort` — abandoned at triage
- `planned` — plan artifact written
- `ready` — reviewer signed off
- `greenlit` — operator approved at walkthrough
- `abandoned` — declined to ship
- `needs-operator` — escalation, gate or reviewer can't decide
- `implementing` — actively being shipped
- `sprint` — in current sprint cohort
- `tracking` — long-running, not in normal flow

If your repo already uses any of these names with different semantics, the setup will warn you. Rename your existing label first.

## Repo layout

```
docs/templates/commands/    # 16 skill templates — source of truth
docs/templates/snippets/    # shared snippets inlined at generation time (e.g. glossary)
scripts/generate-skills.mjs # regenerates .claude/commands/ from templates
```

Templates are the source of truth. The live `.claude/commands/*.md` files are generated — edit templates, run `node scripts/generate-skills.mjs`, regenerate.

The generator supports two substitutions and a build-time include macro:
- `{{OPERATOR}}` — replaced with the operator's name
- `{{PATH_PREFIXES}}` — replaced with a regex of top-level code directories
- `{{INCLUDE:snippet-name}}` — inlined from `docs/templates/snippets/<name>.md`

## Contributing

Issues and PRs welcome. If you've got a planning protocol improvement, a triage rule that catches more rot, or a new sprint phase that closes a gap — open an issue.

When proposing changes:
- Templates in `docs/templates/commands/` are the source of truth — edit there, not in the generated `.claude/commands/`.
- Run `node scripts/generate-skills.mjs` after editing templates to keep the live files in sync.
- The skills are designed to be self-contained — no cross-file references at runtime, since each skill loads in its own prompt context. If you want a shared snippet, put it in `docs/templates/snippets/` and reference via `{{INCLUDE:name}}`.

## License

MIT — see [LICENSE](LICENSE).

## Origin

Built by [@PatchyToes](https://github.com/PatchyToes) while running [PatchyHub](https://patchyhub.com), a documentation tool for GoHighLevel CRMs. The system started as a way to keep the PatchyHub backlog from drowning me; it turned out to generalize.
