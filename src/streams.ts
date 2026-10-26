/** Pure helpers for reading the opencode process output and its event stream (unit-tested). */

/** Incremental server-sent-events parser: feed text chunks, get back each event's data payload. */
export class SseParser {
  private buffer = "";

  feed(chunk: string): string[] {
    this.buffer += chunk.replace(/\r\n/g, "\n");
    const out: string[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf("\n\n")) >= 0) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const data = raw
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) out.push(data);
    }
    return out;
  }
}

/** Unwrap a /global/event frame into the instance event, tagged with its directory. */
export function unwrapGlobalEvent(data: string): { type: string; properties: any; directory?: string } | undefined {
  try {
    const parsed = JSON.parse(data);
    return parsed.payload ? { ...parsed.payload, directory: parsed.directory } : parsed;
  } catch {
    return undefined;
  }
}

/** Watches process output (which may arrive split across chunks) for the server's listen URL. */
export class ListenUrlWatcher {
  private tail = "";

  feed(chunk: string): string | undefined {
    // Keep a bounded tail so a line split across chunks still matches.
    this.tail = (this.tail + chunk).slice(-4096);
    const match = this.tail.match(/listening on (https?:\/\/[^\s]+)\s/);
    return match ? match[1].replace(/\/$/, "") : undefined;
  }
}
