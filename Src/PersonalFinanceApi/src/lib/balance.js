// Totals are the source of truth: per bank account, in date order, when the transactions up to a total's date
// don't add up to its balance, a generated "Balance adjustment" transaction on that date makes up the difference.
// They are made afresh on every analysis, so regenerating never loses a total.
export function balanceAdjustments(transactions, totals) {
  const adjustments = [];
  const byAccount = new Map();
  for (const tx of transactions) { if (!byAccount.has(tx.account)) byAccount.set(tx.account, []); byAccount.get(tx.account).push(tx); }
  const totalsByAccount = new Map();
  for (const total of totals) { if (!totalsByAccount.has(total.account)) totalsByAccount.set(total.account, []); totalsByAccount.get(total.account).push(total); }
  for (const [account, list] of totalsByAccount) {
    const txs = (byAccount.get(account) || []).slice().sort((a, b) => a.date.localeCompare(b.date));
    const sorted = list.slice().sort((a, b) => a.date.localeCompare(b.date));
    let running = 0;
    let i = 0;
    for (const total of sorted) {
      while (i < txs.length && txs[i].date <= total.date) { running = Math.round((running + txs[i].amount) * 100) / 100; i += 1; }
      const difference = Math.round((total.balance - running) * 100) / 100;
      if (Math.abs(difference) >= 0.01) {
        adjustments.push({ date: total.date, account, description: "Balance adjustment", amount: difference, source: "generated", totalId: total.id, datasource: total.datasource });
        running = total.balance;
      }
    }
  }
  return adjustments;
}
