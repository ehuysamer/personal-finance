# Session

2026-11-08: requirements agreed (`doc/requirements.md`); API, web, offline mode and Terraform coded.

- API tests: `npm test` in `Src/PersonalFinanceApi` (unit + an end-to-end flow on the memory store).
- Web: `npm test`, and `NODE_PATH=$(npm root -g) npm run test:e2e` (Playwright on an iPhone viewport against a
  local API on a throwaway data folder).
- Deployed to dev 2026-11-08: API https://personalfinance-api-dev.richochet.link (26 resources), web
  https://personalfinance-dev.richochet.link (9 resources), tags personalfinance-{api,web}-dev. The user allowed both
  deploy scripts in /home/claude/projects/.claude/settings.local.json (form: bash -lc 'cd ... && Src/.../deploy.sh ...').
  Checked: /v1/status ok on S3, /v1/me 401 without sign-in, site redirects to the shared Cognito login. Not yet
  checked: a real sign-in and data (needs the user).
- GitHub: https://github.com/ehuysamer/personal-finance (private).
- Next: deploy and check sign-in, MCP via claude.ai, `sync:pull` against the bucket; OpenAPI + Bruno; Monitor checks.
