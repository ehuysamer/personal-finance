# Personal finance: requirements

A multi-tenant personal (or company) finance tool: import bank statements, put transactions into accounts, analyse
them as timeseries and forecast them. Started 2026-11-08; requirements agreed 2026-11-08; API, web, offline mode and Terraform coded the same day (not deployed yet).

Markers: `[ ]` to do, `[C]` coded, `[X]` done (deployed and checked), `[?]` to decide.

## Parts and layout

`~/projects/personal-finance`: its own git repo with a private GitHub repo `personal-finance` (like `pa` and
`dashboard-mcp`), laid out like mediasites4-mcp:

| Part | Folder | Dev host (planned) | |
|---|---|---|---|
| API + MCP | `Src/PersonalFinanceApi` | `personalfinance-api-dev.richochet.link` | Node/Express REST API and MCP on Lambda; every REST operation also has an MCP tool |
| Web | `Src/PersonalFinanceWeb` | `personalfinance-dev.richochet.link` | Vue 3/Vite SPA, mobile-first, static on S3 `websites-20250103/personalfinance-dev` behind CloudFront |

- `doc/requirements.md` (this document), `ai/` (instructions, session, todo, style), `Scripts/` (deploy, tag).
- `data/` is the local object store (same layout as the S3 bucket); `data/import/` is a drop folder:
  `npm run import -- <tenant> <datasource>` imports its files into that datasource as if uploaded in the web.
- [C] Nothing under `data/` is committed: `data/.gitignore` ignores everything (`*`) apart from itself, so the folders
      exist in a fresh clone but no financial data ever reaches source control. Samples for tests live in
      `Src/PersonalFinanceApi/test/fixtures/` with made-up data only.
- Code layout as Timeseries: `src/index.js` (local entry and Lambda handler, `buildDependencies()`),
  `handlers/*.handler.js`, `services/*.service.js` (exported functions), `dal/`, `lib/`, `config/`, `models/`,
  `build/`; `node:test` unit tests; Playwright for the web; `infra/` Terraform with `dev.tfvars`/`prod.tfvars`; bash
  and PowerShell deploy scripts that plan by default and apply with `--apply`; tags
  `personalfinance-{api,web}-{env}`.
- No EC2 or ECS: Lambda, API Gateway (HTTP API), S3, CloudFront, and a small DynamoDB table for job leases (on demand).

## Sign-in and access

- [C] Sign-in with the shared admin pool (`knowledgebase-admin-shared`, the same as Timeseries), own app client.
      The web uses the Cognito hosted UI (code + PKCE) and calls the API with the user's token; the API verifies it.
- [C] Only `ehuysamer@gmail.com` has access for now: an allow-list of emails in the API's config (`dev.tfvars`);
      everyone else gets 403 even with a valid pool login.
- [C] MCP: OAuth that signs in through the same Cognito client, so MCP calls act as the user (same allow-list and
      tenant checks). REST also accepts a per-tenant API key (in `Doc/secrets.local.txt`, never in files) for scripts.

## Tenants

- [C] All data are kept per tenant; every request names a tenant and is checked against the user's memberships.
- [C] After sign-in the user sees the list of tenants they belong to and picks one (remembered on the device);
      a switcher in the header changes it. With one tenant it is opened directly.
- [C] Tenant: `id`, `name`, `members` (email, role `owner` | `member`), `createdAt`. Owners add/remove members and
      rename the tenant. A first tenant is seeded for the owner.
- [C] Later Subscription integration (not now): tenants and memberships come from one module,
      `services/tenantDirectory.service.js` (today: S3 tenant files and the allow-list). Swapping it for the
      Subscription system (its pool, `appId`, entitlements, as Risk log does) must not touch the rest of the code.

## Storage (S3 `personalfinance-dev-20261108`, public access blocked, versioning, encryption)

Root folders are `{tenant}/{project}` and `{tenant}/{datasource}`. Ids are slugs, unique within a tenant across
projects and datasources; each folder's `$meta.json` says which it is (`kind: project | datasource`).

