import { estimateCost } from "./pricing.js";
import { addUsage, noUsage } from "./types.js";

/** A trial is good when it finished normally and every graded check passed. */
export const trialOk = (t, results) => t.stop === "end_turn" && results.every((r) => r.pass !== false);

export function summarise(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.trial.scenarioId}\u0000${r.trial.model}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.values()].map((g) => {
    const checks = new Map();
    const stops = {};
    let usage = noUsage();
    let judgeUsage = noUsage();
    for (const { trial, results, judgeUsage: ju } of g) {
      stops[trial.stop] = (stops[trial.stop] ?? 0) + 1;
      usage = addUsage(usage, trial.usage);
      judgeUsage = addUsage(judgeUsage, ju);
      for (const r of results) {
        const c = checks.get(r.id) ?? { id: r.id, kind: r.kind, passed: 0, graded: 0, failures: [] };
        if (r.pass !== null) {
          c.graded++;
          if (r.pass) c.passed++;
          else if (!c.failures.includes(r.detail)) c.failures.push(r.detail);
        }
        checks.set(r.id, c);
      }
    }
    return { scenarioId: g[0].trial.scenarioId, model: g[0].trial.model, trials: g.length, ok: g.filter((r) => r.ok).length, stops, checks: [...checks.values()], usage, judgeUsage };
  });
}

const money = (n) => (n === undefined ? "n/a" : `$${n.toFixed(2)}`);

export function printReport(summaries, judgeModel) {
  let spend = 0;
  let known = true;
  for (const s of summaries) {
    console.log(`\n${s.scenarioId}  ·  ${s.model}  ·  ${s.ok}/${s.trials} trials fully passed`);
    const odd = Object.entries(s.stops).filter(([k]) => k !== "end_turn");
    if (odd.length) console.log(`  did not finish normally: ${odd.map(([k, v]) => `${v} ${k}`).join(", ")}`);
    for (const c of s.checks) {
      if (c.graded === 0) { console.log(`  ·  ${c.id.padEnd(24)} ${c.kind}: not graded`); continue; }
      console.log(`  ${c.passed === c.graded ? "✓" : "✗"}  ${c.id.padEnd(24)} ${c.passed}/${c.graded}${c.failures.length ? `   ${c.failures[0]}` : ""}`);
    }
    const a = estimateCost(s.model, s.usage);
    const j = judgeModel ? estimateCost(judgeModel, s.judgeUsage) : 0;
    if (a === undefined || j === undefined) known = false;
    else spend += a + j;
  }
  const t = summaries.reduce((u, s) => addUsage(u, s.usage), noUsage());
  console.log(`\nagent tokens: ${t.inputTokens} in (+${t.cacheReadTokens} cached), ${t.outputTokens} out  ·  estimated cost ${known ? money(spend) : "n/a for some models"} (list prices, not a bill)`);
}
