import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
export const EVALS_DIR = join(here, "..");
export const APPROVED_DIR = join(EVALS_DIR, "approved");
export const PROPOSED_DIR = join(EVALS_DIR, "proposed");

/** What stops a scenario being run as an approved one. Empty means fine. */
export function approvalProblems(s) {
  const p = [];
  if (s.status !== "approved") p.push(`status is "${s.status}", not "approved"`);
  if (!s.review?.approvedBy) p.push("review.approvedBy is empty");
  if (!s.review?.approvedAt) p.push("review.approvedAt is empty");
  if (!s.title || /^todo/i.test(s.title)) p.push("title is still a TODO");
  if (!s.task || !s.task.trim()) p.push("task is empty");
  if (!Array.isArray(s.checks) || !s.checks.length) p.push("there are no checks");
  if ((s.checks ?? []).some((c) => c.status === "proposed")) p.push("some checks are still marked proposed");
  return p;
}

export function loadFile(path) {
  const s = JSON.parse(readFileSync(path, "utf8"));
  if (!s.id) s.id = basename(path, ".json");
  return s;
}

/** The scenarios a normal run uses. A file that claims to be approved but isn't complete stops the run, loudly. */
export function loadApproved(dir = APPROVED_DIR) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const s = loadFile(join(dir, f));
    const problems = approvalProblems(s);
    if (problems.length) throw new Error(`${f} is in approved/ but is not approved: ${problems.join("; ")}.`);
    out.push(s);
  }
  return out;
}
