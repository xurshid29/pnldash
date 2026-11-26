import fs from "node:fs";
import path from "node:path";
import { nyDate } from "./time.js";
import type { Clock } from "./time.js";

export type JournalFields = Record<string, unknown>;

export interface Journal {
  /** Appends one line. A failure is reported on the console and otherwise ignored. */
  write(type: string, fields?: JournalFields): void;
  /** Appends one line and throws when it cannot be written: used before an order is sent. */
  writeOrThrow(type: string, fields?: JournalFields): void;
  /** The parsed lines of one New York day, oldest first; lines that do not parse are skipped. */
  readDay(date: string): JournalFields[];
}

/**
 * `logs/YYYY-MM-DD.jsonl`, one file per New York date (one US session = one file), one JSON
 * object per line: `{ "t": ISO time, "type": ..., ...fields }`.
 *
 * The access token is never passed in, and as a second guard any occurrence of it in a line is
 * replaced before the line is written.
 */
export class FileJournal implements Journal {
  private readonly dir: string;
  private readonly clock: Clock;
  private readonly secrets: string[];
  private complained = false;

  constructor(dir: string, clock: Clock, secrets: string[]) {
    this.dir = dir;
    this.clock = clock;
    this.secrets = secrets.filter((secret) => secret.length >= 8);
  }

  fileFor(date: string): string {
    return path.join(this.dir, `${date}.jsonl`);
  }

  write(type: string, fields: JournalFields = {}): void {
    try {
      this.writeOrThrow(type, fields);
    } catch (err) {
      if (!this.complained) {
        this.complained = true;
        console.error(`tws-bridge: cannot write the log in ${this.dir}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  writeOrThrow(type: string, fields: JournalFields = {}): void {
    const now = this.clock();
    let line = JSON.stringify({ t: new Date(now).toISOString(), type, ...fields });
    for (const secret of this.secrets) line = line.split(secret).join("[redacted]");
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.fileFor(nyDate(now)), `${line}\n`);
    this.complained = false;
  }

  readDay(date: string): JournalFields[] {
    let text: string;
    try {
      text = fs.readFileSync(this.fileFor(date), "utf8");
    } catch {
      return [];
    }
    const events: JournalFields[] = [];
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          events.push(parsed as JournalFields);
        }
      } catch {
        // A torn last line after a crash: skip it.
      }
    }
    return events;
  }
}

/** Keeps the lines in memory: for tests. */
export class MemoryJournal implements Journal {
  readonly events: JournalFields[] = [];
  /** Set to make `writeOrThrow` fail, as a full disk would. */
  failWrites = false;

  write(type: string, fields: JournalFields = {}): void {
    this.events.push({ type, ...fields });
  }

  writeOrThrow(type: string, fields: JournalFields = {}): void {
    if (this.failWrites) throw new Error("disk full");
    this.events.push({ type, ...fields });
  }

  readDay(): JournalFields[] {
    return [];
  }

  ofType(type: string): JournalFields[] {
    return this.events.filter((event) => event["type"] === type);
  }
}
