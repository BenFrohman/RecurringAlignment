import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  check,
  emptyAnchor,
  formatMarkdown,
  loadState,
  parseTranscript,
  saveState,
  constraintText,
  type Anchor,
  type PartialConfig,
  type SessionReport,
  type TurnReport,
} from "@recurring-alignment/core";
import { createJudge } from "@recurring-alignment/judges";
import { replay, toMarkdown, toResumeJSON } from "@recurring-alignment/replay";
import { many, one, parseArgs, type Parsed } from "./args.js";
import { watchTranscript } from "./watch.js";

export { parseArgs } from "./args.js";
export { watchTranscript, type WatchHandle } from "./watch.js";

export interface IO {
  out: (s: string) => void;
  err: (s: string) => void;
  /** Resolves when a long-running command (watch) should stop. Defaults to SIGINT. */
  until?: Promise<void>;
}

export const DEFAULT_STATE = ".recurring-alignment.json";

export const HELP = `recurring-alignment — keep AI conversations on track

Usage:
  recurring-alignment check  <transcript>   Score every assistant turn; exit 2 if drift found
  recurring-alignment watch  <transcript>   Tail a file and print realign messages live
  recurring-alignment report <transcript>   Markdown (default) or JSON drift summary
  recurring-alignment replay <transcript>   Drift Replay: find where drift began, write a clean
                                            state to resume from (--out clean.json | clean.md)
  recurring-alignment anchor init [name]    Create an empty anchor in the state file
  recurring-alignment anchor set  [name]    Add goals/rules/decisions/persona
  recurring-alignment anchor show [name]    Print an anchor (or list all)

Transcripts: .json ({anchor,turns} | {messages} | Turn[]), .jsonl, or .md/.txt with "User:"/"Assistant:" lines.

Options:
  --state <file>        State file (default ${DEFAULT_STATE})
  --anchor <name>       Anchor name in the state file (default "default")
  --threshold <0..1>    Drift threshold (default 0.5)
  --window <n>          Rolling context window in turns (default 6)
  --weight kind=value   Override a weight, e.g. --weight topic=0.5 (repeatable)
  --judge <name>        none | mock | openai | anthropic (uses OPENAI_API_KEY / ANTHROPIC_API_KEY)
  --json                Machine-readable output
  --format md|json      Report format;  --out <file>  write report to a file
  --goal/--constraint/--decision <text> (repeatable), --persona <text>   for "anchor set"
`;

function configFrom(p: Parsed): PartialConfig {
  const cfg: PartialConfig = {};
  const th = one(p, "threshold");
  if (th !== undefined) {
    const n = Number(th);
    if (!(n >= 0 && n <= 1)) throw new Error("--threshold must be between 0 and 1");
    cfg.threshold = n;
  }
  const w = one(p, "window");
  if (w !== undefined) {
    const n = Number.parseInt(w, 10);
    if (!(n > 0)) throw new Error("--window must be a positive integer");
    cfg.windowSize = n;
  }
  const weights: Record<string, number> = {};
  for (const kv of many(p, "weight")) {
    const [k, v] = kv.split("=");
    if (
      !k ||
      !["goal", "constraint", "decision", "persona", "topic", "judge"].includes(k) ||
      !Number.isFinite(Number(v))
    )
      throw new Error(`bad --weight "${kv}" (expected kind=number)`);
    weights[k] = Number(v);
  }
  if (Object.keys(weights).length) cfg.weights = weights;
  const judge = createJudge(one(p, "judge") ?? "none");
  if (judge) cfg.judge = judge;
  return cfg;
}

function resolveAnchor(p: Parsed, embedded?: Anchor): Anchor {
  const statePath = one(p, "state") ?? DEFAULT_STATE;
  const name = one(p, "anchor");
  const st = loadState(statePath);
  if (name) {
    const a = st.anchors[name];
    if (!a) throw new Error(`anchor "${name}" not found in ${statePath}`);
    return a;
  }
  const a = embedded ?? st.anchors.default;
  if (!a)
    throw new Error(
      `no anchor: embed "anchor" in the transcript JSON or run "recurring-alignment anchor set"`,
    );
  return a;
}

function line(t: TurnReport): string {
  const tag = t.drifted ? "DRIFT" : t.severity === "low" ? "warn " : "ok   ";
  const why = t.reasons.filter((r) => r.contribution > 0).map((r) => r.detail);
  return `${tag} turn ${String(t.index).padStart(3)}  score ${t.score.toFixed(2)} (${t.severity})${why.length ? "  — " + why.join("; ") : ""}`;
}

function load(file: string | undefined) {
  if (!file) throw new Error("missing <transcript> argument");
  if (!existsSync(file)) throw new Error(`file not found: ${file}`);
  return parseTranscript(readFileSync(file, "utf8"));
}

async function cmdCheck(p: Parsed, io: IO): Promise<number> {
  const t = load(p.positional[1]);
  const rep = await check(resolveAnchor(p, t.anchor), t.turns, configFrom(p));
  if (p.bools.has("json")) io.out(JSON.stringify(rep, null, 2));
  else {
    rep.turns.filter((x) => x.role === "assistant").forEach((x) => io.out(line(x)));
    io.out(
      `\n${rep.driftPoints.length} drift point(s) in ${rep.assistantTurns} assistant turn(s); max ${rep.maxScore}, mean ${rep.meanScore}`,
    );
    if (rep.realignment) io.out(`\nPaste this into the conversation:\n\n${rep.realignment}`);
  }
  return rep.driftPoints.length ? 2 : 0;
}

