import {
  AlignmentMonitor,
  TfIdf,
  constraintText,
  cosine,
  tokenize,
  type Anchor,
  type Constraint,
  type PartialConfig,
  type Turn,
  type TurnReport,
} from "@recurring-alignment/core";

/** Everything a fresh session needs to pick up where the on-track conversation left off. */
export interface CleanState {
  goals: string[];
  persona?: string;
  constraints: Constraint[];
  /** Anchor decisions plus ones the user stated during the session, minus ones the user later reversed. */
  decisions: string[];
  /** Most goal-relevant sentences from on-track turns. */
  keyFacts: string[];
  /** User requests that were not answered by an on-track reply. */
  openTasks: string[];
  /** Last few on-track turns, verbatim (trimmed), for conversational continuity. */
  recentTurns: Turn[];
}

export interface TokenEstimate {
  before: number;
  after: number;
  saved: number;
  /** after / before */
  ratio: number;
}

export interface ReplayResult {
  /** Index of the turn where drift began (start of the drift run), or null if never drifted. */
  driftStart: number | null;
  /** Indices of the first fully drifted turn per drift run. */
  driftPoints: number[];
  kept: number[];
  dropped: { index: number; why: "drift" | "noise" }[];
  reports: TurnReport[];
  clean: CleanState;
  tokens: TokenEstimate;
}

export interface ReplayOptions {
  config?: PartialConfig;
  maxFacts?: number;
  recentTurns?: number;
  /** Chars per recent-turn excerpt. Default 400. */
  excerptChars?: number;
  /** Token estimator. Default: ceil(chars / 4), a standard rough estimate for English. */
  estimateTokens?: (text: string) => number;
}

export const estimateTokens = (s: string): number => Math.ceil(s.length / 4);

const NOISE = /^(ok(ay)?|k|thanks?( you)?|thx|ty|cool|nice|great|lol|haha+|yes|yep|no|sure|👍)[.! ]*$/i;
const TASK =
  /\?|\b(please|can you|could you|need to|todo|next|add|make|build|write|fix|create|implement|help)\b/i;
