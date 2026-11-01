export interface Parsed {
  positional: string[];
  flags: Record<string, string[]>;
  bools: Set<string>;
}
const BOOL = new Set(["json", "help", "h", "once", "quiet", "force"]);

/** Tiny argv parser: `--k v`, `--k=v`, repeated flags, and boolean flags. */
export function parseArgs(argv: string[]): Parsed {
  const p: Parsed = { positional: [], flags: {}, bools: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("-")) {
      const [k, inline] = a.replace(/^--?/, "").split(/=(.*)/s, 2) as [string, string | undefined];
      if (BOOL.has(k) && inline === undefined) p.bools.add(k);
      else {
        const v = inline ?? argv[++i];
        if (v === undefined) throw new Error(`missing value for --${k}`);
        (p.flags[k] ??= []).push(v);
      }
    } else p.positional.push(a);
  }
  return p;
}
export const one = (p: Parsed, k: string): string | undefined => p.flags[k]?.at(-1);
export const many = (p: Parsed, k: string): string[] => p.flags[k] ?? [];
