import path from "node:path";

export type HashlineSnapshot = {
  absolutePath: string;
  displayPath: string;
  normalizedText: string;
  sparseEntries?: ReadonlyMap<number, string>;
};

const HASHLINE_TAG_SPACE = 0x1000;
const HASHLINE_TAG_MULTIPLIER = 0xb5d;
const HASHLINE_TAG_OFFSET = 0x0ad;

export class HashlineSnapshotStore {
  #counter = 0;
  #snapshots = new Map<string, HashlineSnapshot>();

  record(snapshot: HashlineSnapshot): string {
    const tag = (((this.#counter * HASHLINE_TAG_MULTIPLIER) + HASHLINE_TAG_OFFSET) & (HASHLINE_TAG_SPACE - 1))
      .toString(16)
      .toUpperCase()
      .padStart(3, "0");
    this.#counter += 1;
    this.#snapshots.set(tag, snapshot);
    return tag;
  }

  recordSparse(params: {
    absolutePath: string;
    displayPath: string;
    entries: Iterable<readonly [number, string]>;
  }): string {
    const sparseEntries = new Map<number, string>();
    for (const [lineNumber, content] of params.entries) {
      sparseEntries.set(lineNumber, content);
    }
    return this.record({
      absolutePath: params.absolutePath,
      displayPath: params.displayPath,
      normalizedText: Array.from(sparseEntries.values()).join("\n"),
      sparseEntries,
    });
  }

  lookup(absolutePath: string, tag: string): HashlineSnapshot | null {
    const snapshot = this.#snapshots.get(tag.trim().toUpperCase());
    return snapshot && snapshot.absolutePath === absolutePath ? snapshot : null;
  }
}

export function normalizeDisplayPath(cwd: string, absolutePath: string): string {
  const relativePath = path.relative(cwd, absolutePath);
  if (relativePath === "") {
    return path.basename(absolutePath);
  }
  if (!relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
    return relativePath.split(path.sep).join("/");
  }
  return absolutePath.split(path.sep).join("/");
}