const REVERSE_DECISION = /\b(scrap|undo|revert|forget|no longer|don'?t|cancel|drop)\b/i;

function sentences(s: string): string[] {
  return s
    .split(/(?<=[.!?])\s+|\n+/)
    .map((x) => x.trim())
    .filter((x) => tokenize(x).length >= 3);
}

/**
 * Drift Replay. Scores the transcript, finds where drift began, drops drifted and noisy
 * turns, and distils the rest into a compact clean state you can resume from.
 */
export async function replay(anchor: Anchor, turns: Turn[], opts: ReplayOptions = {}): Promise<ReplayResult> {
  const est = opts.estimateTokens ?? estimateTokens;
  const monitor = new AlignmentMonitor(anchor, opts.config);
  const reports = await monitor.addTurns(turns);
  const low = monitor.config.severity.low;

  // Drift runs: a drifted assistant turn, extended backwards over immediately-preceding
  // assistant turns that already showed warning-level drift (the "slide" into drift).
  const assistant = reports.filter((r) => r.role === "assistant");
  const dropped = new Map<number, "drift" | "noise">();
  const driftPoints: number[] = [];
  let driftStart: number | null = null;
  assistant.forEach((r, ai) => {
    if (!r.drifted) return;
    const prev = assistant[ai - 1];
    if (!prev?.drifted) driftPoints.push(r.index);
    let start = ai;
    while (start > 0 && assistant[start - 1]!.score >= low && !assistant[start - 1]!.drifted) start--;
    for (let k = start; k <= ai; k++) dropped.set(assistant[k]!.index, "drift");
    driftStart ??= assistant[start]!.index;
  });
  turns.forEach((t, i) => {
    if (!dropped.has(i) && (NOISE.test(t.content.trim()) || !t.content.trim())) dropped.set(i, "noise");
  });
  const kept = turns.map((_, i) => i).filter((i) => !dropped.has(i));

  // Decisions: anchor + auto-recorded, minus ones a later user turn explicitly reversed.
  const decisions = monitor.anchor.decisions.filter((d) => {
    const dt = new Set(tokenize(d));
    return !turns.some(
      (t) =>
        t.role === "user" &&
        REVERSE_DECISION.test(t.content) &&
        tokenize(t.content).filter((x) => dt.has(x)).length / Math.max(1, dt.size) >= 0.5,
    );
  });

  const n = opts.recentTurns ?? 4;
  const recent = n > 0 ? kept.slice(-n) : [];
  const recentIdx = new Set(recent);
  // Key facts: sentences from kept turns ranked by TF-IDF cosine to the goals (+ recency tiebreak).
  const goalToks = tokenize(anchor.goals.join(" "));
  const cands = kept
    .filter((i) => !recentIdx.has(i))
    .flatMap((i) => sentences(turns[i]!.content).map((s) => ({ s, i, toks: tokenize(s) })));
  const idf = new TfIdf([goalToks, ...cands.map((c) => c.toks)]);
  const gv = idf.vector(goalToks);
  const ranked = cands
    .map((c) => ({ ...c, rel: goalToks.length ? cosine(idf.vector(c.toks), gv) : 0.5 }))
    .filter((c) => c.rel > 0 || !goalToks.length)
    .sort((a, b) => b.rel - a.rel || b.i - a.i);
  const keyFacts: string[] = [];
  const seenToks: Set<string>[] = [];
  for (const c of ranked) {
    if (keyFacts.length >= (opts.maxFacts ?? 6)) break;
    const ts = new Set(c.toks);
    const dup = seenToks.some(
      (o) => [...ts].filter((x) => o.has(x)).length / Math.min(ts.size, o.size) > 0.7,
    );
    if (!dup && !decisions.some((d) => c.s.toLowerCase().includes(d.toLowerCase()))) {
      keyFacts.push(c.s);
      seenToks.push(ts);
    }
  }

  // Open tasks: user requests with no on-track assistant reply after them.
  const lastGoodReply = Math.max(-1, ...kept.filter((i) => turns[i]!.role === "assistant"));
  const openTasks = kept
    .filter((i) => turns[i]!.role === "user" && TASK.test(turns[i]!.content))
    .filter(
      (i) =>
        i > lastGoodReply ||
        reports.slice(i + 1).every((r) => r.role !== "assistant" || dropped.has(r.index)),
    )
    .map((i) => turns[i]!.content.trim().replace(/\s+/g, " "));

  const cap = opts.excerptChars ?? 400;
  const recentTurns = recent.map((i) => {
    const t = turns[i]!;
    return { role: t.role, content: t.content.length > cap ? t.content.slice(0, cap - 1) + "…" : t.content };
  });

  const clean: CleanState = {
    goals: [...anchor.goals],
    ...(anchor.persona ? { persona: anchor.persona } : {}),
    constraints: [...anchor.constraints],
    decisions,
    keyFacts,
    openTasks,
    recentTurns,
  };
  const before = turns.reduce((s, t) => s + est(`${t.role}: ${t.content}\n`), 0);
  const after = toMessages(clean).reduce((s, m) => s + est(`${m.role}: ${m.content}\n`), 0);
  return {
    driftStart,
    driftPoints,
    kept,
    dropped: [...dropped].sort((a, b) => a[0] - b[0]).map(([index, why]) => ({ index, why })),
    reports,
    clean,
    tokens: {
      before,
      after,
      saved: before - after,
      ratio: before ? Math.round((after / before) * 1000) / 1000 : 0,
    },
  };
}

/** Compact system prompt that restores the clean state in a fresh session. */
export function toSystemPrompt(c: CleanState): string {
  const out = ["[RESUME: clean state from RecurringAlignment Drift Replay]"];
  if (c.persona) out.push(`You are ${c.persona}.`);
  if (c.goals.length) out.push(`Goals: ${c.goals.join("; ")}.`);
  if (c.constraints.length) out.push(`Rules: ${c.constraints.map(constraintText).join("; ")}.`);
  if (c.decisions.length) out.push(`Settled decisions: ${c.decisions.join("; ")}.`);
  if (c.keyFacts.length) out.push("Key facts:", ...c.keyFacts.map((f) => `- ${f}`));
  if (c.openTasks.length) out.push("Open tasks:", ...c.openTasks.map((t) => `- ${t}`));
  out.push("Continue from the recent turns below.");
  return out.join("\n");
}

/** Messages to seed a new chat session: one system prompt plus the recent on-track turns. */
export function toMessages(c: CleanState): Turn[] {
  return [{ role: "system", content: toSystemPrompt(c) }, ...c.recentTurns];
}

export function toMarkdown(r: ReplayResult): string {
  const c = r.clean;
  const sec = (title: string, items: string[]) =>
    items.length ? [`## ${title}`, "", ...items.map((x) => `- ${x}`), ""] : [];
  return [
    "# Drift Replay: clean state",
    "",
    `- Drift began at: **${r.driftStart === null ? "never (no drift found)" : `turn ${r.driftStart}`}**`,
    `- Dropped turns: ${r.dropped.map((d) => `${d.index} (${d.why})`).join(", ") || "none"}`,
    `- Tokens (est.): **${r.tokens.before} → ${r.tokens.after}** (saved ${r.tokens.saved}, ${Math.round(r.tokens.ratio * 100)}% of original)`,
    "",
    ...(c.persona ? [`**Persona:** ${c.persona}`, ""] : []),
    ...sec("Goals", c.goals),
    ...sec("Rules", c.constraints.map(constraintText)),
    ...sec("Decisions", c.decisions),
    ...sec("Key facts", c.keyFacts),
    ...sec("Open tasks", c.openTasks),
    "## Recent turns",
    "",
    ...c.recentTurns.map((t) => `**${t.role}:** ${t.content}\n`),
    "## Resume prompt",
    "",
    "```",
    toSystemPrompt(c),
    "```",
    "",
  ].join("\n");
}

/** JSON shape written by `replay --out clean.json`: directly loadable as a transcript. */
export function toResumeJSON(r: ReplayResult) {
  const c = r.clean;
  return {
    anchor: {
      goals: c.goals,
      constraints: c.constraints,
      decisions: c.decisions,
      ...(c.persona ? { persona: c.persona } : {}),
    },
    clean: c,
    meta: { driftStart: r.driftStart, driftPoints: r.driftPoints, dropped: r.dropped, tokens: r.tokens },
    messages: toMessages(c),
  };
}
