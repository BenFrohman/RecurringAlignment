import { readFileSync, writeFileSync, existsSync } from "node:fs";

export interface Anchor {
  goals: string[];
  constraints: string[];   // e.g. "no emojis", "never mention pricing"
  persona?: string;        // e.g. "Taloose, concise and friendly"
  decisions: string[];     // e.g. "use TypeScript", "repo stays private"
}
export interface Turn { role: "user" | "assistant" | "system"; content: string; }
export interface DriftReason { kind: "goal" | "constraint" | "decision" | "topic" | "persona" | "judge"; detail: string; weight: number; }
export interface TurnReport { index: number; role: Turn["role"]; score: number; drifted: boolean; reasons: DriftReason[]; }
export interface Report { turns: TurnReport[]; maxScore: number; driftPoints: number[]; realignment: string | null; }

/** Optional pluggable judge (e.g. an LLM). Returns 0..1 drift plus reasons. */
export interface Judge { evaluate(anchor: Anchor, history: Turn[], turn: Turn): Promise<{ score: number; reasons: string[] }>; }
export interface Options { threshold?: number; windowSize?: number; judge?: Judge; }

const STOP = new Set("a an the and or but if of to in on for with at by from is are was were be been it this that these those i you we they he she me my your our as do does did not no so can will just than then there here what which who how about into have has had".split(" "));
export const tokenize = (s: string): string[] =>
  s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length > 2 && !STOP.has(w));

export function jaccard(a: string[], b: string[]): number {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let i = 0; for (const x of A) if (B.has(x)) i++;
  return i / (A.size + B.size - i);
}
const coverage = (target: string[], text: Set<string>) => target.length ? target.filter(t => text.has(t)).length / target.length : 1;

