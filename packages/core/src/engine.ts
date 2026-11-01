import { TypedEmitter, type EngineEvents } from "./events.js";
import { TfIdf, cosine, tokenize } from "./text.js";
import {
  resolveConfig,
  type Anchor,
  type Constraint,
  type DriftKind,
  type DriftReason,
  type EngineConfig,
  type PartialConfig,
  type SessionReport,
  type Severity,
  type Turn,
  type TurnReport,
} from "./types.js";

const NEG = /\b(no|never|don'?t|do not|avoid|without|must not|not)\b/i;
const NEG_FILLER =
  /\b(no|never|don'?t|do not|avoid|without|must not|not|use|using|mention|say|include|add|any|ever)\b/gi;
const REVERSAL =
  /\b(instead|actually|switch(ing)? to|rather than|no longer|chang(e|ed|ing) (to|it|our|the)|let'?s not|scrap|abandon|ditch|undo|revert)\b/i;
const SELF_NAME = /\b(?:I'?m|I am|my name is|call me)\s+([A-Z][a-zA-Z]+)/;
const DECISION_STMT =
  /(?:^|\b)(?:decision:|we decided(?: to)?|we agreed(?: to)?|let'?s go with|final answer:)\s*([^.!?\n]+)/i;

export function constraintText(c: Constraint): string {
  return typeof c === "string" ? c : c.rule;
}

/** Turn a constraint into concrete checks. "never use python" -> forbid ["python"]. */
export function compileConstraint(c: Constraint): { rule: string; forbid: string[]; pattern?: RegExp } {
  if (typeof c === "string") {
    const forbid = NEG.test(c) ? tokenize(c.replace(NEG_FILLER, " ")) : [];
    return { rule: c, forbid };
  }
  return {
    rule: c.rule,
    forbid: (c.forbid ?? []).map((f) => f.toLowerCase()),
    pattern: c.pattern ? new RegExp(c.pattern, "i") : undefined,
  };
}

export function severityOf(score: number, cuts: EngineConfig["severity"]): Severity {
  if (score >= cuts.high) return "high";
  if (score >= cuts.medium) return "medium";
  if (score >= cuts.low) return "low";
  return "none";
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Tracks a conversation against an Anchor and flags drift turn by turn.
 * Pure heuristics by default; add `config.judge` for an LLM second opinion.
 */
export class AlignmentMonitor extends TypedEmitter<EngineEvents> {
  readonly config: EngineConfig;
  readonly anchor: Anchor;
  private history: Turn[] = [];
  private reports: TurnReport[] = [];

  constructor(anchor: Anchor, config: PartialConfig = {}) {
    super();
    this.anchor = {
      goals: [...anchor.goals],
      constraints: [...anchor.constraints],
      decisions: [...anchor.decisions],
      persona: anchor.persona,
    };
    this.config = resolveConfig(config);
  }

  get turns(): readonly Turn[] {
    return this.history;
  }

  private reason(kind: DriftKind, detail: string, signal: number): DriftReason {
    const s = Math.max(0, Math.min(1, signal));
    return { kind, detail, signal: round(s), contribution: round(s * this.config.weights[kind]) };
  }

  private finish(index: number, role: Turn["role"], reasons: DriftReason[]): TurnReport {
    const score = round(
      Math.min(
        1,
        reasons.reduce((s, r) => s + r.contribution, 0),
      ),
    );
    return {
      index,
      role,
      score,
      severity: severityOf(score, this.config.severity),
      drifted: score >= this.config.threshold,
      reasons,
    };
  }

  /** Heuristic-only, synchronous scoring. Does not mutate state. */
  scoreTurn(turn: Turn): TurnReport {
    const index = this.history.length;
    if (turn.role !== "assistant") return this.finish(index, turn.role, []);
    const reasons: DriftReason[] = [];
    const lower = turn.content.toLowerCase();
    const toks = tokenize(turn.content);
    const set = new Set(toks);

    // 1. Goal coverage: share of goal vocabulary present, or TF-IDF cosine to goals (whichever is higher).
    const goalToks = tokenize(this.anchor.goals.join(" "));
    const uniqGoal = [...new Set(goalToks)];
    if (uniqGoal.length && toks.length) {
      const cov = uniqGoal.filter((t) => set.has(t)).length / uniqGoal.length;
      const idf = new TfIdf([goalToks, toks]);
      const sim = Math.max(cov, cosine(idf.vector(toks), idf.vector(goalToks)));
      if (sim < this.config.minGoalCoverage)
        reasons.push(
          this.reason(
            "goal",
            `reply barely touches the goal (${Math.round(sim * 100)}% overlap)`,
            1 - sim / this.config.minGoalCoverage,
          ),
        );
    }

    // 2. Constraint violations.
    for (const c of this.anchor.constraints) {
      const { rule, forbid, pattern } = compileConstraint(c);
      const hits = forbid.filter((f) =>
        f.includes(" ") ? lower.includes(f) : set.has(f) || set.has(stemSafe(f)),
      );
      if (pattern?.test(turn.content)) hits.push(`/${pattern.source}/`);
      if (hits.length)
        reasons.push(this.reason("constraint", `breaks rule "${rule}" (${hits.join(", ")})`, 1));
    }

    // 3. Contradicting a recorded decision: reversal/negation language + overlap with the decision.
    const reversing = REVERSAL.test(turn.content) || NEG.test(turn.content);
    if (reversing) {
      for (const d of this.anchor.decisions) {
        const dt = [...new Set(tokenize(d))];
        if (!dt.length) continue;
        const ov = dt.filter((t) => set.has(t)).length / dt.length;
        if (ov >= 0.3 && REVERSAL.test(turn.content))
          reasons.push(this.reason("decision", `may undo decision "${d}"`, Math.min(1, 0.5 + ov)));
        else if (ov >= 0.5)
          reasons.push(this.reason("decision", `may contradict decision "${d}"`, Math.min(1, ov * 0.8)));
      }
    }

    // 4. Persona: assistant names itself something else.
    const name = this.anchor.persona?.split(/[,\s]/)[0]?.trim();
    const m = turn.content.match(SELF_NAME);
    if (name && m?.[1] && m[1].toLowerCase() !== name.toLowerCase())
      reasons.push(this.reason("persona", `calls itself "${m[1]}" instead of "${name}"`, 1));

    // 5. Topic shift: TF-IDF cosine against the rolling window of on-track turns + goals.
    // Drifted turns are excluded so a drift run can't become its own "context".
    const window = this.history
      .filter((_, i) => !this.reports[i]?.drifted)
      .slice(-this.config.windowSize)
      .map((t) => tokenize(t.content));
    if (window.length && toks.length >= 5) {
      const ctx = window.flat().concat(goalToks);
      const idf = new TfIdf([...window, goalToks, toks]);
      const sim = cosine(idf.vector(toks), idf.vector(ctx));
      if (sim < this.config.minTopicSimilarity)
        reasons.push(
          this.reason(
            "topic",
            `topic shifted away from the conversation (similarity ${sim.toFixed(2)})`,
            1 - sim / this.config.minTopicSimilarity,
          ),
        );
    }
    return this.finish(index, turn.role, reasons);
  }

  /** Add a turn, run heuristics (+ judge if configured), update state, emit events. */
  async addTurn(turn: Turn): Promise<TurnReport> {
    let report = this.scoreTurn(turn);
    const judge = this.config.judge;
    if (judge && turn.role === "assistant") {
      try {
        const j = await judge.evaluate({ anchor: this.anchor, history: [...this.history], turn });
        const extra = j.reasons.length ? j.reasons : [`${judge.name} flagged drift`];
        if (j.score > 0)
          report = this.finish(report.index, report.role, [
            ...report.reasons,
            ...extra.map((d, i) => this.reason("judge", `${judge.name}: ${d}`, i === 0 ? j.score : 0)),
          ]);
      } catch (e) {
        report.reasons.push(this.reason("judge", `${judge.name} unavailable: ${(e as Error).message}`, 0));
      }
    }
    this.history.push(turn);
    this.reports.push(report);
    if (turn.role === "user" && this.config.autoRecordDecisions) {
      const d = turn.content.match(DECISION_STMT)?.[1]?.trim();
      if (d && !this.anchor.decisions.includes(d)) {
        this.anchor.decisions.push(d);
        this.emit("decision", { decision: d, index: report.index });
      }
    }
    this.emit("turn", report);
    if (report.drifted) this.emit("drift", { report, realignment: this.realignment(report) });
    return report;
  }

  async addTurns(turns: Turn[]): Promise<TurnReport[]> {
    const out: TurnReport[] = [];
    for (const t of turns) out.push(await this.addTurn(t));
    return out;
  }

  /** Most recent drifted turn, if any. */
  lastDrift(): TurnReport | undefined {
    return [...this.reports].reverse().find((r) => r.drifted);
  }

  /**
   * A compact message to inject into the same context. Only includes the anchor parts
   * relevant to the detected drift, and is capped at `maxRealignChars`.
   */
  realignment(report: TurnReport | undefined = this.lastDrift()): string {
    const a = this.anchor;
    const kinds = new Set(report?.reasons.filter((r) => r.contribution > 0).map((r) => r.kind));
    const all = !report || kinds.has("judge");
    const lines = ["[REALIGN]"];
    if (a.persona && (all || kinds.has("persona"))) lines.push(`You are ${a.persona}.`);
    if (a.goals.length) lines.push(`Goal: ${a.goals.join("; ")}.`);
    if (a.constraints.length && (all || kinds.has("constraint")))
      lines.push(`Rules: ${a.constraints.map(constraintText).join("; ")}.`);
    if (a.decisions.length && (all || kinds.has("decision")))
      lines.push(`Settled: ${a.decisions.join("; ")}.`);
    if (report) {
      const why = report.reasons
        .filter((r) => r.contribution > 0)
        .map((r) => r.detail)
        .join("; ");
      lines.push(`Turn ${report.index} drifted (${report.severity}): ${why}.`);
    }
    lines.push("Continue from here, back on track, without mentioning this note.");
    const msg = lines.join("\n");
    const max = this.config.maxRealignChars;
    return msg.length <= max ? msg : msg.slice(0, max - 1) + "…";
  }

  report(): SessionReport {
    const asst = this.reports.filter((r) => r.role === "assistant");
    const byKind: Record<DriftKind, number> = {
      goal: 0,
      constraint: 0,
      decision: 0,
      persona: 0,
      topic: 0,
      judge: 0,
    };
    for (const r of asst) for (const x of r.reasons) if (x.contribution > 0) byKind[x.kind]++;
    const driftPoints = asst.filter((r) => r.drifted).map((r) => r.index);
    return {
      turns: [...this.reports],
      assistantTurns: asst.length,
      maxScore: Math.max(0, ...asst.map((r) => r.score)),
      meanScore: asst.length ? round(asst.reduce((s, r) => s + r.score, 0) / asst.length) : 0,
      driftPoints,
      byKind,
      realignment: driftPoints.length ? this.realignment() : null,
    };
  }

  reset(): void {
    this.history = [];
    this.reports = [];
  }
}

function stemSafe(f: string): string {
  return tokenize(f)[0] ?? f;
}

/** One-shot helper: score a whole transcript. */
export async function check(anchor: Anchor, turns: Turn[], config?: PartialConfig): Promise<SessionReport> {
  const m = new AlignmentMonitor(anchor, config);
  await m.addTurns(turns);
  return m.report();
}
