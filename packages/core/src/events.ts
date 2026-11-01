import type { TurnReport } from "./types.js";

export interface EngineEvents {
  turn: TurnReport;
  drift: { report: TurnReport; realignment: string };
  decision: { decision: string; index: number };
}
type Listener<T> = (payload: T) => void;

/** Minimal strongly-typed event emitter (no Node dependency, works in browsers). */
export class TypedEmitter<E> {
  private listeners: { [K in keyof E]?: Listener<E[K]>[] } = {};
  on<K extends keyof E>(event: K, fn: Listener<E[K]>): () => void {
    (this.listeners[event] ??= []).push(fn);
    return () => this.off(event, fn);
  }
  off<K extends keyof E>(event: K, fn: Listener<E[K]>): void {
    this.listeners[event] = this.listeners[event]?.filter((f) => f !== fn);
  }
  protected emit<K extends keyof E>(event: K, payload: E[K]): void {
    for (const fn of this.listeners[event] ?? []) fn(payload);
  }
}
