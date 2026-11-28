import { systemClock } from "./time.js";
import type { Clock } from "./time.js";

/**
 * The client for the pnldash server's alert feed: `GET {server}/api/tv/feed?since=…`, a
 * Server-Sent-Events stream that first replays the 📐 setups newer than `since` (oldest first)
 * and then sends the live ones. It stays connected on its own: a dropped or silent stream is
 * reconnected with a growing pause, and the reconnect asks for what came after the last setup
 * it delivered, so nothing said during the gap is lost. A refused token is the one thing it does
 * not retry: only a new `start()` (a new pairing) tries again.
 *
 * The token travels in the Authorization header only. It is never put in the URL, and it is
 * scrubbed from every error text, so it cannot reach the status, the console or the log.
 */

export interface FeedSetup {
  id: string;
  ticker: string;
  /** ISO time the server received the alert. */
  at: string;
  stage: string;
  price: number | null;
  /** "notify" | "quiet" | "log" as the server sends it; "unknown" when it sent none. */
  mode: string;
  why: string | null;
  setup: Record<string, unknown>;
}

export type FeedState = "off" | "connecting" | "connected" | "retrying" | "unauthorized";

export interface FeedStatus {
  state: FeedState;
  server: string | null;
  /** ISO, when the current connection said hello. */
  connected_at: string | null;
  /** ISO, when anything (a setup, hello, a keepalive) last arrived. */
  last_event_at: string | null;
  /** Why it is retrying / unauthorized, in plain words; never contains the token. */
  error: string | null;
}

export interface AlertFeedOptions {
  onSetup: (setup: FeedSetup) => void;
  /** Called on every change of `state` (and when the server or the error text changes). */
  onState?: (status: FeedStatus) => void;
  clock?: Clock;
  fetch?: typeof fetch;
  /** Default 1000. */
  reconnectMinMs?: number;
  /** Default 15000. */
  reconnectMaxMs?: number;
  /** Default 45000: nothing at all received for this long → reconnect. The server sends a keepalive every 15 s. */
  idleTimeoutMs?: number;
  /** Default 120: how far back the first connection asks. */
  replaySec?: number;
}

/** One dispatched Server-Sent Event. */
export interface SseEvent {
  event: string;
  data: string;
}

/**
 * A server that never ends a line or an event would otherwise grow the buffer without end; a
 * setup is a few kilobytes.
 */
const MAX_PENDING_CHARS = 1024 * 1024;
/** How far before the newest setup delivered a reconnect asks the replay to start. */
export const SINCE_OVERLAP_MS = 2000;

/**
 * Splits a decoded text stream into events, as the EventSource standard reads it: lines end in
 * "\n", "\r\n" or "\r" (also when a chunk ends between the "\r" and the "\n"), a blank line ends
 * an event, several `data:` lines join with "\n", one space after the colon is dropped, and lines
 * starting with ":" are comments. An event with no `data:` line is not dispatched, and an event
 * cut off by the end of the stream is dropped.
 */
export class SseParser {
  /** Comment lines seen, such as the server's `: keepalive`. */
  comments = 0;
  private partial = "";
  /** The last chunk ended in "\r": a "\n" at the start of the next one belongs to that line end. */
  private afterCr = false;
  private eventName = "";
  private data: string | null = null;

  /** Feeds decoded text in; returns the events completed by it. Throws on an over-long event. */
  push(chunk: string): SseEvent[] {
    const out: SseEvent[] = [];
    let text = chunk;
    if (this.afterCr && text.length > 0) {
      if (text.startsWith("\n")) text = text.slice(1);
      this.afterCr = false;
    }
    const buffer = this.partial + text;
    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      const ch = buffer[i];
      if (ch !== "\n" && ch !== "\r") continue;
      this.line(buffer.slice(start, i), out);
      if (ch === "\r") {
        if (i + 1 < buffer.length) {
          if (buffer[i + 1] === "\n") i++;
        } else {
          this.afterCr = true;
        }
      }
      start = i + 1;
    }
    this.partial = buffer.slice(start);
    if (this.partial.length + (this.data?.length ?? 0) > MAX_PENDING_CHARS) {
      throw new Error("the server sent an event longer than 1 MiB");
    }
    return out;
  }

  private line(line: string, out: SseEvent[]): void {
    if (line === "") {
      if (this.data !== null) out.push({ event: this.eventName === "" ? "message" : this.eventName, data: this.data });
      this.eventName = "";
      this.data = null;
      return;
    }
    if (line.startsWith(":")) {
      this.comments++;
      return;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.eventName = value;
    else if (field === "data") this.data = this.data === null ? value : `${this.data}\n${value}`;
    // `id` and `retry` are not used: the reconnect asks by time, with its own pause.
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** A setup event's data, checked; null when it is not one (it is then dropped). */
function parseSetup(data: string): FeedSetup | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isPlainObject(raw)) return null;
  const { id, ticker, at, stage, price, mode, why, setup } = raw;
  if (!nonEmptyString(id) || !nonEmptyString(ticker) || !nonEmptyString(stage)) return null;
  if (typeof at !== "string" || !Number.isFinite(Date.parse(at))) return null;
  if (!isPlainObject(setup)) return null;
  return {
    id,
    ticker,
    at,
    stage,
    price: typeof price === "number" && Number.isFinite(price) ? price : null,
    // Never guessed as "notify": a setup the server did not mark is not one to act on.
    mode: typeof mode === "string" ? mode : "unknown",
    why: typeof why === "string" ? why : null,
    setup,
  };
}

