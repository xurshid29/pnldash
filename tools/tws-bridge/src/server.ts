import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AutoTrader } from "./auto.js";
import type { Bridge } from "./bridge.js";
import { badRequest, BridgeError, errorMessage } from "./errors.js";
import type { Journal, JournalFields } from "./journal.js";
import { systemClock } from "./time.js";
import type { Clock } from "./time.js";

export const MAX_BODY_BYTES = 4096;
/** A body that is refused is still read and thrown away up to this size, then the socket is cut. */
const MAX_DISCARD_BYTES = 1024 * 1024;
/** At most this many refused (401 / 403) requests are logged per minute; the rest are counted. */
const MAX_REFUSALS_LOGGED_PER_MINUTE = 30;
/**
 * The two calls the dashboard repeats (`/status` every 5 s, `/orders` every 2 s after a click).
 * Answered fine, they are not written to the log: they would be some 17,000 lines a day per open
 * tab, in the file the day's orders are read back from at a start. A failed one is logged.
 */
const POLL_PATHS: ReadonlySet<string> = new Set(["/status", "/orders", "/auto"]);

const PREFLIGHT_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Bridge-Token",
  "Access-Control-Allow-Private-Network": "true",
  "Access-Control-Max-Age": "600",
};

export interface ServerOptions {
  bridge: Bridge;
  /** The automation (`src/auto.ts`). Without it there is no `/auto`: the bridge only answers clicks. */
  auto?: AutoTrader;
  token: string;
  allowedOrigins: string[];
  journal: Journal;
  clock?: Clock;
}

type Method = "GET" | "POST";
/** What a path does, per method it takes. */
type Route = Partial<Record<Method, (body: unknown) => unknown>>;

function tokenMatches(given: string | string[] | undefined, expected: string): boolean {
  if (typeof given !== "string") return false;
  // Hashing first makes both sides the same length, which timingSafeEqual needs.
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** The request must be addressed to this machine by a loopback name: a guard against DNS rebinding. */
function hostIsLoopback(req: IncomingMessage): boolean {
  const host = req.headers.host;
  const port = req.socket.localPort;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

function discard(req: IncomingMessage, alreadyRead: number): void {
  let size = alreadyRead;
  req.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_DISCARD_BYTES) req.destroy();
  });
  req.resume();
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const contentType = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    discard(req, 0);
    return Promise.reject(new BridgeError(415, "not_json", "the body must be sent as Content-Type: application/json"));
  }
  const tooLarge = (): BridgeError =>
    new BridgeError(413, "body_too_large", `the body is larger than ${MAX_BODY_BYTES} bytes`);
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    discard(req, 0);
    return Promise.reject(tooLarge());
  }

  return new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (settled) {
        if (size > MAX_DISCARD_BYTES) req.destroy();
        return;
      }
      if (size > MAX_BODY_BYTES) {
        settled = true;
        reject(tooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(badRequest("the body is not valid JSON"));
      }
    });
    req.on("error", () => {
      if (settled) return;
      settled = true;
      reject(badRequest("the request body could not be read"));
    });
  });
}

