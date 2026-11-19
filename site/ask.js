// "Ask AI": the message the editor sends to the conversation when the person clicks the button
// inside an MCP host. Claude accepts text only, at most 8,000 characters, no invisible characters,
// at most three line breaks in a row and 64 spaces in a row; it can refuse anything else. The
// message must also stand alone, because the person reads it and agrees to it before it runs.

export const MAX_MESSAGE = 8000;
const MAX_INSTRUCTION = 2000;
const MAX_SELECTION = 1500;

/** Remove what a host may refuse: invisible characters, long runs of blank lines and spaces. */
export function clean(text) {
  return String(text ?? "")
    .replace(/[­​-‏⁠﻿]/g, "")
    .replace(/[ \t]{65,}/g, " ")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

/** The message text, or null when there is nothing to send (no instruction). */
export function buildMessage({ instruction, id, title, selection }) {
  const ask = clean(instruction).slice(0, MAX_INSTRUCTION).trim();
  if (!ask) return null;
  const lines = [];
  lines.push(id ? `In my Ghostwriter document "${clean(title) || "Untitled document"}" (document_id: ${id}):` : "In Ghostwriter:");
  lines.push("");
  lines.push(ask);
  const sel = clean(selection).slice(0, MAX_SELECTION).trim();
  if (sel) {
    lines.push("");
    lines.push(`I have this text selected: ${JSON.stringify(sel)}`);
  }
  lines.push("");
  lines.push(id ? "Use the Ghostwriter tools to read and edit the document." : "Use the Ghostwriter tools (list_documents, then open_document or get_document).");
  return clean(lines.join("\n")).slice(0, MAX_MESSAGE);
}

/** Did the host fail because it has no ui/message at all (as opposed to a slow or refused one)? */
export function isUnsupported(e) {
  return e?.code === -32601 || /not supported|method not found|unknown method|unsupported/i.test(String(e?.message ?? e ?? ""));
}

/** What to tell the person after a send. Never claims the message was lost when the host did not answer. */
export function describeResult(result) {
  if (result === "accepted") return "Sent to the chat. You may need to allow it, or press Send there.";
  if (result === "unsupported") return "This chat can't take messages from the editor.";
  if (result === "refused") return "The chat didn't take that request. Try again in a moment.";
  return "No answer yet. Check the chat before sending again.";
}

/** Short starting points; each is a full instruction. */
export const SUGGESTIONS = [
  { label: "Tighten this", text: "Tighten the writing: cut filler and keep the meaning." },
  { label: "Continue", text: "Continue writing from where the document leaves off." },
  { label: "Proofread", text: "Proofread it and fix spelling and grammar, changing nothing else." },
];
