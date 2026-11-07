import { getJson, putJson } from "../lib/json.js";
import { balanceAdjustments } from "../lib/balance.js";
import { createCategoriser } from "../lib/rules.js";

const ACCOUNTS_PER_STEP = 25;

// Analysis: the project's datasources (imported, manual, and balance adjustments from totals) through the rules
// into accounts, with running totals and monthly/quarterly/yearly aggregates. It rebuilds from scratch, so it is
// repeatable. Steps: one per datasource (categorise), then accounts in batches (write), then finish.
export default function createAnalysisService({ store, workspaceService, importService, projectService, resultsService, clock = () => new Date() }) {
  const SCOPE = "analysis";

  async function categorisedTransactions(tenant, projectId, datasource, rules) {
    const categorise = createCategoriser(rules);
    const transactions = await importService.datasourceTransactions(tenant, datasource);
    const totals = (await importService.totals.list(tenant, datasource)).map((total) => ({ ...total, datasource }));
    return [...transactions, ...balanceAdjustments(transactions, totals)].map((tx) => {
      const { account, rule } = categorise(tx);
      return { date: tx.date, description: tx.description, amount: tx.amount, bankAccount: tx.account, datasource: tx.datasource, source: tx.source, filename: tx.filename, fileId: tx.fileId, row: tx.row, manualId: tx.manualId, totalId: tx.totalId, rule, target: account };
    });
  }

  const handler = {
    async plan(job) {
      const project = await workspaceService.get(job.tenant, "project", job.project);
      job.state = { phase: "load", datasources: project.datasources, index: 0, written: [], accounts: [], counts: {}, warnings: [] };
      if (!project.datasources.length) job.state.warnings.push("the project has no datasources");
      job.progress = { message: "starting", done: 0, total: project.datasources.length };
    },
    async step(job, ctx) {
      const state = job.state;
      if (state.phase === "load") {
        if (state.index < state.datasources.length) {
          const datasource = state.datasources[state.index];
          const rules = await projectService.rules.all(job.tenant, job.project);
          const rows = await categorisedTransactions(job.tenant, job.project, datasource, rules);
          await putJson(store, ctx.workKey(`ds-${state.index}`), rows);
          state.counts[datasource] = rows.length;
          state.index += 1;
          ctx.progress(`read ${datasource}`, state.index, state.datasources.length);
          return false;
        }
        state.phase = "write";
        state.accounts = (await projectService.accounts.list(job.tenant, job.project)).map((account) => account.id);
        state.index = 0;
        return false;
      }
      if (state.phase === "write") {
        const all = [];
        for (let i = 0; i < state.datasources.length; i += 1) all.push(...await getJson(store, ctx.workKey(`ds-${i}`)));
        const known = new Set(state.accounts);
        const batch = state.accounts.slice(state.index, state.index + ACCOUNTS_PER_STEP);
        // A rule's account that was deleted since: its transactions go to Uncategorised.
        for (const tx of all) if (!known.has(tx.target)) tx.target = "uncategorised";
        for (const account of batch) {
          const list = all.filter((tx) => tx.target === account).map((tx, seq) => ({ ...tx, seq, kind: "actual" }));
          const { written } = await resultsService.writeAccount(job.tenant, job.project, SCOPE, account, list);
          state.written.push(...written);
        }
        state.index += batch.length;
        ctx.progress("writing accounts", state.index, state.accounts.length);
        if (state.index >= state.accounts.length) state.phase = "finish";
        return false;
      }
      const removed = await resultsService.removeStale(job.tenant, job.project, SCOPE, state.written);
      let lastDate = null;
      const accounts = [];
      for (const account of state.accounts) {
        const aggregates = await resultsService.aggregates(job.tenant, job.project, SCOPE, account);
        accounts.push({ id: account, ...aggregates.total });
        if (aggregates.total.last && (!lastDate || aggregates.total.last > lastDate)) lastDate = aggregates.total.last;
      }
      await resultsService.writeMeta(job.tenant, job.project, SCOPE, { status: "complete", jobId: job.id, startedAt: job.startedAt, finishedAt: clock().toISOString(), datasources: state.counts, accounts, lastDate, removed, warnings: state.warnings });
      ctx.progress("complete", state.accounts.length, state.accounts.length);
      return true;
    }
  };

  return { handler, categorisedTransactions, meta: (tenant, project) => resultsService.meta(tenant, project, SCOPE) };
}
