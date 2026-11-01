/** A rule the assistant must follow. Strings like "never use emojis" are parsed automatically. */
export type Constraint =
  | string
  | {
      /** Human-readable rule, shown in realignment messages. */
      rule: string;
      /** Words/phrases that must not appear in assistant replies. */
      forbid?: string[];
      /** Regex source; a match counts as a violation. */
      pattern?: string;
    };

/** The "north star" for a conversation. */
export interface Anchor {
  goals: string[];
  constraints: Constraint[];
  /** e.g. "Taloose, friendly and concise". The first word is treated as the assistant's name. */
  persona?: string;
  decisions: string[];
}

export type Role = "user" | "assistant" | "system";
export interface Turn {
  role: Role;
  content: string;
}

export type DriftKind = "goal" | "constraint" | "decision" | "persona" | "topic" | "judge";
export type Severity = "none" | "low" | "medium" | "high";

export interface DriftReason {
  kind: DriftKind;
  detail: string;
  /** Raw signal strength 0..1 before weighting. */
  signal: number;
  /** Contribution to the score (signal * weight). */
  contribution: number;
}

export interface TurnReport {
  index: number;
  role: Role;
  score: number;
  severity: Severity;
  drifted: boolean;
  reasons: DriftReason[];
}

export interface SessionReport {
  turns: TurnReport[];
  assistantTurns: number;
  maxScore: number;
  meanScore: number;
  driftPoints: number[];
  byKind: Record<DriftKind, number>;
  realignment: string | null;
}

/** Pluggable judge (e.g. an LLM). Must return a drift score 0..1 and short reasons. */
export interface Judge {
  readonly name: string;
  evaluate(input: {
    anchor: Anchor;
    history: Turn[];
    turn: Turn;
  }): Promise<{ score: number; reasons: string[] }>;
}

export interface EngineConfig {
  /** Score at/above which a turn is "drifted". Default 0.5. */
  threshold: number;
  /** Number of previous turns used as topic context. Default 6. */
  windowSize: number;
  /** Per-kind multipliers. */
  weights: Record<DriftKind, number>;
  /** Score cut-offs for severity levels. */
  severity: { low: number; medium: number; high: number };
  /** Goal coverage (0..1) below which the goal signal fires. Default 0.2. */
  minGoalCoverage: number;
  /** Topic similarity below which the topic signal fires. Default 0.08. */
  minTopicSimilarity: number;
  /** Record user statements like "We decided to X" as anchor decisions. Default true. */
  autoRecordDecisions: boolean;
  /** Max characters in a generated realignment message. Default 600. */
  maxRealignChars: number;
  judge?: Judge;
}

export const DEFAULT_CONFIG: EngineConfig = {
  threshold: 0.5,
  windowSize: 6,
  weights: { goal: 0.3, constraint: 0.6, decision: 0.5, persona: 0.4, topic: 0.3, judge: 1 },
  severity: { low: 0.2, medium: 0.5, high: 0.8 },
  minGoalCoverage: 0.2,
  minTopicSimilarity: 0.08,
  autoRecordDecisions: true,
  maxRealignChars: 600,
};

export type PartialConfig = Partial<Omit<EngineConfig, "weights" | "severity">> & {
  weights?: Partial<EngineConfig["weights"]>;
  severity?: Partial<EngineConfig["severity"]>;
};

export function resolveConfig(c: PartialConfig = {}): EngineConfig {
  return {
    ...DEFAULT_CONFIG,
    ...c,
    weights: { ...DEFAULT_CONFIG.weights, ...c.weights },
    severity: { ...DEFAULT_CONFIG.severity, ...c.severity },
  };
}
