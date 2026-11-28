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
  /**
   * One more secret to replace in every line written from now on: the alert feed's token
   * arrives over HTTP after the start, long after the journal was made.
   */
  addSecret(secret: string): void;
}

/** Shorter strings are not treated as secrets: they would blank out ordinary words. */
const MIN_SECRET_LENGTH = 8;

/**
 * Adds a secret to a list kept longest first, so a secret that contains a shorter one is replaced
 * whole instead of leaving its other half in the line.
 */
function addTo(secrets: string[], secret: string): void {
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH || secrets.includes(secret)) return;
  secrets.push(secret);
  secrets.sort((a, b) => b.length - a.length);
}

function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join("[redacted]");
  return out;
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
  private readonly secrets: string[] = [];
  private complained = false;

  constructor(dir: string, clock: Clock, secrets: string[]) {
    this.dir = dir;
    this.clock = clock;
    for (const secret of secrets) addTo(this.secrets, secret);
  }

  addSecret(secret: string): void {
    addTo(this.secrets, secret);
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
    const line = redact(JSON.stringify({ t: new Date(now).toISOString(), type, ...fields }), this.secrets);
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

/**
 * The replacement FileJournal makes in its line, made in the strings of a value: in nested
 * objects and lists too, and in keys, as the line holds those as well. Other values are kept.
 */
function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redact(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key, secrets), redactValue(item, secrets)]));
  }
  return value;
}

/**
 * Keeps the lines in memory: for tests. Secrets are replaced as FileJournal replaces them, so a
 * test can show that a token never reaches the log; with no secret the lines are kept as given.
 */
export class MemoryJournal implements Journal {
  readonly events: JournalFields[] = [];
  /** Set to make `writeOrThrow` fail, as a full disk would. */
  failWrites = false;
  private readonly secrets: string[] = [];

  constructor(secrets: string[] = []) {
    for (const secret of secrets) addTo(this.secrets, secret);
  }

  addSecret(secret: string): void {
    addTo(this.secrets, secret);
  }

  write(type: string, fields: JournalFields = {}): void {
    this.events.push(this.line(type, fields));
  }

  writeOrThrow(type: string, fields: JournalFields = {}): void {
    if (this.failWrites) throw new Error("disk full");
    this.events.push(this.line(type, fields));
  }

  private line(type: string, fields: JournalFields): JournalFields {
    const line = { type, ...fields };
    return this.secrets.length === 0 ? line : (redactValue(line, this.secrets) as JournalFields);
  }

  readDay(): JournalFields[] {
    return [];
  }

  ofType(type: string): JournalFields[] {
    return this.events.filter((event) => event["type"] === type);
  }
}