/** An error in plain words: Node's fetch says only "fetch failed" and keeps the reason in `cause`. */
function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) return cause.message || (cause as NodeJS.ErrnoException).code || err.message;
  return err.message;
}

function duration(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

function checkServer(server: unknown): void {
  let url: URL | null = null;
  try {
    url = typeof server === "string" ? new URL(server) : null;
  } catch {
    url = null;
  }
  if (url === null || (url.protocol !== "http:" && url.protocol !== "https:") || url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") {
    throw new TypeError("the feed server must be an http(s) address with no query and no credentials");
  }
}

const RUNNING: readonly FeedState[] = ["connecting", "connected", "retrying"];

function offStatus(): FeedStatus {
  return { state: "off", server: null, connected_at: null, last_event_at: null, error: null };
}

export class AlertFeed {
  private readonly onSetup: (setup: FeedSetup) => void;
  private readonly onState: ((status: FeedStatus) => void) | undefined;
  private readonly clock: Clock;
  private readonly fetchFn: typeof fetch;
  private readonly reconnectMinMs: number;
  private readonly reconnectMaxMs: number;
  private readonly idleTimeoutMs: number;
  private readonly replaySec: number;

  private server: string | null = null;
  private token: string | null = null;
  private current: FeedStatus = offStatus();
  /** Each connection attempt's number: whatever an older attempt finishes late is ignored. */
  private attempt = 0;
  private controller: AbortController | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private nextDelayMs: number;
  private lastDelayMs: number | null = null;
  /** The newest `at` delivered (ms) and the server it came from: where a reconnect's replay starts. */
  private lastSetupMs: number | null = null;
  private lastSetupServer: string | null = null;
  private readonly tally = { connects: 0, setups: 0, dropped: 0, handlerErrors: 0 };

  constructor(options: AlertFeedOptions) {
    this.onSetup = options.onSetup;
    this.onState = options.onState;
    this.clock = options.clock ?? systemClock;
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.reconnectMinMs = Math.max(1, options.reconnectMinMs ?? 1000);
    this.reconnectMaxMs = Math.max(this.reconnectMinMs, options.reconnectMaxMs ?? 15_000);
    this.idleTimeoutMs = Math.max(1, options.idleTimeoutMs ?? 45_000);
    this.replaySec = Math.max(0, options.replaySec ?? 120);
    this.nextDelayMs = this.reconnectMinMs;
  }

  /**
   * Connects (or reconnects) with these credentials. Called again with the same pair while it
   * is connecting, connected or retrying: nothing happens. With a different pair, or after
   * `stop()` or a refused token: the old connection is dropped first and a new one starts.
   */
  start(server: string, token: string): void {
    checkServer(server);
    if (typeof token !== "string" || token === "") throw new TypeError("the feed token is empty");
    if (RUNNING.includes(this.current.state) && server === this.server && token === this.token) return;
    this.halt();
    // What was delivered from another server says nothing about where this one's replay starts.
    if (server !== this.lastSetupServer) {
      this.lastSetupMs = null;
      this.lastSetupServer = server;
    }
    this.server = server;
    this.token = token;
    this.nextDelayMs = this.reconnectMinMs;
    this.lastDelayMs = null;
    this.connect();
    this.update({ state: "connecting", server, connected_at: null, last_event_at: null, error: null });
  }

  /** Ends it: aborts the request, clears timers, state "off". */
  stop(): void {
    this.halt();
    this.server = null;
    this.token = null;
    this.update(offStatus());
  }

  status(): FeedStatus {
    return { ...this.current };
  }

  /** Counts since this feed was made: connection attempts, setups delivered, setups dropped as malformed, handler failures. */
  get counts(): { connects: number; setups: number; dropped: number; handlerErrors: number } {
    return { ...this.tally };
  }

  /** The pause before the reconnect that is waiting or was made last; null before the first failure of a `start()`. */
  get retryDelayMs(): number | null {
    return this.lastDelayMs;
  }

  private connect(): void {
    const server = this.server;
    const token = this.token;
    if (server === null || token === null) return;
    const attempt = ++this.attempt;
    const controller = new AbortController();
    this.controller = controller;
    // Armed before the request: a server that takes the connection and never answers is silence too.
    this.idleTimer = setTimeout(() => this.fail(attempt, `nothing arrived for ${duration(this.idleTimeoutMs)}`), this.idleTimeoutMs);
    this.tally.connects++;
    // A little before the newest setup delivered, not at it: the server's times are whole seconds
    // and it replays what is strictly newer, so a second setup of that same second would be
    // missed. The few it sends again are told apart by their id, by whoever takes the setups.
    const since = new Date(
      this.lastSetupMs === null ? this.clock() - this.replaySec * 1000 : this.lastSetupMs - SINCE_OVERLAP_MS,
    ).toISOString();
    const url = `${server.replace(/\/+$/, "")}/api/tv/feed?${new URLSearchParams({ since }).toString()}`;
    this.run(attempt, url, token, controller.signal).catch((err: unknown) => this.fail(attempt, `the feed failed (${describe(err)})`));
  }

  private async run(attempt: number, url: string, token: string, signal: AbortSignal): Promise<void> {
    const fetchFn = this.fetchFn;
    let response: Response;
    try {
      response = await fetchFn(url, {
        headers: { authorization: `Bearer ${token}`, accept: "text/event-stream", "cache-control": "no-cache" },
        signal,
        // A redirect is reported, not followed: the token is for this server only.
        redirect: "manual",
      });
    } catch (err) {
      this.fail(attempt, `cannot reach the server (${describe(err)})`);
      return;
    }
    if (attempt !== this.attempt) return;
    if (response.status === 401 || response.status === 403) {
      this.refuse(attempt, response.status);
      return;
    }
    if (response.status !== 200) {
      this.fail(attempt, `the server answered HTTP ${response.status}`);
      return;
    }
    const type = response.headers.get("content-type") ?? "";
    if (!/^text\/event-stream\b/i.test(type)) {
      this.fail(attempt, `the server did not answer with an event stream (${type === "" ? "no content type" : type})`);
      return;
    }
    if (response.body === null) {
      this.fail(attempt, "the server's answer had no body");
      return;
    }
    this.arrived();
    const reader = response.body.getReader();
    // Decoding in stream mode keeps a character split between two chunks whole.
    const decoder = new TextDecoder();
    const parser = new SseParser();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (attempt !== this.attempt) return;
        if (done) break;
        this.arrived();
        for (const event of parser.push(decoder.decode(value, { stream: true }))) {
          this.dispatch(event);
          // A handler may have stopped or restarted the feed.
          if (attempt !== this.attempt) return;
        }
      }
    } catch (err) {
      this.fail(attempt, `the stream broke (${describe(err)})`);
      return;
    }
    this.fail(attempt, "the server closed the stream");
  }

  private dispatch(event: SseEvent): void {
    if (event.event === "hello") this.hello();
    else if (event.event === "setup") this.deliver(event.data);
  }

  private hello(): void {
    // The server answers again: the next failure starts over at the shortest pause.
    this.nextDelayMs = this.reconnectMinMs;
    if (this.current.state === "connected") return;
    this.update({ state: "connected", connected_at: new Date(this.clock()).toISOString(), error: null });
  }

  private deliver(data: string): void {
    const setup = parseSetup(data);
    if (setup === null) {
      this.tally.dropped++;
      return;
    }
    const atMs = Date.parse(setup.at);
    if (this.lastSetupMs === null || atMs > this.lastSetupMs) this.lastSetupMs = atMs;
    this.tally.setups++;
    try {
      const result: unknown = this.onSetup(setup);
      if (isThenable(result)) result.then(undefined, (err: unknown) => this.handlerFailed(err));
    } catch (err) {
      this.handlerFailed(err);
    }
  }

  private handlerFailed(err: unknown): void {
    this.tally.handlerErrors++;
    console.error(`tws-bridge: the alert feed's handler failed: ${this.scrub(describe(err))}`);
  }

  private arrived(): void {
    this.idleTimer?.refresh();
    this.current = { ...this.current, last_event_at: new Date(this.clock()).toISOString() };
  }

  private fail(attempt: number, reason: string): void {
    if (attempt !== this.attempt) return;
    this.halt();
    const delay = this.nextDelayMs;
    this.nextDelayMs = Math.min(delay * 2, this.reconnectMaxMs);
    this.lastDelayMs = delay;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
    this.update({ state: "retrying", connected_at: null, error: reason });
  }

  /** A refused token is not retried: asking again with it would be refused again. */
  private refuse(attempt: number, status: number): void {
    if (attempt !== this.attempt) return;
    this.halt();
    this.update({ state: "unauthorized", connected_at: null, error: `the server refused the feed token (HTTP ${status})` });
  }

  /** Drops the connection and every timer; whatever the old attempt still finishes is ignored. */
  private halt(): void {
    this.attempt++;
    this.controller?.abort();
    this.controller = null;
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private scrub(text: string): string {
    return this.token === null ? text : text.split(this.token).join("[redacted]");
  }

  /** Changes the status; tells `onState` last, so a handler that stops or restarts the feed sees it settled. */
  private update(patch: Partial<FeedStatus>): void {
    const next: FeedStatus = { ...this.current, ...patch };
    if (next.error !== null) next.error = this.scrub(next.error);
    const changed = next.state !== this.current.state || next.error !== this.current.error || next.server !== this.current.server;
    this.current = next;
    if (!changed || this.onState === undefined) return;
    try {
      this.onState(this.status());
    } catch (err) {
      console.error(`tws-bridge: the alert feed's status handler failed: ${this.scrub(describe(err))}`);
    }
  }
}
