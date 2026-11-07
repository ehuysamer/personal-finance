# CLAUDE.md

Guidance for Claude Code (and other AI tools) working in this repository.

## What this is

Personal finance: a multi-tenant tool that imports bank statements, puts transactions into accounts, analyses them as
timeseries and forecasts them. The spec is `doc/requirements.md` (markers `[ ]` to do, `[C]` coded, `[X]` done,
`[?]` to decide). Keep it current when behaviour changes.

## Layout

| Part | Folder | Local port |
|---|---|---|
| API + MCP | `Src/PersonalFinanceApi` (Node/Express on Lambda, S3) | 4200 (`/v1/mcp`) |
| Web | `Src/PersonalFinanceWeb` (Vue 3/Vite SPA, mobile-first, S3 + CloudFront) | 5190 |

- No root `package.json`; run npm inside each app.
- Conventions follow mediasites4-mcp's Timeseries: `src/index.js` is the local entry and the Lambda handler
  (`buildDependencies()`), `handlers/*.handler.js`, `services/*.service.js` exporting functions, `dal/`, `lib/`,
  `config/`; ES modules, double quotes; `node:test` tests; Playwright for the web; Terraform in `infra/` with
  `dev.tfvars`/`prod.tfvars`; deploy scripts plan by default and apply with `--apply`.
- `ai/` holds instructions, `session.md` (keep it current so a later session can resume) and `todo.todo`.

## Data

- `data/` is the local object store (same layout as the bucket `personalfinance-{env}-20261108`); `data/import/`
  is a drop folder. **Nothing under `data/` is ever committed** (`data/.gitignore`). Test data is made up and lives in
  `Src/PersonalFinanceApi/test/fixtures/`.
- No keys in files. Secrets go in `doc/secrets.local.txt` (git-ignored).

## Rules

- No EC2 or ECS; keep AWS spend down.
- Ask before each `terraform apply`.
- Only `ehuysamer@gmail.com` may sign in for now (`allowed_emails` in `infra/dev.tfvars`).