```
$tenants/$index.json                        tenants and their members' emails
$tenants/{tenant}.json                      tenant and members
{tenant}/$index.json                        projects and datasources (id, kind, name, updatedAt)
{tenant}/{datasource}/$meta.json            datasource
{tenant}/{datasource}/importsources/$index.json, {importsource}.json
{tenant}/{datasource}/files/$index.json     every imported file: id, filename, size, sha256, importsource, rows, status
{tenant}/{datasource}/files/{fileId}/{filename}          the original, immutable
{tenant}/{datasource}/files/{fileId}/rows.json           normalised rows
{tenant}/{datasource}/manual/transactions.json, totals.json
{tenant}/{project}/$meta.json               project (datasources, age/birth date, categories)
{tenant}/{project}/accounts/$index.json, {account}.json
{tenant}/{project}/rules/$index.json, {rule}.json
{tenant}/{project}/charts/$index.json, {chart}.json
{tenant}/{project}/analysis/$results.json   last run: status, started/finished, counts, last date, warnings
{tenant}/{project}/analysis/accounts/{account}/transactions/{yyyy}.json
{tenant}/{project}/analysis/accounts/{account}/aggregates.json
{tenant}/{project}/forecasts/$index.json
{tenant}/{project}/forecasts/{forecast}/$meta.json        definition (formulas, parameters, generators)
{tenant}/{project}/forecasts/{forecast}/$results.json, model.json   last run, model terms per account
{tenant}/{project}/forecasts/{forecast}/accounts/{account}/...   as analysis
{tenant}/{project}/jobs/$index.json, {jobId}.json   long-running jobs (last 50) and their state
{tenant}/{datasource}/$uploads/{uploadId}/{filename}    large uploads, removed once imported
{tenant}/$users/{sha256(email)}.json         a user's preferences (active project)
{tenant}/import/...                         the import folder; imported files move to import/imported/{yyyy-mm-dd}/
{tenant}/documents/$index.json, {folder}/{name}   documents (any files the user keeps)
```

- [C] Indexes (`$index.json`) are lists of things (tenants, projects, datasources, importsources, files, accounts,
      rules, charts, forecasts) so the API never needs S3 list calls to show them. Every create, rename, clone, move
      and delete keeps them in step (conditional writes, so two writes can't lose each other's change);
      `POST /v1/tenants/{tenant}/indexes/rebuild` repairs them from the folders. Deletes are soft (renamed
      `.<timestamp>.deleted`) and drop out of the index.
- [C] `$meta.json` is written last and is the completion signal (as Timeseries).

## 1. Import

### Datasources

- [C] A datasource is a named, normalised place where data to import lives (e.g. "ASB everyday", "Kiwisaver").
      Add / edit / delete; fields `id`, `name`, `description`, `currency` (default NZD).
- [C] **Import folder** per tenant: `{tenant}/import/` in the bucket (`data/{tenant}/import/` offline; sub-folders
      allowed). Files dropped there (S3 console, `aws s3 cp`, `sync:push`) are listed on the Import page with the
      datasources and importsources whose filename filters match; the user imports one, or all files with exactly one
      match (`npm run import -- <tenant> --folder` offline). An imported file moves to
      `import/imported/{yyyy-mm-dd}/`. `import` is therefore not allowed as a project or datasource id.
- [C] Several files can be dropped at once (drag and drop on a datasource's Files tab, as well as choosing them).
      Files whose names match no importsource's filename filter wait together, and one choice imports them all.
- [C] Files are uploaded in the web (several at once, also from the phone) or from `data/import/`. Each upload picks
      its importsource by the filename filters (below); when none or several match, the user chooses.

### Importsources

- [C] A datasource has one or more importsources. Each has `name`, `format` (`csv` | `json` | `xlsx`; more later),
      format options (csv delimiter, encoding, header rows to skip; json rows path; xlsx sheet), a **filename filter**
      (wildcard or regex, e.g. `ASB-*-Export.csv`), and its **translators**.
- [C] **Import sample**: a sample file chosen, dropped on the sample card, or picked from Documents (the API reads the
      document itself: `import_sample` with `documentPath`); the web shows its columns and a grid of its first 10 rows
      as they are in the file, and the user maps them.
- [C] Target fields: `date`, `account`, `description`, `amount`. Each target has an ordered list of parts:
      a source column, or a fixed (hardcoded) value. Several parts are joined (text: with a separator, default
      space; amount: added, so debit and credit columns can make one amount, each with an optional sign flip).
      The order can be changed. Date parts take a format (`dd/MM/yyyy`, Excel serial, ...).
- [C] Each amount part has a **+ / −** toggle: − negates it (Credit + and Debit − make one signed amount); fixed values
      too.
- [C] The mapping preview shows the normalised rows for the sample before saving.
- [C] **Fallback:** a file is read with the importsource given, then those whose filename filter matches, then the
      datasource's other importsources, until one reads at least one row (the answer names it and the ones that read
      nothing first). From Documents or the import folder without a datasource, each datasource whose filters match is
      tried in turn.
