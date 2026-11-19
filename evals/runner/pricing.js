/** USD per million tokens: input, output. From list prices cached on 2026-09-25, so an estimate, not a bill. */
const PRICES = {
  "claude-fable-5-1": [10, 50],
  "claude-fable-5": [10, 50],
  "claude-opus-5-5": [4, 20],
  "claude-opus-5": [5, 25],
  "claude-opus-4-8": [5, 25],
  "claude-sonnet-5-5": [2, 10],
  "claude-sonnet-5": [2, 10],
  "claude-sonnet-4-6": [3, 15],
  "claude-haiku-4-5": [1, 5],
};

/** Cache reads cost a tenth of input; cache writes (5 minute) 1.25 times. Undefined for a model not in the table. */
export function estimateCost(model, u) {
  const p = PRICES[model];
  if (!p) return undefined;
  return (u.inputTokens * p[0] + u.cacheReadTokens * p[0] * 0.1 + u.cacheWriteTokens * p[0] * 1.25 + u.outputTokens * p[1]) / 1_000_000;
}
