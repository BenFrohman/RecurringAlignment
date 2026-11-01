const STOP = new Set(
  (
    "a an the and or but if of to in on for with at by from is are was were be been being it its this that these those " +
    "i you we they he she me my your our us as do does did so can will just than then there here what which who how " +
    "about into have has had would could should shall may might also very really okay ok let lets get got now"
  ).split(" "),
);

/** Light suffix stripping so "packages"/"package", "building"/"build" match. */
export function stem(w: string): string {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith("es") && !w.endsWith("ses")) return w.slice(0, -1);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map(stem);
}

export type Vector = Map<string, number>;

/** Smoothed TF-IDF over a small ad-hoc corpus (the rolling window + anchor). */
export class TfIdf {
  private df = new Map<string, number>();
  private n = 0;
  constructor(docs: string[][] = []) {
    docs.forEach((d) => this.add(d));
  }
  add(doc: string[]): void {
    this.n++;
    for (const t of new Set(doc)) this.df.set(t, (this.df.get(t) ?? 0) + 1);
  }
  idf(t: string): number {
    return Math.log((1 + this.n) / (1 + (this.df.get(t) ?? 0))) + 1;
  }
  vector(doc: string[]): Vector {
    const tf = new Map<string, number>();
    for (const t of doc) tf.set(t, (tf.get(t) ?? 0) + 1);
    const v: Vector = new Map();
    for (const [t, c] of tf) v.set(t, (c / doc.length) * this.idf(t));
    return v;
  }
}

export function cosine(a: Vector, b: Vector): number {
  let dot = 0,
    na = 0,
    nb = 0;
  for (const [t, x] of a) {
    na += x * x;
    const y = b.get(t);
    if (y !== undefined) dot += x * y;
  }
  for (const y of b.values()) nb += y * y;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function jaccard(a: string[], b: string[]): number {
  const A = new Set(a),
    B = new Set(b);
  if (!A.size || !B.size) return 0;
  let i = 0;
  for (const x of A) if (B.has(x)) i++;
  return i / (A.size + B.size - i);
}
