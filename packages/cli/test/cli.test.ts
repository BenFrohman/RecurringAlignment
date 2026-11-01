import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { parseArgs, run, watchTranscript, HELP } from "../src/index.js";

const dir = mkdtempSync(join(tmpdir(), "ra-cli-"));
const anchor = {
  goals: ["build a TypeScript drift detection package"],
  constraints: ["never use python"],
  decisions: [] as string[],
};
const turns = [
  { role: "user", content: "Build the TypeScript drift detection package" },
  { role: "assistant", content: "Building the TypeScript drift detection package now." },
  { role: "assistant", content: "Actually let's do python, bananas are great for recipes and cooking." },
];
const file = (name: string, body: unknown) => {
  const p = join(dir, name);
  writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
  return p;
};
const T = file("t.json", { anchor, turns });
const CLEAN = file("clean.json", { anchor, turns: turns.slice(0, 2) });

async function cli(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("args", () => {
  test("parses flags, repeats, inline values and booleans", () => {
    const p = parseArgs(["check", "f", "--goal", "a", "--goal=b", "--json", "-h", "--x=y=z"]);
    assert.deepEqual(p.positional, ["check", "f"]);
    assert.deepEqual(p.flags.goal, ["a", "b"]);
    assert.deepEqual(p.flags.x, ["y=z"]);
    assert.ok(p.bools.has("json") && p.bools.has("h"));
    assert.throws(() => parseArgs(["--state"]), /missing value/);
  });
});

describe("general", () => {
  test("help and errors", async () => {
    assert.equal((await cli()).code, 1);
    const h = await cli("--help");
    assert.equal(h.code, 0);
    assert.equal(h.out, HELP);
    assert.equal((await cli("check", "--help")).code, 0);
    assert.match((await cli("nope")).err, /unknown command/);
    assert.match((await cli("check")).err, /missing <transcript>/);
    assert.match((await cli("check", join(dir, "missing.json"))).err, /file not found/);
  });
});

describe("check", () => {
  test("text output, exit 2 on drift, realignment printed", async () => {
    const r = await cli("check", T);
    assert.equal(r.code, 2);
    assert.match(r.out, /DRIFT turn +2/);
    assert.match(r.out, /\[REALIGN\]/);
    assert.equal((await cli("check", CLEAN)).code, 0);
  });
  test("json output", async () => {
    const r = await cli("check", T, "--json");
    assert.deepEqual(JSON.parse(r.out).driftPoints, [2]);
  });
  test("threshold, window, weight and judge flags", async () => {
    assert.equal((await cli("check", CLEAN, "--threshold", "0")).code, 2);
    assert.equal(
      (
        await cli(
          "check",
          T,
          "--window",
          "1",
          "--weight",
          "constraint=0",
          "--weight",
          "goal=0",
          "--weight",
          "topic=0",
        )
      ).code,
      0,
    );
    assert.equal(
      (
        await cli(
          "check",
          file("j.json", {
            anchor,
            turns: [{ role: "assistant", content: "drift detection TypeScript package, off-topic" }],
          }),
          "--judge",
          "mock",
        )
      ).code,
      2,
    );
    assert.match((await cli("check", T, "--threshold", "2")).err, /between 0 and 1/);
    assert.match((await cli("check", T, "--window", "0")).err, /positive integer/);
    assert.match((await cli("check", T, "--weight", "bogus=1")).err, /bad --weight/);
    assert.match((await cli("check", T, "--weight", "goal=x")).err, /bad --weight/);
    assert.match((await cli("check", T, "--judge", "zzz")).err, /unknown judge/);
  });
  test("warn line for low severity", async () => {
    const r = await cli(
      "check",
      file("w.json", { anchor, turns: [{ role: "assistant", content: "TypeScript python stuff here" }] }),
      "--weight",
      "constraint=0.3",
    );
    assert.match(r.out, /warn /);
  });
});

describe("anchor + state", () => {
  const S = join(dir, "state.json");
  test("init, set, show, json, force, errors", async () => {
    assert.match((await cli("anchor", "show", "--state", S)).out, /no anchors/);
    assert.equal((await cli("anchor", "init", "--state", S)).code, 0);
    assert.match((await cli("anchor", "init", "--state", S)).err, /exists/);
    assert.equal((await cli("anchor", "init", "--state", S, "--force")).code, 0);
    await cli(
      "anchor",
      "set",
      "--state",
      S,
      "--goal",
      "build a TypeScript drift detection package",
      "--constraint",
      "never use python",
      "--decision",
      "d1",
      "--persona",
      "Taloose",
    );
    await cli("anchor", "set", "other", "--state", S, "--goal", "g2");
    const show = await cli("anchor", "show", "--state", S);
    for (const s of [
      "[default]",
      "[other]",
      "persona:   Taloose",
      "rule:      never use python",
      "decision:  d1",
      "goal:      g2",
    ])
      assert.ok(show.out.includes(s), s);
    const j = JSON.parse((await cli("anchor", "show", "other", "--state", S, "--json")).out);
    assert.deepEqual(j.other.goals, ["g2"]);
    assert.match((await cli("anchor", "show", "ghost", "--state", S)).err, /not found/);
    assert.match((await cli("anchor", "bogus", "--state", S)).err, /unknown anchor subcommand/);
    assert.match((await cli("anchor", "--state", S)).err, /unknown anchor subcommand ""/);
  });
  test("check uses state anchors (default and named)", async () => {
    const md = file(
      "t.md",
      "User: build it\nAssistant: Building the TypeScript drift detection package.\nAssistant: python python bananas cooking recipes forever",
    );
    assert.equal((await cli("check", md, "--state", S)).code, 2);
    assert.equal((await cli("check", md, "--state", S, "--anchor", "default")).code, 2);
    assert.match((await cli("check", md, "--state", S, "--anchor", "ghost")).err, /not found/);
    assert.match((await cli("check", md, "--state", join(dir, "none.json"))).err, /no anchor/);
  });
});

describe("report", () => {
  test("markdown, json, --out, bad format", async () => {
    assert.match((await cli("report", T)).out, /^# Drift report/);
    assert.equal(JSON.parse((await cli("report", T, "--json")).out).assistantTurns, 2);
    assert.equal(JSON.parse((await cli("report", T, "--format", "json")).out).assistantTurns, 2);
    const out = join(dir, "r.md");
    assert.match((await cli("report", T, "--out", out)).out, /wrote/);
    assert.match(readFileSync(out, "utf8"), /Suggested realignment/);
    assert.match((await cli("report", T, "--format", "xml")).err, /md or json/);
  });
});

describe("replay", () => {
  test("stdout markdown, --out json/md", async () => {
    assert.match((await cli("replay", T)).out, /Drift began at: \*\*turn 2\*\*/);
    const j = join(dir, "clean.out.json");
    const r = await cli("replay", T, "--out", j);
    assert.match(r.out, /drift began at turn 2; dropped 1 turn/);
    const parsed = JSON.parse(readFileSync(j, "utf8"));
    assert.equal(parsed.messages[0].role, "system");
    // the resume file is itself a valid transcript with an embedded anchor
    assert.equal((await cli("check", j)).code, 0);
    const m = join(dir, "clean.out.md");
    await cli("replay", CLEAN, "--out", m);
    assert.match(readFileSync(m, "utf8"), /never \(no drift found\)/);
    assert.match((await cli("replay", CLEAN, "--out", m)).out, /no turn \(clean\)/);
    assert.ok(JSON.parse((await cli("replay", T, "--json")).out).clean);
  });
});

describe("watch", () => {
  test("--once processes the file and exits with drift code", async () => {
    const r = await cli("watch", T, "--once");
    assert.equal(r.code, 2);
    assert.match(r.out, /\[REALIGN\]/);
    assert.match(r.err, /watching/);
    const j = await cli("watch", CLEAN, "--once", "--json");
    assert.equal(j.code, 0);
    assert.equal(JSON.parse(j.out.split("\n")[0]!).realignment, null);
    const jd = await cli("watch", T, "--once", "--json");
    assert.match(JSON.parse(jd.out.split("\n")[1]!).realignment, /REALIGN/);
    assert.match((await cli("watch")).err, /missing <transcript>/);
  });
  test("live: picks up appended turns, stops on signal", async () => {
    const S = join(dir, "ws.json");
    writeFileSync(S, JSON.stringify({ version: 1, anchors: { default: anchor } }));
    const f = file("live.md", "User: build the TypeScript drift detection package\n");
    const out: string[] = [];
    let stop!: () => void;
    const until = new Promise<void>((r) => (stop = r));
    const done = run(["watch", f, "--state", S, "--interval", "20"], {
      out: (s) => out.push(s),
      err: () => {},
      until,
    });
    await new Promise((r) => setTimeout(r, 60));
    appendFileSync(f, "Assistant: python python bananas cooking recipes all day long\n");
    await new Promise((r) => setTimeout(r, 300));
    stop();
    assert.equal(await done, 0);
    assert.match(out.join("\n"), /DRIFT turn +1/);
  });
  test("watchTranscript handles missing, invalid and truncated files", async () => {
    const f = join(dir, "w2.json");
    const errors: string[] = [];
    const seen: number[] = [];
    const h = watchTranscript(f, anchor, (r) => seen.push(r.index), {
      intervalMs: 10_000,
      onError: (e) => errors.push(e.message),
    });
    assert.deepEqual(await h.poll(), []);
    writeFileSync(f, "[{bad");
    assert.deepEqual(await h.poll(), []);
    assert.equal(errors.length, 1);
    writeFileSync(f, JSON.stringify(turns));
    assert.equal((await h.poll()).length, 3);
    writeFileSync(f, JSON.stringify(turns.slice(0, 1)));
    await h.poll();
    assert.equal(h.monitor.turns.length, 1);
    const h2 = watchTranscript(join(dir, "w3.json"), anchor, () => {});
    writeFileSync(join(dir, "w3.json"), "[{bad");
    assert.deepEqual(await h2.poll(), []);
    h2.stop();
    h.stop();
    assert.deepEqual(seen, [0, 1, 2, 0]);
  });
});

test("bin entry point runs end-to-end", () => {
  const bin = join(dirname(fileURLToPath(import.meta.url)), "../src/bin.js");
  const out = execFileSync(process.execPath, [bin, "check", CLEAN]).toString();
  assert.match(out, /0 drift point/);
});
