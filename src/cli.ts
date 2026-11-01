#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { check, parseTranscript, loadState, saveState, type Anchor } from "./index.js";

const USAGE = `recurring-alignment check <transcript.json|md> [--state file.json] [--anchor name] [--threshold 0.5] [--json]
recurring-alignment anchor set <name> --state file.json --goal "..." [--constraint "..."] [--decision "..."] [--persona "..."]`;
const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const flags = (n: string) => args.flatMap((a, i) => a === `--${n}` ? [args[i + 1]] : []);

async function main() {
  const [cmd, a1, a2] = args;
  if (cmd === "anchor" && a1 === "set" && a2) {
    const path = flag("state") ?? ".recurring-alignment.json"; const st = loadState(path);
    st.anchors[a2] = { goals: flags("goal"), constraints: flags("constraint"), decisions: flags("decision"), persona: flag("persona") };
    saveState(path, st); console.log(`Saved anchor "${a2}" to ${path}`); return;
  }
  if (cmd !== "check" || !a1) { console.log(USAGE); process.exit(cmd ? 1 : 0); }
  const parsed = parseTranscript(readFileSync(a1, "utf8"));
  const sp = flag("state"); let anchor: Anchor | undefined = parsed.anchor;
  if (sp) anchor = loadState(sp).anchors[flag("anchor") ?? "default"] ?? anchor;
  if (!anchor) { console.error("No anchor: include {anchor} in JSON transcript or pass --state/--anchor."); process.exit(1); }
  const rep = await check(anchor, parsed.turns, { threshold: flag("threshold") ? Number(flag("threshold")) : undefined });
  if (args.includes("--json")) { console.log(JSON.stringify(rep, null, 2)); }
  else {
    for (const t of rep.turns) if (t.role === "assistant")
      console.log(`${t.drifted ? "DRIFT" : "ok   "} turn ${t.index} score=${t.score}${t.reasons.length ? "  - " + t.reasons.map(r => r.detail).join("; ") : ""}`);
    if (rep.realignment) console.log("\n" + rep.realignment);
  }
  process.exit(rep.driftPoints.length ? 2 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
