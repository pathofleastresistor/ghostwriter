// Stand-in agents that follow a script, so the harness, the tools and the graders can be tested without a key.
import { noUsage } from "../runner/types.js";

export function scriptedModel(steps) {
  let i = 0;
  return {
    async complete() {
      const step = steps[i++];
      if (!step) return { content: [{ type: "text", text: "" }], stopReason: "end_turn", usage: noUsage() };
      if ("say" in step) return { content: [{ type: "text", text: step.say }], stopReason: "end_turn", usage: { ...noUsage(), inputTokens: 100, outputTokens: 20 } };
      return {
        content: [{ type: "tool_use", id: `toolu_${i}`, name: step.tool, input: step.input }],
        stopReason: "tool_use",
        usage: { ...noUsage(), inputTokens: 100, outputTokens: 20 },
      };
    },
  };
}

export const fixedJudge = (pass) => ({ async grade() { return { verdict: { pass, reason: "scripted verdict" }, usage: noUsage() }; } });
