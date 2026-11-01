import { test } from "node:test";
import assert from "node:assert/strict";
import { AlignmentMonitor, type Anchor } from "@recurring-alignment/core";
import { defaultExtract, withAlignment, type ChatMessage } from "../src/index.js";

const anchor: Anchor = {
  goals: ["build a TypeScript drift detection package"],
  constraints: ["never use python"],
  decisions: [],
};

function scripted(replies: string[]) {
  const seen: ChatMessage[][] = [];
  let i = 0;
  const fn = async (messages: ChatMessage[]) => {
    seen.push(messages);
    return replies[i++] ?? "";
  };
  return { fn, seen };
}

test("injects realignment as a system message into the next request only", async () => {
  const { fn, seen } = scripted([
    "TypeScript drift detection package plan ready.",
    "Let's use python, way nicer bananas",
    "TypeScript drift detection package done.",
    "TypeScript drift detection package shipped.",
  ]);
  const drifts: number[] = [];
  const chat = withAlignment(fn, { anchor, onDrift: (r) => drifts.push(r.index) });
  const h: ChatMessage[] = [];
  for (const q of ["plan", "next", "go", "more"]) {
    h.push({ role: "user", content: q });
    h.push({ role: "assistant", content: await chat([...h]) });
    if (q === "next") assert.match(chat.pending()!, /^\[REALIGN\]/);
  }
  assert.deepEqual(drifts, [3]);
  assert.ok(!seen[1]!.some((m) => m.content.startsWith("[REALIGN]")));
  const inj = seen[2]!.findIndex((m) => m.content.startsWith("[REALIGN]"));
  assert.equal(seen[2]![inj]!.role, "system");
  assert.equal(inj, seen[2]!.length - 2); // right before the latest user message
  assert.ok(!seen[3]!.some((m) => m.content.startsWith("[REALIGN]")));
  assert.equal(chat.pending(), null);
  assert.equal(chat.monitor.report().driftPoints.length, 1);
});

test("user-suffix injection and custom extractor + existing monitor", async () => {
  const monitor = new AlignmentMonitor(anchor);
  const { fn, seen } = scripted(["python python bananas", "TypeScript drift detection package"]);
  const chat = withAlignment(async (m: ChatMessage[]) => ({ out: await fn(m) }), {
    monitor,
    injectAs: "user-suffix",
    extractText: (r: { out: string }) => r.out,
  });
  await chat([{ role: "user", content: "a" }]);
  await chat([
    { role: "user", content: "a" },
    { role: "assistant", content: "x" },
    { role: "user", content: "b" },
  ]);
  assert.match(seen[1]!.at(-1)!.content, /^b\n\n\[REALIGN\]/);
  assert.equal(chat.monitor, monitor);
});

test("user-suffix falls back to system when last message isn't a user", async () => {
  const { fn, seen } = scripted(["python bananas", "ok"]);
  const chat = withAlignment(fn, { anchor, injectAs: "user-suffix" });
  await chat([{ role: "user", content: "a" }]);
  await chat([]);
  assert.equal(seen[1]![0]!.role, "system");
});

test("records user decisions and calls onCheck", async () => {
  const checks: number[] = [];
  const chat = withAlignment(scripted(["TypeScript drift detection package"]).fn, {
    anchor,
    onCheck: (r) => checks.push(r.index),
  });
  await chat([{ role: "user", content: "We decided to use node:test" }]);
  assert.deepEqual(chat.monitor.anchor.decisions, ["use node:test"]);
  assert.deepEqual(checks, [1]);
});

test("requires anchor or monitor", () => {
  assert.throws(() => withAlignment(async () => "", {}), /anchor or a monitor/);
});

test("defaultExtract handles common provider shapes", () => {
  assert.equal(defaultExtract("s"), "s");
  assert.equal(defaultExtract({ choices: [{ message: { content: "oa" } }] }), "oa");
  assert.equal(defaultExtract({ content: "c" }), "c");
  assert.equal(
    defaultExtract({ content: [{ type: "text", text: "a" }, { type: "tool_use" }, { text: "b" }] }),
    "ab",
  );
  assert.equal(defaultExtract({ text: "t" }), "t");
  assert.equal(defaultExtract(null), "");
  assert.equal(defaultExtract({}), "");
});