/** The few body fields worth a place in the request log. Never headers: the token is one. */
function logFields(body: unknown): JournalFields {
  const out: JournalFields = {};
  if (typeof body !== "object" || body === null || Array.isArray(body)) return out;
  const source = body as Record<string, unknown>;
  for (const key of ["ticker", "stage", "alert_id", "alert_at", "entry"]) {
    const value = source[key];
    if (typeof value === "string") out[key] = value.slice(0, 80);
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  for (const key of ["alert_price", "alert_stop", "qty", "order_id"]) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  if (typeof source["halted"] === "boolean") out["halted"] = source["halted"];
  // `/auto`'s switch and `/auto/feed`'s server. The feed's token is a body field too, and is never taken.
  for (const key of ["mode", "server"]) {
    const value = source[key];
    if (typeof value === "string") out[key] = value.slice(0, 80);
  }
  return out;
}

/**
 * The HTTP side: who may call (loopback Host, allowed Origin, the token), in what form (JSON, 4 KB),
 * and which bridge function a path means. It decides nothing about orders.
 */
export function createBridgeServer(options: ServerOptions): http.Server {
  const { bridge, auto, token, journal } = options;
  const allowedOrigins = new Set(options.allowedOrigins);
  const clock = options.clock ?? systemClock;

  const routes: Record<string, Route> = {
    "/status": { GET: () => bridge.status() },
    "/orders": { GET: () => bridge.orders() },
    "/focus": { POST: (body) => bridge.focus(body) },
    "/preview": { POST: (body) => bridge.preview(body) },
    "/order": { POST: (body) => bridge.order(body) },
    "/cancel": { POST: (body) => bridge.cancel(body) },
    "/chase": { POST: (body) => bridge.chase(body) },
    "/sell": { POST: (body) => bridge.sell(body) },
    "/halt": { POST: (body) => bridge.halt(body) },
  };
  if (auto !== undefined) {
    // The automation: its state and the day's decisions, its switch, and where its alerts come from.
    routes["/auto"] = { GET: () => auto.status(), POST: (body) => auto.setMode(body) };
    routes["/auto/feed"] = { POST: (body) => auto.pairFeed(body) };
  }

  let refusalMinute = -1;
  let refusalsThisMinute = 0;
  const logRequest = (status: number, entry: JournalFields): void => {
    if (status === 401 || status === 403) {
      const minute = Math.floor(clock() / 60000);
      if (minute !== refusalMinute) {
        if (refusalsThisMinute > MAX_REFUSALS_LOGGED_PER_MINUTE) {
          journal.write("requests_refused", { not_logged: refusalsThisMinute - MAX_REFUSALS_LOGGED_PER_MINUTE });
        }
        refusalMinute = minute;
        refusalsThisMinute = 0;
      }
      refusalsThisMinute += 1;
      if (refusalsThisMinute > MAX_REFUSALS_LOGGED_PER_MINUTE) return;
    }
    journal.write("request", entry);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const started = clock();
    const method = req.method ?? "GET";
    let path = "/";
    try {
      path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      path = "(unreadable)";
    }
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    let corsOrigin: string | null = null;
    let body: unknown;

    const send = (status: number, payload: unknown, extra: Record<string, string> = {}): void => {
      const headers: Record<string, string> = {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        Vary: "Origin",
        ...extra,
      };
      if (corsOrigin !== null) headers["Access-Control-Allow-Origin"] = corsOrigin;
      let text = "";
      if (payload !== undefined) {
        text = JSON.stringify(payload);
        headers["Content-Type"] = "application/json; charset=utf-8";
        headers["Content-Length"] = String(Buffer.byteLength(text));
      }
      res.writeHead(status, headers);
      res.end(text);

      if (status === 200 && method === "GET" && POLL_PATHS.has(path)) return;
      const entry: JournalFields = { method, path: path.slice(0, 64), status, ms: clock() - started };
      if (origin !== undefined) entry["origin"] = origin.slice(0, 120);
      Object.assign(entry, logFields(body));
      if (typeof payload === "object" && payload !== null && "error" in payload) {
        const failure = payload as { error?: unknown; code?: unknown };
        entry["error"] = failure.error;
        entry["code"] = failure.code;
      }
      logRequest(status, entry);
    };

    try {
      if (!hostIsLoopback(req)) {
        throw new BridgeError(403, "bad_host", "the bridge answers only to 127.0.0.1 or localhost");
      }
      if (origin !== undefined) {
        if (!allowedOrigins.has(origin)) {
          throw new BridgeError(403, "origin_not_allowed", "this origin is not in allowedOrigins");
        }
        corsOrigin = origin;
      }
      if (method === "OPTIONS") {
        send(204, undefined, PREFLIGHT_HEADERS);
        return;
      }
      if (!tokenMatches(req.headers["x-bridge-token"], token)) {
        throw new BridgeError(401, "bad_token", "the X-Bridge-Token header is missing or wrong");
      }

      const route = routes[path];
      if (route === undefined) throw new BridgeError(404, "not_found", `there is no ${path.slice(0, 64)}`);
      const run = method === "GET" || method === "POST" ? route[method] : undefined;
      if (run === undefined) {
        const takes = Object.keys(route);
        send(405, { error: `${path} takes ${takes.join(" or ")}`, code: "method_not_allowed" }, { Allow: `${takes.join(", ")}, OPTIONS` });
        return;
      }
      if (method === "POST") body = await readJsonBody(req);
      const data = await run(body);
      send(200, { data });
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof BridgeError) {
        const extra: Record<string, string> = err.status === 413 || err.status === 415 ? { Connection: "close" } : {};
        send(err.status, { error: err.message, code: err.code }, extra);
        return;
      }
      console.error("tws-bridge: unexpected error", err);
      journal.write("internal_error", { method, path: path.slice(0, 64), message: errorMessage(err) });
      send(500, { error: "internal error in the bridge (see its console)", code: "internal" });
    }
  };

  const server = http.createServer((req, res) => {
    void handle(req, res);
  });
  // Small headers, short waits: the only clients are a browser tab and curl on this machine.
  server.maxHeadersCount = 64;
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  return server;
}

/** Listens on the loopback address only. The bridge is never reachable from another machine. */
export function listenOnLoopback(server: http.Server, port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : port);
    });
  });
}
