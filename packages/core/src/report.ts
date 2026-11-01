import type { SessionReport } from "./types.js";

const BAR = (s: number) => "█".repeat(Math.round(s * 10)).padEnd(10, "░");

/** Render a SessionReport as a readable Markdown summary. */
export function formatMarkdown(r: SessionReport, title = "Drift report"): string {
  const out = [`# ${title}`, ""];
  out.push(
    `- Assistant turns: **${r.assistantTurns}**`,
    `- Drift points: **${r.driftPoints.length}**${r.driftPoints.length ? ` (turns ${r.driftPoints.join(", ")})` : ""}`,
    `- Max score: **${r.maxScore}**, mean: **${r.meanScore}**`,
    "",
    "| Turn | Score | Severity | Reasons |",
    "| ---: | :---- | :------- | :------ |",
  );
  for (const t of r.turns.filter((x) => x.role === "assistant")) {
    const why = t.reasons.filter((x) => x.contribution > 0).map((x) => x.detail.replace(/\|/g, "\\|"));
    out.push(`| ${t.index} | \`${BAR(t.score)}\` ${t.score} | ${t.severity} | ${why.join("; ") || "-"} |`);
  }
  const kinds = Object.entries(r.byKind).filter(([, n]) => n > 0);
  if (kinds.length) out.push("", "## Drift by kind", "", ...kinds.map(([k, n]) => `- ${k}: ${n}`));
  if (r.realignment) out.push("", "## Suggested realignment", "", "```", r.realignment, "```");
  return out.join("\n") + "\n";
}
