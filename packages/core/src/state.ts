import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Anchor } from "./types.js";

export interface State {
  version: 1;
  anchors: Record<string, Anchor>;
}

export const emptyAnchor = (): Anchor => ({ goals: [], constraints: [], decisions: [] });

/** Validate and normalise an unknown value into an Anchor. Throws with a helpful message. */
export function toAnchor(v: unknown, where = "anchor"): Anchor {
  if (!v || typeof v !== "object") throw new Error(`${where} must be an object`);
  const o = v as Record<string, unknown>;
  const arr = (k: string) => {
    const x = o[k] ?? [];
    if (!Array.isArray(x)) throw new Error(`${where}.${k} must be an array`);
    return x;
  };
  if (o.persona !== undefined && typeof o.persona !== "string")
    throw new Error(`${where}.persona must be a string`);
  return {
    goals: arr("goals").map(String),
    constraints: arr("constraints") as Anchor["constraints"],
    decisions: arr("decisions").map(String),
    ...(o.persona ? { persona: o.persona as string } : {}),
  };
}

export function loadState(path: string): State {
  if (!existsSync(path)) return { version: 1, anchors: {} };
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<State>;
  if (raw.version !== 1) throw new Error(`${path}: unsupported state version ${String(raw.version)}`);
  const anchors: Record<string, Anchor> = {};
  for (const [k, v] of Object.entries(raw.anchors ?? {})) anchors[k] = toAnchor(v, `anchors.${k}`);
  return { version: 1, anchors };
}

/** Atomic write (temp file + rename) so a crash never leaves a half-written state file. */
export function saveState(path: string, state: State): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, path);
}
