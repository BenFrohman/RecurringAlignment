# Judges & middleware

## LLM judges (optional)

```ts
import { AlignmentMonitor } from "@recurring-alignment/core";
import { OpenAICompatibleJudge, AnthropicCompatibleJudge, MockJudge } from "@recurring-alignment/judges";

const judge = new OpenAICompatibleJudge({ model: "gpt-4o-mini" }); // reads OPENAI_API_KEY
const monitor = new AlignmentMonitor(anchor, { judge });
```

| Judge                      | Env vars                                                              | Notes                                                                         |
| -------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `OpenAICompatibleJudge`    | `OPENAI_API_KEY`, optional `OPENAI_BASE_URL`, `OPENAI_MODEL`          | Any `/chat/completions` API: OpenAI, xAI, Groq, OpenRouter, Ollama, LM Studio |
| `AnthropicCompatibleJudge` | `ANTHROPIC_API_KEY`, optional `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL` | `/v1/messages`                                                                |
| `MockJudge`                | none                                                                  | Deterministic; for tests and demos                                            |

The CLI equivalent is `--judge openai|anthropic|mock`. Keys come only from the environment or the constructor. They are never written to disk or logged. You can write your own judge by implementing `{ name, evaluate({ anchor, history, turn }) → { score, reasons } }`.

## Middleware

```ts
import OpenAI from "openai";
import { withAlignment } from "@recurring-alignment/middleware";

const openai = new OpenAI();
const chat = withAlignment((messages) => openai.chat.completions.create({ model: "gpt-4o-mini", messages }), {
  anchor,
  onDrift: (report, note) => console.warn(`drift at turn ${report.index}`, note),
});

const res = await chat(history); // same return type as the wrapped function
```

- Every reply is scored. If it drifts, the `[REALIGN]` note is injected into the **next** request, either as a system message just before the latest user message (the default) or appended to the user message (`injectAs: "user-suffix"`).
- Reply text is extracted automatically from strings and from OpenAI or Anthropic response shapes. Use `extractText` for anything else.
- `chat.monitor` exposes the underlying `AlignmentMonitor`, and `chat.pending()` shows any queued note.
