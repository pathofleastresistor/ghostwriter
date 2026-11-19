// Runs the approved scenarios against a real model and grades them.
//   npm run evals -- --model claude-opus-5-5 --trials 3
//   npm run evals:selftest                 (no key: scripted agents, checks the harness and graders)
// See evals/README.md.
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeWorld, toolSurface } from "./runner/world.js";
import { runTrial } from "./runner/agent.js";
import { grade } from "./runner/graders.js";
import { anthropicJudge, anthropicModel, DEFAULT_AGENT_MODEL, DEFAULT_JUDGE_MODEL, FatalApiError, makeClient } from "./runner/model.js";
import { printReport, summarise, trialOk } from "./runner/report.js";
import { EVALS_DIR, loadApproved, loadFile } from "./runner/scenario.js";
import { runSelfTest } from "./selftest/cases.js";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const LARGE = 12;

async function main() {
  if (flag("help") || flag("h")) {
    console.log(`Usage: npm run evals -- [options]
  --model a,b       agent models to test (default ${DEFAULT_AGENT_MODEL}); several makes a matrix
  --judge-model m   model that grades the judge checks (default ${DEFAULT_JUDGE_MODEL})
  --trials n        runs per scenario and model (default 3)
  --scenario ids    only these scenario ids (comma separated)
  --file path       run one scenario file directly, approved or not (marked UNAPPROVED)
  --max-turns n     model calls per run before giving up (default 24)
  --min-pass x      exit non-zero if any check passes less often than this (default 0.8)
  --yes             allow more than ${LARGE} runs
  --list            show the approved scenarios and stop
  --selftest        run the scripted agents (no key, no cost) and stop`);
    return;
  }

  if (flag("selftest")) {
    const out = await runSelfTest();
    for (const o of out) console.log(`${o.ok ? "✓" : "✗"}  ${o.name}${o.ok ? "" : `\n     ${o.problems.join("\n     ")}`}`);
    const bad = out.filter((o) => !o.ok).length;
    console.log(`\n${out.length - bad}/${out.length} stand-in agents graded as expected`);
    process.exitCode = bad ? 1 : 0;
    return;
  }

  let scenarios;
  const file = opt("file");
  if (file) {
    scenarios = [loadFile(file)];
    console.warn(`UNAPPROVED: running ${file} directly. Its results are not part of the approved suite.`);
  } else {
    scenarios = loadApproved();
    const only = opt("scenario")?.split(",");
    if (only) scenarios = scenarios.filter((s) => only.includes(s.id));
  }
  if (flag("list")) {
    scenarios.forEach((s) => console.log(`${s.id}  ·  ${s.title}  ·  ${s.checks.length} checks  ·  approved by ${s.review.approvedBy}`));
    if (!scenarios.length) console.log("No approved scenarios yet. See evals/README.md.");
    return;
  }
  if (!scenarios.length) {
    console.error("No approved scenarios to run. Approve some (see evals/README.md), or try one with --file evals/proposed/<id>.json");
    process.exitCode = 1;
    return;
  }

  const models = (opt("model") ?? DEFAULT_AGENT_MODEL).split(",");
  const judgeModel = opt("judge-model") ?? DEFAULT_JUDGE_MODEL;
  const trials = Number(opt("trials") ?? 3);
  const maxTurns = opt("max-turns") ? Number(opt("max-turns")) : undefined;
  const minPass = Number(opt("min-pass") ?? 0.8);
  const runs = scenarios.length * models.length * trials;
  console.log(`${scenarios.length} scenarios × ${models.length} model(s) × ${trials} trials = ${runs} agent runs, each up to ${maxTurns ?? 24} model calls. Judge: ${judgeModel}.`);
  if (runs > LARGE && !flag("yes")) {
    console.error(`That is more than ${LARGE} runs and it costs real money. Re-run with --yes, or narrow it with --scenario / --trials.`);
    process.exitCode = 1;
    return;
  }

  const client = makeClient();
  const judge = anthropicJudge(client, judgeModel);
  const rows = [];
  for (const s of scenarios)
    for (const modelName of models)
      for (let n = 1; n <= trials; n++) {
        process.stdout.write(`  ${s.id} · ${modelName} · ${n}/${trials} ... `);
        const trial = await runTrial({ scenario: s, model: anthropicModel(client), modelName, n, maxTurns });
        const { results, judgeUsage } = await grade(s, trial, judge);
        const ok = trialOk(trial, results);
        rows.push({ trial, results, judgeUsage, ok });
        console.log(`${ok ? "ok" : "FAILED"} (${trial.stop}, ${trial.calls.length} tool calls, ${Math.round(trial.ms / 1000)}s)`);
      }

  const summaries = summarise(rows);
  printReport(summaries, judgeModel);

  let build = "unknown";
  try { build = execSync("git rev-parse --short HEAD", { cwd: EVALS_DIR }).toString().trim(); } catch { /* not a git checkout */ }
  const dir = join(EVALS_DIR, "results");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  const hash = toolSurface(makeWorld(scenarios[0]).tools).hash;
  writeFileSync(path, JSON.stringify({ startedAt: new Date().toISOString(), build, toolsHash: hash, models, judgeModel, trials, unapproved: !!file, summaries, rows }, null, 2));
  console.log(`\nfull transcripts: ${path}`);

  const weak = summaries.flatMap((s) => s.checks.filter((c) => c.graded && c.passed / c.graded < minPass).map((c) => `${s.scenarioId}/${c.id}`));
  if (weak.length || rows.some((r) => r.trial.stop === "error")) {
    console.error(`\nBelow ${minPass} or errored: ${weak.join(", ") || "(trial errors)"}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e instanceof FatalApiError ? `\n${e.message}` : e);
  process.exitCode = 1;
});
