# How drift scoring works (the math)

Every **assistant** turn gets a drift score between 0 and 1. User and system turns are never scored, but they are used as context. The score is a weighted sum of up to six signals, and each signal is a number from 0 to 1.

## 1. Tokens

Text is lowercased and stripped of punctuation. Stop-words ("the", "and", "let's"…) and words of 2 letters or fewer are removed. Light stemming is applied (`packages → package`, `building → build`, `parsed → pars`).

```
"Let's build the drift detection package"  →  [build, drift, detection, package]
```

## 2. TF-IDF

Within a small ad-hoc corpus of documents $D$ (for example: the context turns, the goals, and the reply), the weight of term $t$ in document $d$ is

$$
\mathrm{tf}(t,d) = \frac{\mathrm{count}(t,d)}{|d|}
\qquad
\mathrm{idf}(t) = \ln\!\frac{1 + N}{1 + \mathrm{df}(t)} + 1
\qquad
w_{t,d} = \mathrm{tf}(t,d)\cdot \mathrm{idf}(t)
$$

where $N = |D|$ and $\mathrm{df}(t)$ is the number of documents that contain $t$. This is the "smoothed" IDF. Words that appear everywhere get $\mathrm{idf}=1$, and rarer words weigh more.

## 3. Cosine similarity

Two weight vectors $\mathbf{a}, \mathbf{b}$ are compared by the angle between them:

$$
\cos(\mathbf{a},\mathbf{b}) = \frac{\sum_t a_t\, b_t}{\sqrt{\sum_t a_t^2}\;\sqrt{\sum_t b_t^2}} \in [0, 1]
$$

The result is 1 when the two texts use the same words in the same proportions, and 0 when they share no words.

## 4. The signals

Let $R$ be the reply's tokens, $G$ the goal tokens, and $W$ the tokens of the last `windowSize` **on-track** turns. Turns already flagged as drifted are left out, so a drift run can't become its own context.

| Signal         | Raw value $s \in [0,1]$                                                                                                                       | Fires when                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **goal**       | $g = \max\big(\frac{\lvert \mathrm{uniq}(G)\cap R\rvert}{\lvert \mathrm{uniq}(G)\rvert},\ \cos(R, G)\big)$, $\;s = 1 - g/g_{\min}$            | $g < g_{\min}$ (default 0.2)                                                      |
| **topic**      | $\tau = \cos(R,\ W \cup G)$, $\;s = 1 - \tau/\tau_{\min}$                                                                                     | $\tau < \tau_{\min}$ (default 0.08), there is context, and $\lvert R\rvert \ge 5$ |
| **constraint** | $s = 1$                                                                                                                                       | a forbidden word, phrase, or regex from a rule appears                            |
| **decision**   | $s = \min(1, 0.5 + o)$ with reversal words ("actually", "instead", "switch to"…) and $o\ge0.3$; or $s = 0.8\,o$ with negation and $o \ge 0.5$ | $o$ = share of the decision's words present in the reply                          |
| **persona**    | $s = 1$                                                                                                                                       | the reply says "I'm X" / "my name is X" and X ≠ the persona's name                |
| **judge**      | $s =$ the judge's score                                                                                                                       | an optional LLM judge returns a score > 0                                         |

## 5. The weighted score

$$
\text{score} = \min\Big(1,\ \sum_{k} \omega_k \, s_k\Big)
$$

Default weights $\omega$: goal 0.3, constraint 0.6, decision 0.5, persona 0.4, topic 0.3, judge 1.0. You can change any of them with `config.weights` or `--weight kind=value`.

- **drifted** when score ≥ `threshold` (default 0.5)
- **severity**: `none` < 0.2 ≤ `low` < 0.5 ≤ `medium` < 0.8 ≤ `high`

## 6. Worked example

**Anchor goal:** "build a TypeScript drift detection package".
**Context:** the user said "Let's build the drift detection package".
**Reply:** "The detection step can wait; first let me explain how compilers parse source files into syntax trees".

Tokens:

```
G = [build, typescript, drift, detection, package]                (5)
W = [build, drift, detection, package]                            (4)
R = [detection, step, wait, first, explain, compiler, parse,
     source, file, syntax, tree]                                  (11)
```

**Goal signal.** One of the 5 goal words ("detection") appears, so coverage is $1/5 = 0.20$. That is not below $g_{\min}=0.2$, so the goal signal is **0** and contributes nothing.

**Topic signal.** The corpus is $D = \{W, G, R\}$, so $N = 3$. The context document is $W \cup G$ (9 tokens).

| term                                    | df  | idf $=\ln\frac{4}{1+\mathrm{df}}+1$ | weight in reply                    | weight in context                 |
| --------------------------------------- | --- | ----------------------------------- | ---------------------------------- | --------------------------------- |
| detection                               | 3   | 1.0000                              | $\frac{1}{11}\cdot1.0000 = 0.0909$ | $\frac{2}{9}\cdot1.0000 = 0.2222$ |
| build                                   | 2   | 1.2877                              | 0                                  | $\frac{2}{9}\cdot1.2877 = 0.2862$ |
| typescript                              | 1   | 1.6931                              | 0                                  | $\frac{1}{9}\cdot1.6931 = 0.1881$ |
| step (and the 9 other reply-only words) | 1   | 1.6931                              | $\frac{1}{11}\cdot1.6931 = 0.1539$ | 0                                 |

$$
\text{dot} = 0.0909 \times 0.2222 = 0.0202,\quad
\lVert R\rVert = 0.4952,\quad
\lVert W\cup G\rVert = 0.5748
$$

$$
\tau = \frac{0.0202}{0.4952 \times 0.5748} = 0.071 \;<\; 0.08
\;\Rightarrow\;
s_{\text{topic}} = 1 - \frac{0.071}{0.08} = 0.113
$$

**Score.** $0.3 \times 0.113 = 0.034$, so severity is **none** and the turn is not drifted. The tool sees a small wobble but doesn't fire.

**Now suppose** the reply had been "Sure, here is a python script for scraping football scores" and the anchor had the rule "never use python":

$$
\text{score} = \min(1,\ \underbrace{0.3\cdot 1}_{\text{goal: 0\% overlap}} + \underbrace{0.6 \cdot 1}_{\text{constraint}} + \underbrace{0.3 \cdot 1}_{\text{topic: }\tau=0}) = \min(1, 1.2) = 1.0 \;\Rightarrow\; \textbf{high}
$$

You can reproduce both numbers with:

```ts
import { AlignmentMonitor } from "@recurring-alignment/core";
const m = new AlignmentMonitor({
  goals: ["build a TypeScript drift detection package"],
  constraints: ["never use python"],
  decisions: [],
});
await m.addTurn({ role: "user", content: "Let's build the drift detection package" });
console.log(
  m.scoreTurn({
    role: "assistant",
    content:
      "The detection step can wait; first let me explain how compilers parse source files into syntax trees",
  }).score,
); // 0.034
```

## 7. Drift Replay: where drift _began_

Replay walks back from each drifted turn $i$ over earlier assistant turns whose score is ≥ the `low` severity cut-off (the "slide" into drift). The earliest of those turns is the **drift start**. It drops that whole run, plus noise turns ("ok", "thanks"…). It then ranks sentences from the remaining turns by $\cos(\text{sentence}, G)$ and keeps the top few as **key facts**, skipping near-duplicates (more than 70% token overlap).

Token estimates use $\lceil \text{chars}/4 \rceil$, a standard rough figure for English text. You can pass your own tokenizer with `estimateTokens`.
