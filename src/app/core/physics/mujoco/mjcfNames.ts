export type MjcfNameMap = {
  links: Record<string, string>;
  joints: Record<string, string>;
  linksByMjcf?: Record<string, string>;
  jointsByMjcf?: Record<string, string>;
  linkDocIds?: Record<string, string>;
};

export type NameWarningSink = (message: string) => void;

export function sanitizeMjcfName(raw: string, fallback = "unnamed"): string {
  const base = String(raw ?? "").trim();
  let name = base.replace(/[^a-zA-Z0-9_]+/g, "_");
  if (!name) name = fallback;
  if (!/^[A-Za-z_]/.test(name)) name = `_${name}`;
  return name;
}

export class NameRegistry {
  private used = new Set<string>();
  private counters = new Map<string, number>();
  private fallback: string;
  private warn?: NameWarningSink;
  private label: string;

  constructor(fallback = "unnamed", warn?: NameWarningSink, label = "name") {
    this.fallback = fallback;
    this.warn = warn;
    this.label = label;
  }

  claim(raw: string): string {
    const baseRaw = String(raw ?? "");
    const base = sanitizeMjcfName(baseRaw, this.fallback);
    if (!this.used.has(base)) {
      this.used.add(base);
      if (base !== baseRaw) {
        this.warn?.(`Renamed ${this.label} '${baseRaw}' to '${base}' for MJCF compatibility.`);
      }
      return base;
    }

    let index = this.counters.get(base) ?? 1;
    let candidate = `${base}_${index}`;
    while (this.used.has(candidate)) {
      index += 1;
      candidate = `${base}_${index}`;
    }
    this.counters.set(base, index + 1);
    this.used.add(candidate);
    this.warn?.(`Duplicate ${this.label} '${baseRaw}' renamed to '${candidate}'.`);
    return candidate;
  }
}