- [C] **Why nothing was imported:** every import that adds nothing says why: the same file was already imported, all
      its transactions are already there, every importsource read no rows (each with its reason: no data rows, or all
      rows rejected with the first error), or the datasource has no importsource yet.
- [C] Clone an importsource (then configure it), or clone it into another datasource (move = clone then delete).

### Duplicates

- [C] Each normalised row keeps its datasource, file id and **filename**, and its row number.
- [C] Natural key: datasource + date + account + description + amount. Within one file, identical rows are all real
      (occurrences 1..n). Across files, the same natural key is the same transaction (statements overlap), so the
      datasource keeps, per natural key, as many rows as the **largest count in any single file**. Each kept row
      records which file it came from.
- [C] Uploading a file with the same filename (or the same SHA-256) again replaces that file's rows; it never adds
      duplicates. The upload result reports added / already present / replaced.

### Manual transactions and totals

- [C] The user can add, edit and delete transactions by hand (same fields; marked `manual`).
- [C] The user can add a **total**: the balance of a bank account (the imported `account` field) on a date, e.g. a
      statement's closing balance. A total is the **source of truth**: when analysis runs and the transactions up to
      that date don't add up to it, analysis creates an adjustment transaction (`Balance adjustment`, marked
      `generated`) for the difference, and creates it afresh every run (so regenerating never loses it).
- [C] Each datasource shows its bank accounts with their running balance and totals.

## 2. Projects and accounts

