// Run: npm run build && node examples/middleware-demo.mjs
// A fake "LLM" that drifts on its 2nd reply. The middleware catches it and injects a realign note
// into the 3rd request automatically, with no API keys needed.
import { withAlignment } from "@recurring-alignment/middleware";

const replies = [
  "Here is the TypeScript drift detection package plan: core engine, CLI, judges.",
  "Actually, let's rewrite everything in python, it's nicer.",
  "Back on track: the TypeScript drift detection core engine is done.",
];
let i = 0;
async function fakeLLM(messages) {
  const injected = messages.find((m) => m.content.startsWith("[REALIGN]"));
  if (injected)
    console.log("   ↳ request carried realignment:\n" + injected.content.replace(/^/gm, "      "));
  return { choices: [{ message: { content: replies[i++] } }] };
}

const chat = withAlignment(fakeLLM, {
  anchor: {
    goals: ["build a TypeScript drift detection package"],
    constraints: ["never use python"],
    decisions: [],
  },
  onCheck: (r) => console.log(`assistant turn ${r.index}: score ${r.score} (${r.severity})`),
});

const history = [];
for (const q of ["Plan the package", "Next step?", "Continue"]) {
  history.push({ role: "user", content: q });
  console.log(`> ${q}`);
  const res = await chat(history);
  history.push({ role: "assistant", content: res.choices[0].message.content });
}
