import { readFileSync, watchFile, unwatchFile, existsSync } from "node:fs";
import {
  AlignmentMonitor,
  parseTranscript,
  type Anchor,
  type PartialConfig,
  type TurnReport,
} from "@recurring-alignment/core";

export interface WatchHandle {
  monitor: AlignmentMonitor;
  /** Re-read the file now and process any new turns. */
  poll(): Promise<TurnReport[]>;
  stop(): void;
}

/**
 * Tail a transcript file. New turns are scored as they appear; `onReport` fires for each.
 * Uses polling (fs.watchFile) because it is reliable across editors, network drives and WSL.
 */
export function watchTranscript(
  path: string,
  anchor: Anchor,
  onReport: (r: TurnReport, monitor: AlignmentMonitor) => void,
  opts: { config?: PartialConfig; intervalMs?: number; onError?: (e: Error) => void } = {},
): WatchHandle {
  const monitor = new AlignmentMonitor(anchor, opts.config);
  let busy: Promise<TurnReport[]> = Promise.resolve([]);
  const poll = (): Promise<TurnReport[]> =>
    (busy = busy.then(async () => {
      if (!existsSync(path)) return [];
      let turns;
      try {
        turns = parseTranscript(readFileSync(path, "utf8")).turns;
      } catch (e) {
        opts.onError?.(e as Error); // partially-written file; try again next tick
        return [];
      }
      if (turns.length < monitor.turns.length) monitor.reset(); // file was truncated/rewritten
      const fresh = turns.slice(monitor.turns.length);
      const out: TurnReport[] = [];
      for (const t of fresh) {
        const r = await monitor.addTurn(t);
        out.push(r);
        onReport(r, monitor);
      }
      return out;
    }));
  const listener = () => void poll();
  watchFile(path, { interval: opts.intervalMs ?? 500 }, listener);
  return { monitor, poll, stop: () => unwatchFile(path, listener) };
}
