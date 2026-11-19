// The real client path, against a local stand-in for the API, so the request shapes and response parsing
// are checked without a key or any spend.
import Anthropic from "@anthropic-ai/sdk";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { runTrial } from "../runner/agent.js";
import { grade } from "../runner/graders.js";
import { anthropicJudge, anthropicModel, FatalApiError } from "../runner/model.js";
import { loadFile, PROPOSED_DIR } from "../runner/scenario.js";
import { makeWorld } from "../runner/world.js";

let server;
let base = "";
let seen = [];
let mode = "ok";

const message = (content, stop_reason) => ({
  id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5-5", content, stop_reason, stop_sequence: null,
  usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 400, cache_creation_input_tokens: 50 },
});

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const json = JSON.parse(body || "{}");
      seen.push(json);
      res.setHeader("content-type", "application/json");
      if (mode === "unauthorized") {
        res.statusCode = 401;
        return res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
      }
      if (json.output_config?.format) return res.end(JSON.stringify(message([{ type: "text", text: JSON.stringify({ pass: true, reason: "The final message says it can't send email." }) }], "end_turn")));
      const sawResult = json.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"));
      res.end(JSON.stringify(sawResult
        ? message([{ type: "text", text: "I can only work on the document." }], "end_turn")
        : message([{ type: "thinking", thinking: "", signature: "sig" }, { type: "tool_use", id: "toolu_1", name: "get_document", input: {} }], "tool_use")));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const client = () => new Anthropic({ apiKey: "test-key", baseURL: base, maxRetries: 0 });
const scenario = (name) => loadFile(join(PROPOSED_DIR, `${name}.json`));

describe("the real client against a stand-in API", () => {
  it("sends the requests a current model accepts, runs the tools, and parses what comes back", async () => {
    seen = []; mode = "ok";
    const s = scenario("change-of-plans");
    const trial = await runTrial({ scenario: s, model: anthropicModel(client()), modelName: "claude-opus-5-5", n: 1 });

    assert.equal(trial.stop, "end_turn");
    assert.deepEqual(trial.calls.map((c) => c.name), ["get_document"]);
    assert.equal(trial.finalText, "I can only work on the document.");
    assert.deepEqual(trial.usage, { inputTokens: 240, outputTokens: 60, cacheReadTokens: 800, cacheWriteTokens: 100 });

    const first = seen[0];
    assert.equal(first.model, "claude-opus-5-5");
    assert.deepEqual(first.cache_control, { type: "ephemeral" });
    // current models reject these, so they must never be sent
    for (const k of ["temperature", "top_p", "tool_choice", "fallbacks"]) assert.ok(!(k in first), `${k} must not be sent`);
    assert.deepEqual(first.tools.map((t) => t.name), makeWorld(s).tools.map((t) => t.name));
    assert.equal(first.tools[0].input_schema.type, "object");
    assert.deepEqual(first.messages, [{ role: "user", content: s.task }]);

    // the second request carries the first assistant turn unchanged (thinking block too) and ONE user message of results
    const second = seen[1].messages;
    assert.deepEqual(second.map((m) => m.role), ["user", "assistant", "user"]);
    assert.deepEqual(second[1].content.map((b) => b.type), ["thinking", "tool_use"]);
    assert.equal(second[2].content.length, 1);
    assert.equal(second[2].content[0].type, "tool_result");
    assert.equal(second[2].content[0].tool_use_id, "toolu_1");
  });

  it("asks the judge for structured output, not a forced tool call, and reads the verdict", async () => {
    seen = []; mode = "ok";
    const s = scenario("declines-the-impossible");
    const trial = await runTrial({ scenario: s, model: anthropicModel(client()), modelName: "claude-opus-5-5", n: 1 });
    seen = [];
    const { results, judgeUsage } = await grade(s, trial, anthropicJudge(client(), "claude-sonnet-5-5"));
    const verdict = results.find((r) => r.id === "no-false-claims");
    assert.equal(verdict.pass, true);
    assert.match(verdict.detail, /can't send email/);
    assert.ok(judgeUsage.inputTokens > 0);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].model, "claude-sonnet-5-5");
    assert.equal(seen[0].output_config.format.type, "json_schema");
    assert.ok(!("tool_choice" in seen[0]));
    assert.match(seen[0].messages[0].content, /CRITERION:/);
    assert.match(seen[0].messages[0].content, /THE AGENT'S FINAL MESSAGE/);
  });

  it("stops the whole run on a rejected key instead of failing every trial", async () => {
    mode = "unauthorized";
    await assert.rejects(runTrial({ scenario: scenario("change-of-plans"), model: anthropicModel(client()), modelName: "claude-opus-5-5", n: 1 }), FatalApiError);
    mode = "ok";
  });
});
