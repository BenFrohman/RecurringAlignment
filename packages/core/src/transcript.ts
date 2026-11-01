import { toAnchor } from "./state.js";
import type { Anchor, Role, Turn } from "./types.js";

const ROLES: Record<string, Role> = {
  user: "user",
  human: "user",
  me: "user",
  assistant: "assistant",
  ai: "assistant",
  bot: "assistant",
  grok: "assistant",
  system: "system",
};

function toTurn(v: unknown, i: number): Turn {
  const o = v as { role?: string; content?: unknown };
  const role = ROLES[String(o?.role ?? "").toLowerCase()];
  if (!role) throw new Error(`turn ${i}: unknown role "${String(o?.role)}"`);
  return { role, content: typeof o.content === "string" ? o.content : JSON.stringify(o.content ?? "") };
}

/**
 * Parse a transcript in any of these formats:
 * - JSON: `{ "anchor": {...}, "turns": [...] }`, `{ "messages": [...] }`, or a bare `Turn[]`
 * - JSONL: one `{role, content}` per line
 * - Markdown/text: lines starting with `User:` / `Assistant:` (or `## User`, `**User:**`)
 */
export function parseTranscript(text: string): { anchor?: Anchor; turns: Turn[] } {
  const t = text.trim();
  if (!t) return { turns: [] };
  if (t.startsWith("[") || t.startsWith("{")) {
    try {
      const j = JSON.parse(t) as unknown;
      if (Array.isArray(j)) return { turns: j.map(toTurn) };
      const o = j as { anchor?: unknown; turns?: unknown[]; messages?: unknown[] };
      return {
        ...(o.anchor ? { anchor: toAnchor(o.anchor) } : {}),
        turns: (o.turns ?? o.messages ?? []).map(toTurn),
      };
    } catch (e) {
      if (!t.startsWith("{") || !t.includes("\n")) throw e;
      return {
        turns: t
          .split(/\r?\n/)
          .filter((l) => l.trim())
          .map((l, i) => toTurn(JSON.parse(l), i)),
      };
    }
  }
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  const head = new RegExp(
    `^\\s*(?:#+\\s*|\\*\\*|>\\s*)?(${Object.keys(ROLES).join("|")})\\s*(?:\\*\\*)?\\s*:?\\s*(?:\\*\\*)?\\s*(.*)$`,
    "i",
  );
  for (const line of t.split(/\r?\n/)) {
    const m = line.match(head);
    if (m && (line.includes(":") || /^\s*#/.test(line))) {
      cur = { role: ROLES[m[1]!.toLowerCase()]!, content: m[2] ?? "" };
      turns.push(cur);
    } else if (cur) cur.content += (cur.content ? "\n" : "") + line;
  }
  for (const x of turns) x.content = x.content.trim();
  return { turns };
}
