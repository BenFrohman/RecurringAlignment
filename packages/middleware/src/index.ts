import {
  AlignmentMonitor,
  type Anchor,
  type PartialConfig,
  type Role,
  type TurnReport,
} from "@recurring-alignment/core";

export interface ChatMessage {
  role: Role | string;
  content: string;
}
export type ChatFn<R> = (messages: ChatMessage[], ...rest: never[]) => Promise<R>;

export interface AlignmentOptions<R> {
  /** Anchor to check against (or pass an existing `monitor`). */
  anchor?: Anchor;
  monitor?: AlignmentMonitor;
  config?: PartialConfig;
  /** Where the realign note goes: as a system message (default) or appended to the last user message. */
  injectAs?: "system" | "user-suffix";
  /** Pull reply text out of your provider's response. Handles strings, OpenAI and Anthropic shapes by default. */
  extractText?: (result: R) => string;
  onDrift?: (report: TurnReport, realignment: string) => void;
  onCheck?: (report: TurnReport) => void;
}

export function defaultExtract(r: unknown): string {
  if (typeof r === "string") return r;
  const o = r as {
    content?: unknown;
    choices?: { message?: { content?: string } }[];
    text?: string;
  };
  if (o?.choices?.[0]?.message?.content) return o.choices[0].message.content;
  if (typeof o?.content === "string") return o.content;
  if (Array.isArray(o?.content))
    return (o.content as { type?: string; text?: string }[])
      .filter((c) => c.type === "text" || c.text)
      .map((c) => c.text ?? "")
      .join("");
  if (typeof o?.text === "string") return o.text;
  return "";
}

export type AlignedChat<R, F extends ChatFn<R>> = F & {
  monitor: AlignmentMonitor;
  /** Realignment queued for the next request, if any. */
  pending(): string | null;
};

/**
 * Wrap any chat-completion function. Each reply is checked; when it drifts,
 * a compact realignment note is injected into the *next* request automatically.
 */
export function withAlignment<R, F extends ChatFn<R>>(chat: F, opts: AlignmentOptions<R>): AlignedChat<R, F> {
  if (!opts.monitor && !opts.anchor) throw new Error("withAlignment: pass an anchor or a monitor");
  const monitor = opts.monitor ?? new AlignmentMonitor(opts.anchor!, opts.config);
  const extract = opts.extractText ?? (defaultExtract as (r: R) => string);
  let pending: string | null = null;
  let seen = 0;

  const wrapped = async (messages: ChatMessage[], ...rest: never[]): Promise<R> => {
    // Record user turns we haven't seen (so auto-recorded decisions and topic context stay current).
    const users = messages.filter((m) => m.role === "user");
    for (const m of users.slice(seen)) await monitor.addTurn({ role: "user", content: m.content });
    seen = users.length;

    let outgoing = messages;
    if (pending) {
      const note = pending;
      pending = null;
      if (opts.injectAs === "user-suffix" && outgoing.at(-1)?.role === "user") {
        const last = outgoing.at(-1)!;
        outgoing = [...outgoing.slice(0, -1), { ...last, content: `${last.content}\n\n${note}` }];
      } else {
        const at = Math.max(0, outgoing.length - 1);
        outgoing = [...outgoing.slice(0, at), { role: "system", content: note }, ...outgoing.slice(at)];
      }
    }
    const result = await chat(outgoing, ...rest);
    const report = await monitor.addTurn({ role: "assistant", content: extract(result) });
    opts.onCheck?.(report);
    if (report.drifted) {
      pending = monitor.realignment(report);
      opts.onDrift?.(report, pending);
    }
    return result;
  };
  return Object.assign(wrapped, { monitor, pending: () => pending }) as unknown as AlignedChat<R, F>;
}
