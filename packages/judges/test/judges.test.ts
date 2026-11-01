import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { check, type Anchor } from "@recurring-alignment/core";
import {
  AnthropicCompatibleJudge,
  MockJudge,
  OpenAICompatibleJudge,
  buildJudgePrompt,
  createJudge,
  parseJudgeOutput,
  type FetchLike,
} from "../src/index.js";

const anchor: Anchor = {
  goals: ["ship it"],
  constraints: ["never use python", { rule: "r2" }],
  persona: "Taloose",
  decisions: ["d1"],
};
const turn = { role: "assistant" as const, content: "reply" };

function fakeFetch(body: unknown, ok = true, status = 200) {
  const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
  const f: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { f, calls };
}

describe("prompt + parsing", () => {
  test("prompt includes anchor and context", () => {
    const p = buildJudgePrompt(anchor, [{ role: "user", content: "hello" }], turn);
    for (const s of ["ship it", "never use python; r2", "Taloose", "d1", "USER: hello", "reply"])
      assert.ok(p.includes(s), s);
    const e = buildJudgePrompt({ goals: [], constraints: [], decisions: [] }, [], turn);
    assert.equal((e.match(/\(none\)/g) ?? []).length, 5);
  });
  test("parseJudgeOutput tolerates fences, clamps, validates", () => {
    assert.deepEqual(parseJudgeOutput('```json\n{"score": 1.7, "reasons": ["a", 2]}\n```'), {
      score: 1,
      reasons: ["a", "2"],
    });
    assert.deepEqual(parseJudgeOutput('{"score": -1}'), { score: 0, reasons: [] });
    assert.throws(() => parseJudgeOutput("nope"), /no JSON/);
    assert.throws(() => parseJudgeOutput('{"score":"x"}'), /numeric/);
  });
});

describe("HTTP judges", () => {
  test("OpenAI-compatible request shape and response", async () => {
    const { f, calls } = fakeFetch({
      choices: [{ message: { content: '{"score":0.7,"reasons":["off"]}' } }],
    });
    const j = new OpenAICompatibleJudge({ apiKey: "k", baseUrl: "http://x/v1/", model: "m", fetch: f });
    assert.deepEqual(await j.evaluate({ anchor, history: [], turn }), { score: 0.7, reasons: ["off"] });
    assert.equal(calls[0]!.url, "http://x/v1/chat/completions");
    assert.equal(calls[0]!.init.headers.authorization, "Bearer k");
    assert.equal(JSON.parse(calls[0]!.init.body).model, "m");
  });
  test("Anthropic-compatible request shape and response", async () => {
    const { f, calls } = fakeFetch({ content: [{ type: "text", text: '{"score":0.2,"reasons":[]}' }] });
    const j = new AnthropicCompatibleJudge({ apiKey: "k2", fetch: f });
    assert.equal((await j.evaluate({ anchor, history: [], turn })).score, 0.2);
    assert.equal(calls[0]!.url, "https://api.anthropic.com/v1/messages");
    assert.equal(calls[0]!.init.headers["x-api-key"], "k2");
    assert.equal(calls[0]!.init.headers["anthropic-version"], "2023-06-01");
  });
  test("env key fallback and missing key error", () => {
    const old = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    assert.throws(() => new OpenAICompatibleJudge(), /OPENAI_API_KEY/);
    process.env.OPENAI_API_KEY = "envkey";
    assert.equal(new OpenAICompatibleJudge().name, "openai-judge");
    if (old === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = old;
  });
  test("HTTP errors and empty bodies surface as errors; engine fails open", async () => {
    const bad = new OpenAICompatibleJudge({ apiKey: "k", fetch: fakeFetch({ error: "nope" }, false, 401).f });
    await assert.rejects(bad.evaluate({ anchor, history: [], turn }), /HTTP 401/);
    const empty = new AnthropicCompatibleJudge({ apiKey: "k", fetch: fakeFetch({}).f });
    await assert.rejects(empty.evaluate({ anchor, history: [], turn }), /no JSON/);
    const empty2 = new OpenAICompatibleJudge({ apiKey: "k", fetch: fakeFetch({}).f });
    await assert.rejects(empty2.evaluate({ anchor, history: [], turn }), /no JSON/);
    const r = await check(anchor, [{ role: "assistant", content: "ship it now" }], { judge: bad });
    assert.equal(r.maxScore, 0);
  });
  test("timeout", async () => {
    const hang: FetchLike = () => new Promise(() => {});
    const j = new OpenAICompatibleJudge({ apiKey: "k", fetch: hang, timeoutMs: 10 });
    await assert.rejects(j.evaluate({ anchor, history: [], turn }), /timed out/);
  });
});

describe("mock + factory", () => {
  test("MockJudge default, fixed and function results", async () => {
    const m = new MockJudge();
    assert.equal(
      (await m.evaluate({ turn: { role: "assistant", content: "totally off-topic" } })).score,
      0.9,
    );
    assert.equal((await m.evaluate({ turn })).score, 0);
    assert.equal(m.calls, 2);
    assert.equal((await new MockJudge({ score: 0.3, reasons: [] }).evaluate({ turn })).score, 0.3);
    assert.equal((await new MockJudge(() => ({ score: 0.4, reasons: [] })).evaluate({ turn })).score, 0.4);
  });
  test("createJudge", () => {
    assert.equal(createJudge("none"), undefined);
    assert.equal(createJudge(""), undefined);
    assert.equal(createJudge("mock")?.name, "mock-judge");
    assert.equal(createJudge("openai", { apiKey: "k" })?.name, "openai-judge");
    assert.equal(createJudge("anthropic", { apiKey: "k" })?.name, "anthropic-judge");
    assert.throws(() => createJudge("x"), /unknown judge/);
  });
});