const NEG = /\b(no|never|don't|do not|avoid|without|must not|not)\b/i;
/** Parse "no X"/"never X"/"avoid X" constraints into forbidden token lists. */
function forbidden(constraint: string): string[] {
  if (!NEG.test(constraint)) return [];
  return tokenize(constraint.replace(/\b(no|never|don't|do not|avoid|without|must not|not|use|mention|say|include)\b/gi, " "));
}
const REVERSAL = /\b(instead|actually|switch(ing)? to|rather than|no longer|change(d)? (to|our)|let'?s not|scrap|abandon)\b/i;

export class AlignmentMonitor {
  private history: Turn[] = [];
  private reports: TurnReport[] = [];
  readonly threshold: number; readonly windowSize: number; readonly judge?: Judge;
  constructor(public anchor: Anchor, opts: Options = {}) {
    this.threshold = opts.threshold ?? 0.5; this.windowSize = opts.windowSize ?? 4; this.judge = opts.judge;
  }

  /** Heuristic-only scoring of one turn (synchronous, no network). */
  scoreTurn(turn: Turn): TurnReport {
    const reasons: DriftReason[] = [];
    const toks = tokenize(turn.content); const set = new Set(toks);
    if (turn.role === "assistant") {
      const goalToks = tokenize(this.anchor.goals.join(" "));
      const cov = coverage([...new Set(goalToks)], set);
      if (goalToks.length && cov < 0.15) reasons.push({ kind: "goal", detail: `low goal coverage (${(cov * 100).toFixed(0)}%)`, weight: 0.3 * (1 - cov / 0.15) });
      for (const c of this.anchor.constraints) {
        const hits = forbidden(c).filter(t => set.has(t));
        if (hits.length) reasons.push({ kind: "constraint", detail: `violates "${c}" (${hits.join(", ")})`, weight: 0.5 });
      }
      if (REVERSAL.test(turn.content)) {
        for (const d of this.anchor.decisions) {
          const dt = tokenize(d); const ov = dt.filter(t => set.has(t));
          if (dt.length && ov.length / dt.length >= 0.3) reasons.push({ kind: "decision", detail: `may contradict decision "${d}"`, weight: 0.4 });
        }
      }
      if (this.anchor.persona) {
        const name = this.anchor.persona.split(/[,\s]/)[0];
        const m = turn.content.match(/\bI(?:'m| am)\s+([A-Z][a-zA-Z]+)/);
        if (name && m && m[1].toLowerCase() !== name.toLowerCase()) reasons.push({ kind: "persona", detail: `identifies as "${m[1]}" not "${name}"`, weight: 0.4 });
      }
      const ctx = this.history.slice(-this.windowSize).flatMap(t => tokenize(t.content)).concat(goalToks);
      const sim = jaccard(toks, ctx);
      if (this.history.length && toks.length > 5 && sim < 0.05) reasons.push({ kind: "topic", detail: `topic shift (similarity ${sim.toFixed(2)})`, weight: 0.3 });
    }
    const score = Math.min(1, reasons.reduce((s, r) => s + r.weight, 0));
    return { index: this.history.length, role: turn.role, score: +score.toFixed(3), drifted: score >= this.threshold, reasons };
  }

  /** Feed a turn; runs heuristics plus optional judge. */
  async addTurn(turn: Turn): Promise<TurnReport> {
    const r = this.scoreTurn(turn);
    if (this.judge && turn.role === "assistant") {
      const j = await this.judge.evaluate(this.anchor, [...this.history], turn);
      r.score = +Math.min(1, Math.max(r.score, j.score)).toFixed(3);
      r.reasons.push(...j.reasons.map(d => ({ kind: "judge" as const, detail: d, weight: j.score })));
      r.drifted = r.score >= this.threshold;
    }
    this.history.push(turn); this.reports.push(r);
    // Auto-record decisions the user states explicitly ("decision: ..." / "we decided ...").
    if (turn.role === "user") {
      const m = turn.content.match(/(?:decision:|we decided(?: to)?|let'?s go with)\s*(.+)/i);
      if (m) this.anchor.decisions.push(m[1].trim().replace(/[.!]$/, ""));
    }
    return r;
  }

  report(): Report {
    const driftPoints = this.reports.filter(r => r.drifted).map(r => r.index);
    return { turns: [...this.reports], maxScore: Math.max(0, ...this.reports.map(r => r.score)), driftPoints, realignment: driftPoints.length ? this.realignment() : null };
  }

  /** Compact message to inject into the same context to pull the assistant back on track. */
  realignment(): string {
    const last = [...this.reports].reverse().find(r => r.drifted);
    const a = this.anchor; const lines = ["[REALIGN]"];
    if (a.persona) lines.push(`Persona: ${a.persona}.`);
    if (a.goals.length) lines.push(`Goal: ${a.goals.join("; ")}.`);
    if (a.constraints.length) lines.push(`Rules: ${a.constraints.join("; ")}.`);
    if (a.decisions.length) lines.push(`Settled: ${a.decisions.join("; ")}.`);
    if (last) lines.push(`Drift at turn ${last.index}: ${last.reasons.map(r => r.detail).join("; ")}. Correct course in your next reply without restating this.`);
    return lines.join("\n");
  }
}

/** Persisted state: anchors survive across sessions. */
export interface State { version: 1; anchors: Record<string, Anchor>; }
export function loadState(path: string): State {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { version: 1, anchors: {} };
}
export function saveState(path: string, state: State): void { writeFileSync(path, JSON.stringify(state, null, 2)); }

/** Parse a transcript: JSON ({anchor?, turns} or Turn[]) or Markdown with "User:"/"Assistant:" or "## user" headers. */
export function parseTranscript(text: string): { anchor?: Anchor; turns: Turn[] } {
  const t = text.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    const j = JSON.parse(t); return Array.isArray(j) ? { turns: j } : j;
  }
  const turns: Turn[] = []; let cur: Turn | null = null;
  for (const line of t.split(/\r?\n/)) {
    const m = line.match(/^(?:#+\s*|\*\*)?(user|assistant|system)(?:\*\*)?\s*:?\s*(?:\*\*)?\s*(.*)$/i);
    if (m) { cur = { role: m[1].toLowerCase() as Turn["role"], content: m[2] }; turns.push(cur); }
    else if (cur) cur.content += (cur.content ? "\n" : "") + line;
  }
  return { turns };
}

export async function check(anchor: Anchor, turns: Turn[], opts?: Options): Promise<Report> {
  const m = new AlignmentMonitor({ ...anchor, decisions: [...anchor.decisions] }, opts);
  for (const t of turns) await m.addTurn(t);
  return m.report();
}
