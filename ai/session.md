# Session

2026-11-08: requirements agreed (`doc/requirements.md`); API, web, offline mode and Terraform coded.

- API tests: `npm test` in `Src/PersonalFinanceApi` (unit + an end-to-end flow on the memory store).
- Web: `npm test`, and `NODE_PATH=$(npm root -g) npm run test:e2e` (Playwright on an iPhone viewport against a
  local API on a throwaway data folder).
- Planned (not applied): `Src/PersonalFinanceApi/scripts/deploy.sh dev` = 26 resources to add. Apply needs the
  user's approval each time. Then the web: `Src/PersonalFinanceWeb/scripts/deploy.sh dev` (reads the API's outputs).
- GitHub: the token on cobalt cannot create repositories; the user is to create `ehuysamer/personal-finance`
  (private), then `git push -u origin main`.
- Next: deploy and check sign-in, MCP via claude.ai, `sync:pull` against the bucket; OpenAPI + Bruno; Monitor checks.
