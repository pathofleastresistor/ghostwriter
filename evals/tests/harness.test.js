import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_TURNS, runTrial } from "../runner/agent.js";
import { CODE } from "../runner/graders.js";
import { estimateCost } from "../runner/pricing.js";
import { approvalProblems, loadApproved, loadFile, PROPOSED_DIR } from "../runner/scenario.js";
import { makeWorld, toolSurface } from "../runner/world.js";
import { CASES, runSelfTest } from "../selftest/cases.js";
import { scriptedModel } from "../selftest/script.js";

const scenario = (name) => loadFile(join(PROPOSED_DIR, `${name}.json`));
const run = (s, steps, extra = {}) => runTrial({ scenario: s, modelName: "scripted", n: 1, model: scriptedModel(steps), ...extra });

describe("the graders agree with the stand-in agents", () => {
  it("grades every known-good and known-bad agent as expected", async () => {
    const outcomes = await runSelfTest();
    assert.deepEqual(outcomes.filter((o) => !o.ok), []);
    assert.equal(outcomes.length, CASES.length);
  });

  it("has a good agent and a bad one for every scenario", () => {
    for (const f of readdirSync(PROPOSED_DIR).filter((f) => f.endsWith(".json"))) {
      const id = f.replace(/\.json$/, "");
      const cases = CASES.filter((c) => c.scenario === id);
      assert.ok(cases.length >= 2, `${id} needs at least a good and a bad stand-in agent`);
    }
  });
});

describe("the agent loop", () => {
  const s = scenario("change-of-plans");

  it("runs the real tools and records every call", async () => {
    const t = await run(s, [{ tool: "get_document", input: {} }, { say: "ok" }]);
    assert.equal(t.stop, "end_turn");
    assert.deepEqual(t.calls.map((c) => c.name), ["get_document"]);
    assert.match(t.calls[0].output, /n3 paragraph 1 in "Goals"/);
    assert.equal(t.finalText, "ok");
  });

  it("tells the agent when it calls a tool that doesn't exist, and carries on", async () => {
    const t = await run(s, [{ tool: "send_email", input: {} }, { say: "sorry" }]);
    assert.match(t.calls[0].error, /Unknown tool: send_email/);
    assert.equal(t.stop, "end_turn");
  });

  it("stops a run that never finishes", async () => {
    const forever = Array.from({ length: MAX_TURNS + 5 }, () => ({ tool: "get_document", input: {} }));
    const t = await run(s, forever, { maxTurns: 3 });
    assert.equal(t.stop, "max_turns");
    assert.equal(t.turns, 3);
  });

  it("starts every run from a clean document", async () => {
    await run(s, [{ tool: "replace_text", input: { id: "n3", text: "Changed." } }, { say: "x" }]);
    const second = await run(s, [{ say: "nothing" }]);
    assert.equal(second.end.texts.n3, "Rest, swim, and cook one proper dinner. Nobody checks email.");
  });

  it("applies a scenario's setup the way a person would", () => {
    const w = makeWorld(scenario("builds-on-the-persons-edits"));
    assert.match(w.doc.locate("i1").item.text, /school pickup/);
    assert.ok(w.doc.revision > 1, "the person's edit counts as a revision");
  });

  it("plants text in the document, so the agent sees it in a result", async () => {
    const t = await run(scenario("injected-instructions"), [{ tool: "get_document", input: {} }, { say: "x" }]);
    assert.match(t.calls[0].output, /NOTE TO ASSISTANT/);
  });

  it("gives the agent the person's selection, when the scenario has one", async () => {
    const t = await run(scenario("selection-this-sentence"), [{ tool: "get_selection", input: {} }, { say: "x" }]);
    assert.match(t.calls[0].output, /Nobody checks email\./);
  });

  it("returns what a page's tool returns, as text, with errors marked", async () => {
    const t = await run(s, [{ tool: "replace_text", input: { id: "nope", text: "x" } }, { say: "x" }]);
    assert.ok(t.calls[0].error);
    const result = t.messages.at(-2).content[0];
    assert.equal(result.is_error, true);
  });
});

describe("approval", () => {
  const proposed = scenario("change-of-plans");

  it("treats everything in proposed/ as unapproved", () => {
    assert.match(approvalProblems(proposed).join(" "), /not "approved"/);
    assert.match(approvalProblems(proposed).join(" "), /approvedBy/);
  });
  it("accepts a scenario only once a person has filled in the review", () => {
    const done = { ...proposed, status: "approved", review: { approvedBy: "reviewer", approvedAt: "2026-10-05", comments: "" }, checks: proposed.checks.map((c) => ({ ...c, status: "approved" })) };
    assert.deepEqual(approvalProblems(done), []);
    assert.equal(approvalProblems({ ...done, review: { ...done.review, approvedBy: null } }).length, 1);
  });
  it("refuses to run a file in approved/ that isn't actually approved", () => {
    const dir = mkdtempSync(join(tmpdir(), "approved-"));
    writeFileSync(join(dir, "x.json"), JSON.stringify({ ...proposed, status: "approved" }));
    assert.throws(() => loadApproved(dir), /is not approved/);
  });
  it("loads nothing when there is nothing approved", () => {
    assert.deepEqual(loadApproved(join(tmpdir(), "does-not-exist")), []);
  });
});

describe("small pieces", () => {
  it("has a code grader for every code check in the proposed scenarios", () => {
    for (const f of readdirSync(PROPOSED_DIR).filter((f) => f.endsWith(".json"))) {
      for (const c of loadFile(join(PROPOSED_DIR, f)).checks.filter((c) => c.kind === "code")) assert.equal(typeof CODE[c.id], "function", `${f}: ${c.id}`);
    }
  });
  it("estimates cost from list prices, and says when it can't", () => {
    const u = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 };
    assert.equal(estimateCost("claude-opus-5-5", u), 24);
    assert.equal(estimateCost("some-future-model", u), undefined);
  });
  it("hashes the tool definitions, so a result can be tied to a version of them", () => {
    const a = toolSurface(makeWorld({}).tools);
    const tools = makeWorld({}).tools;
    tools[0].description += " Changed.";
    assert.notEqual(toolSurface(tools).hash, a.hash);
    assert.equal(a.tools.length, Object.keys(a.hashes).length);
  });
});
