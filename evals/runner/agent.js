// Runs one agent through one scenario against the real tools, and records what happened.
import { toolSurface, makeWorld, flatten } from "./world.js";
import { addUsage, noUsage } from "./types.js";

export const MAX_TURNS = 24;
export const MAX_TOKENS = 16_000;

/** The agent under test is told as little as a person's own agent would be: who it works for, and that the page gave it tools. */
export function systemPrompt(s) {
  const memory = s.memory ? `\n\nWhat you already know about this person, from earlier conversations:\n${s.memory}` : "";
  return (
    "You are an AI assistant working for the person you are talking to. They have a document open in a web page, and the page has given you some tools. " +
    "Use them to do what they ask, then tell them what you did." +
    memory
  );
}

const textOf = (blocks) => blocks.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("\n").trim();

export async function runTrial({ scenario, model, modelName, n, maxTurns, maxTokens }) {
  const began = Date.now();
  const world = makeWorld(scenario);
  const { tools } = world;
  const specs = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  const messages = [{ role: "user", content: scenario.task ?? "" }];
  const calls = [];
  let usage = noUsage();
  let stop = "max_turns";
  let error;
  let finalText = "";
  let turns = 0;

  try {
    while (turns < (maxTurns ?? MAX_TURNS)) {
      turns++;
      const res = await model.complete({ model: modelName, system: systemPrompt(scenario), tools: specs, messages, maxTokens: maxTokens ?? MAX_TOKENS });
      usage = addUsage(usage, res.usage);
      // The assistant turn goes back exactly as it came, thinking blocks included.
      messages.push({ role: "assistant", content: res.content });
      finalText = textOf(res.content) || finalText;

      if (res.stopReason === "refusal") { stop = "refusal"; break; }
      if (res.stopReason === "max_tokens") { stop = "max_tokens"; break; }
      if (res.stopReason === "pause_turn") continue;
      if (res.stopReason !== "tool_use") { stop = "end_turn"; break; }

      // All of a turn's tool results go back in one message.
      const results = [];
      for (const use of res.content.filter((b) => b.type === "tool_use")) {
        const t0 = Date.now();
        const call = { name: String(use.name), input: use.input, ms: 0 };
        const tool = tools.find((t) => t.name === use.name);
        if (!tool) {
          call.error = `Unknown tool: ${use.name}. The tools you have are ${tools.map((t) => t.name).join(", ")}.`;
          results.push({ type: "tool_result", tool_use_id: use.id, content: call.error, is_error: true });
        } else {
          // An agent sees what a page's tool returns: the text content. That is all this passes back.
          const out = await tool.run(use.input ?? {});
          const text = (out.content ?? []).map((c) => c.text ?? "").join("\n");
          call.output = text;
          if (out.isError) call.error = text;
          results.push({ type: "tool_result", tool_use_id: use.id, content: text, ...(out.isError ? { is_error: true } : {}) });
        }
        call.ms = Date.now() - t0;
        calls.push(call);
      }
      messages.push({ role: "user", content: results });
    }
  } catch (e) {
    if (e?.name === "FatalApiError") throw e;
    stop = "error";
    error = e?.message ?? String(e);
  }

  return {
    scenarioId: scenario.id, model: modelName, n, stop, error, finalText, turns, calls, usage,
    ms: Date.now() - began,
    toolsHash: toolSurface(tools).hash,
    start: world.start,
    end: flatten(world.doc),
    startMarkdown: world.startMarkdown,
    endMarkdown: world.doc.toMarkdown(),
    messages,
  };
}