async function cmdReport(p: Parsed, io: IO): Promise<number> {
  const file = p.positional[1];
  const t = load(file);
  const rep: SessionReport = await check(resolveAnchor(p, t.anchor), t.turns, configFrom(p));
  const fmt = p.bools.has("json") ? "json" : (one(p, "format") ?? "md");
  if (fmt !== "md" && fmt !== "json") throw new Error("--format must be md or json");
  const text = fmt === "json" ? JSON.stringify(rep, null, 2) : formatMarkdown(rep, `Drift report: ${file}`);
  const out = one(p, "out");
  if (out) {
    writeFileSync(out, text);
    io.out(`wrote ${out}`);
  } else io.out(text);
  return 0;
}

async function cmdWatch(p: Parsed, io: IO): Promise<number> {
  const file = p.positional[1];
  if (!file) throw new Error("missing <transcript> argument");
  const embedded = existsSync(file) ? safeAnchor(file) : undefined;
  const json = p.bools.has("json");
  const h = watchTranscript(
    file,
    resolveAnchor(p, embedded),
    (r, m) => {
      if (r.role !== "assistant") return;
      if (json) io.out(JSON.stringify({ ...r, realignment: r.drifted ? m.realignment(r) : null }));
      else {
        io.out(line(r));
        if (r.drifted) io.out(`\n${m.realignment(r)}\n`);
      }
    },
    {
      config: configFrom(p),
      intervalMs: Number(one(p, "interval") ?? 500),
      onError: (e) => io.err(`waiting: ${e.message}`),
    },
  );
  if (!json) io.err(`watching ${file} (Ctrl+C to stop)`);
  await h.poll();
  if (p.bools.has("once")) {
    h.stop();
    return h.monitor.report().driftPoints.length ? 2 : 0;
  }
  await (io.until ?? new Promise<void>((res) => process.once("SIGINT", () => res())));
  await h.poll();
  h.stop();
  return 0;
}

async function cmdReplay(p: Parsed, io: IO): Promise<number> {
  const t = load(p.positional[1]);
  const r = await replay(resolveAnchor(p, t.anchor), t.turns, { config: configFrom(p) });
  const out = one(p, "out");
  const asJson = p.bools.has("json") || (out ? /\.json$/i.test(out) : false);
  const text = asJson ? JSON.stringify(toResumeJSON(r), null, 2) : toMarkdown(r);
  if (out) {
    writeFileSync(out, text);
    io.out(
      `drift began at ${r.driftStart === null ? "no turn (clean)" : `turn ${r.driftStart}`}; ` +
        `dropped ${r.dropped.length} turn(s); tokens ~${r.tokens.before} -> ~${r.tokens.after}. Wrote ${out}`,
    );
  } else io.out(text);
  return 0;
}

function safeAnchor(file: string): Anchor | undefined {
  try {
    return parseTranscript(readFileSync(file, "utf8")).anchor;
  } catch {
    return undefined;
  }
}

function cmdAnchor(p: Parsed, io: IO): number {
  const [, sub, name = "default"] = p.positional;
  const path = one(p, "state") ?? DEFAULT_STATE;
  const st = loadState(path);
  if (sub === "init") {
    if (st.anchors[name] && !p.bools.has("force"))
      throw new Error(`anchor "${name}" exists (use --force to reset)`);
    st.anchors[name] = emptyAnchor();
    saveState(path, st);
    io.out(`created anchor "${name}" in ${path}`);
    return 0;
  }
  if (sub === "set") {
    const a = st.anchors[name] ?? emptyAnchor();
    a.goals.push(...many(p, "goal"));
    a.constraints.push(...many(p, "constraint"));
    a.decisions.push(...many(p, "decision"));
    const persona = one(p, "persona");
    if (persona) a.persona = persona;
    st.anchors[name] = a;
    saveState(path, st);
    io.out(`updated anchor "${name}" in ${path}`);
    return 0;
  }
  if (sub === "show") {
    const names = p.positional[2] ? [name] : Object.keys(st.anchors);
    if (!names.length) {
      io.out(`no anchors in ${path} (run "recurring-alignment anchor init")`);
      return 0;
    }
    const pick = Object.fromEntries(
      names.map((n) => {
        const a = st.anchors[n];
        if (!a) throw new Error(`anchor "${n}" not found in ${path}`);
        return [n, a];
      }),
    );
    if (p.bools.has("json")) io.out(JSON.stringify(pick, null, 2));
    else
      for (const [n, a] of Object.entries(pick)) {
        io.out(`[${n}]`);
        if (a.persona) io.out(`  persona:   ${a.persona}`);
        a.goals.forEach((g) => io.out(`  goal:      ${g}`));
        a.constraints.forEach((c) => io.out(`  rule:      ${constraintText(c)}`));
        a.decisions.forEach((d) => io.out(`  decision:  ${d}`));
      }
    return 0;
  }
  throw new Error(`unknown anchor subcommand "${sub ?? ""}" (init | set | show)`);
}

/** Entry point. Returns an exit code: 0 ok, 1 error, 2 drift detected. */
export async function run(
  argv: string[],
  io: IO = { out: console.log, err: console.error },
): Promise<number> {
  try {
    const p = parseArgs(argv);
    const cmd = p.positional[0];
    if (!cmd || p.bools.has("help") || p.bools.has("h")) {
      io.out(HELP);
      return cmd || p.bools.size ? 0 : 1;
    }
    switch (cmd) {
      case "check":
        return await cmdCheck(p, io);
      case "report":
        return await cmdReport(p, io);
      case "watch":
        return await cmdWatch(p, io);
      case "replay":
        return await cmdReplay(p, io);
      case "anchor":
        return cmdAnchor(p, io);
      default:
        throw new Error(`unknown command "${cmd}"`);
    }
  } catch (e) {
    io.err(`error: ${(e as Error).message}`);
    return 1;
  }
}
