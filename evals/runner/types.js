// The shapes the harness passes around, as JSDoc, so there is no build step. The model sits behind a
// small interface so everything else can be tested without a key, and a different provider could be swapped in.

/** @typedef {{ type: string, [key: string]: unknown }} Block */
/** @typedef {{ role: "user" | "assistant", content: string | Block[] }} Message */
/** @typedef {{ name: string, description: string, input_schema: Record<string, unknown> }} ToolSpec */
/** @typedef {{ inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number }} Usage */
/** @typedef {{ complete(req: { model: string, system: string, tools: ToolSpec[], messages: Message[], maxTokens: number }): Promise<{ content: Block[], stopReason: string, usage: Usage }> }} Model The agent under test. */
/** @typedef {{ pass: boolean, reason: string }} Verdict */
/** @typedef {{ grade(prompt: string): Promise<{ verdict: Verdict, usage: Usage }> }} Judge Grades one criterion against evidence. A different model from the agent, by default. */
/** @typedef {{ id: string, kind: "code" | "judge" | "human", description: string, args?: Record<string, unknown>, status?: string }} Check */
/** @typedef {{ id: string, status: "proposed" | "approved", title: string, task: string | null, memory?: string, facts?: Record<string, unknown>, start?: { doc?: unknown, patches?: Record<string, string>, selection?: { id: string, text: string }, setup?: { op: "edit", id: string, text: string }[] }, checks: Check[], source?: unknown, review: { approvedBy: string | null, approvedAt: string | null, comments?: string } }} Scenario */
/** @typedef {{ name: string, input: unknown, output?: string, error?: string, ms: number }} Call */
/** @typedef {"end_turn" | "max_turns" | "max_tokens" | "refusal" | "error"} Stop */
/** @typedef {{ scenarioId: string, model: string, n: number, stop: Stop, error?: string, finalText: string, turns: number, calls: Call[], usage: Usage, ms: number, toolsHash: string, start: Flat, end: Flat, startMarkdown: string, endMarkdown: string, messages: Message[] }} Trial */
/** @typedef {{ title: string, order: string[], texts: Record<string, string> }} Flat The document as flat text by id, so a before and after can be compared. */
/** @typedef {{ id: string, kind: string, description: string, pass: boolean | null, detail: string }} CheckResult */

export const noUsage = () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
export const addUsage = (a, b) => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
});