- [C] Projects: add / edit / clone / delete. **Clone** copies the settings, categories, accounts, rules, charts and
      forecast definitions (not analysis or forecast results, jobs or deleted files); the copy becomes the active
      project and is analysed afresh. One project is always active (the user's choice, remembered per tenant);
      from section 2 onwards every screen works in the active project, shown in the header. A tenant with no
      project is asked to create one before going further.
- [C] A project names one or more datasources (of its tenant).
- [C] A project has a **birth date** (a person's age, or a company's founding date) so ages can be shown and
      forecasts can run "until age 65".
- [C] Categories are edited in **Manage categories** (a pop-up on the Accounts page), one at a time: **add**, **rename** (name, type,
      inflation; accounts, charts and forecasts refer to a category by id, so the change shows everywhere) and
      **delete** (its accounts and the chart series that total it move to a category the user picks; forecasts drop
      its inflation override; the last category cannot be deleted). They stay on the project. Wherever a category is
      chosen (adding an account, here or from a rule), a **+** next to the dropdown opens a **New category** pop-up.
- [C] A project has a list of **categories** (e.g. Income, Housing, Food, Transport), each with a type
      `income` | `expense` | `asset` | `liability` and a default inflation rate for forecasting.
- [C] Accounts within a project: add / edit / delete; `name`, optional **short code** (unique in the project,
      letters, digits and `_`, used in charts and formulas), one **category**, **tags**, `description`.
      Deleting an account in use by rules or charts warns and lists them.
- [C] A built-in `Uncategorised` account catches transactions no rule matches.

## 3. Analysis

### Rules

- [C] Rules have a name, an order (first match wins; drag to reorder), a target account, enabled flag and conditions
      (all must match).
- [C] The Rules tab shows them **By account**: category, then account (in the project's order), then the rules that
      move transactions there, each with its place in the order (rules whose account was deleted under "Account
      deleted"). **In order** lists them in the order they are tried, with up and down to change which wins. Rows
      look clickable (pointer, hover and focus highlight, ›) and open the rule; clone is on each row.
- [C] Text conditions on any field (`description`, `account`, `filename`, `datasource`): `wildcard` (`*` any run,
      `?` one character), `regex` (bounded input length and time), `exact`, `startswith`, `endswith`,
      `containsall` and `containsany` (several entries), `not` flag. Each condition has an **Ignore case** tickbox
      (ticked by default: "countdown" matches "COUNTDOWN ALBANY"); unticked, letter case must match
      (`caseSensitive: true`), for every operator including wildcard and regex.
- [C] Date range (optional start, optional end) and amount range (optional minimum, optional maximum).
- [C] "Test rule" shows which transactions it would match (and which earlier rule takes them instead).
- [C] A new rule's account is never pre-filled ("Choose an account"): the user picks it explicitly before saving. A
      rule can be tested before its account is chosen.
- [C] After analysis, **Not matched by any rule** lists the transactions that went to Uncategorised (paged, newest
      first, searchable), each with **Add rule**: the rule sheet opens pre-filled with a name and a "description
      contains" condition taken from the beneficiary words of its description (a run of up to four words without
      digits or bank noise such as POS, EFTPOS, CARD, AP#, exactly as written so it matches), and is tested at once.
      A **+** next to "Into account" opens a **New account** pop-up (name, category with its own +, short code) and
      selects the account it adds. After saving, **Analyse again** applies it. MCP: `unmatched_transactions` (with `suggestedRule`), `rule_suggest`.

### Running analysis

- [C] **Analyse** reads the project's datasources (imported and manual rows, totals), applies the rules, and writes
      each account's transactions and aggregates. It rebuilds from scratch each time, so it is repeatable.
- [C] Each account gets per-transaction running totals, and **monthly, quarterly and yearly** aggregates: sum,
      running total, count, average, minimum, maximum. Category totals are aggregated the same way. These are
      built in the same pass as the transactions.
- [C] The results are timeseries: readable by the chart engine, and downloadable as CSV.
      [?] Publish them to the Timeseries system as a Gold set later.

### Charts

- [C] Named charts saved per project. A series is an account (by short code or id), **several accounts added up**
      (any accounts, for groupings a category does not give), a category total, or a tag total; with a measure
      (running total, sum, count, average, min, max). Each series has a **label** and an **axis**: left, right (its
      own scale on the right), or virtual (its own scale over the chart's height, no axis drawn). Charts may title
      their left and right axes.
- [C] Periods: daily, weekly (ISO weeks, named by their Monday), monthly, quarterly, yearly. Monthly, quarterly and
      yearly come from the stored aggregates; daily and weekly are worked out from the transactions.
- [C] Calculated series with the Timeseries expression language (`chartExpression.js`: series names, numbers,
      `+ - * /`, parentheses, per-bucket aggregates), e.g. `INC - EXP`, `SAV / INC * 100`.
- [C] Charts are calculated by the API, never in the browser (as Timeseries).

### Explore (charts, history and aggregates in one place)

- [C] Analysis and Forecast each have one **Explore** tab instead of separate Charts and History. Its settings at the
      top choose what to look at (a saved chart, or any one account: its running total and its total per period),
      the period (day to year) and an optional date range (and, in a forecast, whether actuals are included). The
      user then flips between:
  - **Chart**: the lines (actuals solid, forecast dotted).
  - **History**: the transactions behind the chart, paged, newest first, searchable, each with its series (a
    transaction in several series is listed once, with all of them) and account.
  - **Aggregates**: a row per period (newest first) with every series' value; a row's dropdown shows the
    transactions that made it. A formula series stands for the series it uses.
- [C] MCP: `chart_data` (with bucket, start, end overrides), `chart_transactions` (all, one period, or one series).

### Account history

- [C] Each account's transactions, paged, newest first by default (sort by date or amount, either way), with date
      range and text filters, the running total, and the source (file and row, manual, or generated).

## 4. Forecast

- [C] A forecast has a name, belongs to a project, and everything about it lives under that name. It runs after
      analysis and reads the analysis results. Clone, rename, delete.
- [C] **Frequency** `{n}{unit}`: `d` day, `w` week, `m` month, `q` quarter, `y` year (`1d`, `1w`, `6m`).
- [C] **Horizon**: a number of days or years (`90d`, `10y`), until a date, or until an age (from the birth date).
- [C] Charts and history as in analysis. **Include actuals** option: actuals are solid lines and normal rows;
      forecast values are dotted lines and greyed rows (or the reverse; one look applied everywhere).

### Forecast model (per account, editable)

From the analysis history over a lookback window (default 3 years), per account at the forecast frequency:

1. **Deflate**: divide each period's value by the inflation index of the account's category, giving real values.
2. **Trend**: linear regression of real values over time → real growth per year `g`.
3. **Seasonality**: with two or more years, a factor per month of the year `s(m)` (average of real ÷ trend).
4. **Spread**: the minimum and maximum per period are regressed separately, so the band can widen or narrow over
   time; `σ` is the spread of residuals.
5. **Replay**: recurring transactions (same rule and description, regular interval) are replayed at their own
   cadence into the future, with inflation; what is left over is modelled by steps 2 to 4.

Forecast value at time `t` (years from now), for period month `m`:

```
value(t) = replay(t) + base_real × (1 + g)^t × s(m) × (1 + i_category)^t  [+ noise within the min/max band]
```

- [C] Method per account: `replay+trend` (default), `trend`, `average`, `last`, `fixed`, `none`.
- [C] Parameters the user can change per forecast: inflation rate per category (and per account override), growth
      override, lookback, seasonality on/off, replay on/off, noise on/off with a seed (time, number or codeword, as
      Timeseries), caps.
- [C] Formulas the user can edit: per account, an expression in the chart expression language over the model terms
      giving the period's total; names: `value` (the model's value), `replay` (replayed transactions), `base`, `g`,
      `s`, `i`, `t` (years ahead), `age`, and other accounts' short codes (their model values), e.g.
      `replay + value * 1.05`. Each account also has an optional start and end (a date or `{ age }`), outside which
      it is 0 (e.g. salary ends at age 65).
- [C] **Generators** add to or take from an account's values: `random` (min, max, seed), `sine` (amplitude, period,
      phase, offset), `minimum` / `maximum` (a floor or cap on the account's value), `linear` (from a value to a
      value, or a slope per year), each with an optional start and end (date or age) and its own frequency.
- [C] Each forecast run writes `model.json` with the model terms found per account (shown on the Model tab), so the
      user can see why.

## 5. Documents

- [C] A **Documents** section (fifth in the navigation): any files the user keeps (statements, PDFs, scans), in
      folders, at `{tenant}/documents/` with `documents/$index.json` listing them (path, size, type, SHA-256, dates).
- [C] Drag and drop files or whole folders anywhere on the page (folders keep their structure below the current
      folder), or choose files (phones). Up to 25 MB each; over 3 MB they go straight to the bucket with a presigned
      URL. The same path again replaces a document.
- [C] Browse folders (breadcrumbs), search every document by path, new folder, download (a short-lived link), move or
      rename, delete (soft).
- [C] **Import from documents:** a statement (CSV, Excel, JSON) can be imported from Documents (into the datasource
      and importsource whose filename filter matches, or one the user picks) or from a datasource's Files tab
      ("From documents"). The document stays in Documents. MCP: `documents_list`, `document_upload(_url)`,
      `document_download`, `document_move`, `document_delete`, `document_import_candidates`, `document_import`.
- [C] `documents` is not allowed as a project or datasource id; `indexes_rebuild` also rebuilds the documents list
      (e.g. after files were copied in with `aws s3 cp`).

## Long-running jobs

- [C] Analysis and forecast runs (and big imports) are **jobs**: `POST` returns a job id at once; the web shows
      progress and can cancel.
- [C] A worker Lambda works in chunks and checkpoints to `jobs/{jobId}.json`; when less than 60 s of its time is
      left it saves and re-invokes itself (async) to carry on. Lambda timeout 5 minutes.
- [C] Limits (in config): at most 30 minutes and 20 invocations per job; one running job per project (DynamoDB
      lease); file uploads up to 10 MB and 200 000 rows; forecasts up to 100 years and 2 million points. A job past a
      limit stops with `ERR-JOB-LIMIT` and keeps what it had written as incomplete.

## Offline (local) mode

- [C] Everything runs on one machine without AWS: the API uses `data/` as its object store (the file store, as
      Timeseries' `fileObjectStore`), memory leases instead of DynamoDB, and runs jobs in-process with the same chunking
      and limits (no Lambda re-invoke).
- [C] `npm run dev` starts the local API (sign-in bypassed as a local owner user, bound to localhost only) and the web
      against it, so import, analysis, charts and forecasts all work offline.
- [C] Command line, no server needed: `npm run analyse -- <tenant> <project>`, `npm run forecast -- <tenant> <project>
      <forecast>`, `npm run import -- <tenant> <datasource> [files]`; they print progress and the job summary.
- [C] Sync between the bucket and `data/`: `npm run sync:pull -- dev <tenant>` copies a tenant down;
      `npm run sync:push -- dev <tenant>` copies local changes up (newer files only; asks before overwriting files that
      changed on both sides; never deletes remotely unless `--delete`). The indexes are rebuilt after a sync.
      *Not yet run against the bucket (it does not exist until the first deploy).*
- [C] The same analysis and forecast code runs in Lambda and locally (one `services/` implementation; only the store,
      lease and job runner differ), so local results match the cloud's.

## Web (mobile-first)

- [C] Every transaction list (history, chart history, aggregate drill-downs, unmatched, a datasource's and manual
      transactions, rule tests, the import preview) leads with the date as yyyy/mm/dd with the weekday greyed under
      it, then the description and its details, then the amount. On a phone the date and amount share the top line
      and the description and details go below. Long descriptions and details wrap onto the next line.
- [C] Wherever accounts are listed they show their category: dropdowns group accounts under category headings (a
      rule's account, Explore's Show, chart series, forecast generators); lists show it on the line under the name
      (Analysis overview, rules, the forecast model and account settings, accounts ticked for a chart series).
- [C] **Currencies:** a project has a default currency (NZD) and each account its own (the project's unless chosen);
      a datasource has the currency of its statements. Every transaction is shown with its account's currency (a
      datasource's own lists with the datasource's): dollar currencies with a prefix (NZ$, US$, A$, CA$, ...), others
      by code (EUR 12.00). A chart series has a currency when all its accounts share one. No conversion between
      currencies (yet).
- [C] Pop-ups (forms such as the rule editor) close only with their ✕ or when saved, never by a tap outside them.
- [C] Designed for a phone first: bottom navigation Import / Accounts / Analysis / Forecast, header with tenant and
      active project switcher, cards and lists rather than wide tables, mappings edited one target field at a time.
      Wider layouts on tablet and desktop.

## API and MCP

- [C] REST under `/v1/tenants/{tenant}/...` for every entity and action; `GET /v1/me` (user and tenants);
      `GET /v1/status`. Every operation is defined once in `src/handlers/operations.handler.js`, which makes both
      its REST route and its MCP tool.
- [ ] OpenAPI in `doc/openapi.yaml`; Bruno collection.
- [C] MCP at `/v1/mcp` with a tool for everything REST does (tenants, datasources, importsources, uploads,
      transactions, totals, projects, accounts, rules, analysis, charts, history, forecasts, jobs).

## Decided while building (2026-11-08)

- Uploads over 3 MB go straight to the bucket with a presigned URL (`POST .../upload-url`, then `POST .../files`
  with `uploadId`): a Lambda request takes about 6 MB and base64 adds a third. Smaller files are sent as base64;
  offline there is no presigning, so base64 is used for all sizes. The import sample of a CSV over 2 MB reads its
  first 2 MB.
- Balance adjustments go through the rules like any transaction (description `Balance adjustment`), so a rule can
  send them to an account; otherwise they land in Uncategorised.
- MCP sign-in: the client registers itself (stateless: its client id is a signed list of its redirect URIs), then
  signs in at the Cognito hosted login through the API's own app client; tokens are signed by the API (1 hour, 30-day
  refresh). Codes are signed, not stored, so a code can be reused within its 5 minutes; acceptable while the system
  has one user, to be replaced by stored single-use codes before others get access.
- The web keeps its sign-in on the device (localStorage), so a phone stays signed in for the refresh token's 30 days.
- One Lambda serves the API and the job worker (an event `{ job }` is a worker slice); API Gateway throttles at 20
  requests a second (burst 50). Lambda does not retry a failed slice; the job records the failure.
- Charts are drawn by the web's own SVG chart (no chart library): actuals solid, forecasts dotted.

## To decide

- See the `[?]` items above.
- Monitor checks for the API (`/v1/status`) and the web, like the other apps.
