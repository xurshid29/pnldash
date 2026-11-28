import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { createBridgeServer, listenOnLoopback } from "../src/server.js";
import { TOKEN } from "./harness.js";
import { autoRig, FEED, RecordingJournal } from "./scenes.js";
import type { AutoRig, AutoRigOptions } from "./scenes.js";

// The automation over HTTP (src/server.ts): GET /auto (its status), POST /auto (the switch) and
// POST /auto/feed (where its alerts come from). The server writes its request lines to a journal
// of its own here that keeps every line as given, so a token in one would show.

const DASHBOARD = "https://pnldash.uz";

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

function call(port: number, options: { method?: string; path: string; json?: unknown; token?: string | null; origin?: string; contentType?: string }): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (options.token !== null) headers["X-Bridge-Token"] = options.token ?? TOKEN;
  if (options.origin !== undefined) headers["Origin"] = options.origin;
  const payload = options.json === undefined ? null : Buffer.from(JSON.stringify(options.json));
  if (payload !== null) {
    headers["Content-Type"] = options.contentType ?? "application/json";
    headers["Content-Length"] = String(payload.length);
  }
  const method = options.method ?? (payload === null ? "GET" : "POST");
  return new Promise<Reply>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: options.path, headers, agent: false }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (chunk: Buffer) => parts.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(parts).toString("utf8");
        let body: unknown = null;
        try {
          body = text === "" ? null : JSON.parse(text);
        } catch {
          body = null;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
      });
    });
    req.on("error", reject);
    req.end(payload ?? undefined);
  });
}

interface Served extends AutoRig {
  port: number;
  requests: RecordingJournal;
}

async function serve(t: TestContext, options: AutoRigOptions & { withAuto?: boolean } = {}): Promise<Served> {
  const a = await autoRig(t, { journal: new RecordingJournal(), ...options });
  const requests = new RecordingJournal();
  const server = createBridgeServer({
    bridge: a.bridge,
    ...(options.withAuto === false ? {} : { auto: a.auto }),
    token: TOKEN,
    allowedOrigins: a.config.allowedOrigins,
    journal: requests,
    clock: () => a.clock.now,
  });
  const port = await listenOnLoopback(server, 0);
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { ...a, port, requests };
}

test("auto http: GET /auto answers the automation's status, and a poll that is answered is not logged", async (t) => {
  const s = await serve(t, { mode: "watch" });
  const reply = await call(s.port, { path: "/auto", origin: DASHBOARD });
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body, { data: JSON.parse(JSON.stringify(s.auto.status())) });
  assert.equal(reply.body.data.mode, "watch");
  assert.equal(reply.headers["access-control-allow-origin"], DASHBOARD);
  assert.deepEqual(s.requests.ofType("request"), []);
  // A refused one is logged.
  assert.equal((await call(s.port, { path: "/auto", token: "wrong" })).status, 401);
  assert.deepEqual(s.requests.ofType("request").map((line) => [line["path"], line["status"]]), [["/auto", 401]]);
});

test("auto http: POST /auto switches the mode and is logged with it; a wrong body is a 400 and switches nothing", async (t) => {
  const s = await serve(t, { mode: "off" });
  const reply = await call(s.port, { path: "/auto", json: { mode: "watch" }, origin: DASHBOARD });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.data.mode, "watch");
  assert.equal(s.auto.mode, "watch");
  assert.deepEqual(s.savedStates.at(-1)?.auto.mode, "watch");
  const [line] = s.requests.ofType("request");
  assert.deepEqual([line?.["method"], line?.["path"], line?.["status"], line?.["mode"], line?.["origin"]], ["POST", "/auto", 200, "watch", DASHBOARD]);

  for (const json of [{ mode: "auto" }, { mode: "on", extra: true }, {}, ["on"], "on"]) {
    const bad = await call(s.port, { path: "/auto", json });
    assert.equal(bad.status, 400, JSON.stringify(json));
    assert.equal(bad.body.code, "bad_request");
  }
  assert.equal((await call(s.port, { path: "/auto", json: { mode: "on" }, contentType: "text/plain" })).status, 415);
  assert.equal(s.auto.mode, "watch");
  assert.deepEqual(s.requests.ofType("request").map((entry) => entry["status"]), [200, 400, 400, 400, 400, 400, 415]);
});

test("auto http: POST /auto whose save fails is a 500 not_saved, and the mode has changed", async (t) => {
  const s = await serve(t, {
    mode: "off",
    saveState: () => {
      throw new Error("read-only file system");
    },
  });
  const reply = await call(s.port, { path: "/auto", json: { mode: "on" } });
  assert.equal(reply.status, 500);
  assert.equal(reply.body.code, "not_saved");
  assert.match(reply.body.error, /read-only file system/);
  assert.equal((await call(s.port, { path: "/auto" })).body.data.mode, "on");
});

test("auto http: POST /auto/feed pairs the bridge, and its token is in no line of the request log or of the bridge's", async (t) => {
  const s = await serve(t, { mode: "watch", paired: false });
  const token = "http-feed-token-5b8e2d71c0aa";
  const reply = await call(s.port, { path: "/auto/feed", json: { server: FEED.server, token }, origin: DASHBOARD });
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body, { data: { paired: true, server: FEED.server } });
  assert.deepEqual(s.state.feed, { server: FEED.server, token });
  const [line] = s.requests.ofType("request");
  assert.deepEqual([line?.["path"], line?.["status"], line?.["server"]], ["/auto/feed", 200, FEED.server]);

  // Refused ones are logged too, and never with the token.
  const refused = await call(s.port, { path: "/auto/feed", json: { server: "https://evil.example", token } });
  assert.equal(refused.status, 400);
  assert.ok(!JSON.stringify(refused.body).includes(token));
  assert.equal((await call(s.port, { path: "/auto/feed", json: { server: FEED.server, token: "two words" } })).status, 400);
  const bridgeLog = s.log as RecordingJournal;
  for (const entry of [...s.requests.lines, ...bridgeLog.lines]) assert.ok(!JSON.stringify(entry).includes(token), JSON.stringify(entry));
  assert.equal(s.requests.ofType("request").length, 3);
  // The bridge's log was told it is a secret before the line about the pairing.
  assert.deepEqual(bridgeLog.steps.filter((step) => step === "addSecret" || step === "write auto_feed"), ["addSecret", "write auto_feed"]);
});

test("auto http: another method on /auto or /auto/feed is a 405 that says which it takes", async (t) => {
  const s = await serve(t);
  for (const [method, path, allow] of [
    ["PUT", "/auto", "GET, POST, OPTIONS"],
    ["DELETE", "/auto", "GET, POST, OPTIONS"],
    ["PATCH", "/auto", "GET, POST, OPTIONS"],
    ["GET", "/auto/feed", "POST, OPTIONS"],
    ["PUT", "/auto/feed", "POST, OPTIONS"],
  ] as const) {
    const reply = await call(s.port, { method, path });
    assert.equal(reply.status, 405, `${method} ${path}`);
    assert.equal(reply.headers["allow"], allow, `${method} ${path}`);
    assert.equal(reply.body.code, "method_not_allowed");
  }
  // The browser's preflight is answered for them.
  const preflight = await call(s.port, { method: "OPTIONS", path: "/auto", origin: DASHBOARD, token: null });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers["access-control-allow-methods"], "GET, POST, OPTIONS");
});

test("auto http: a server built without the automation has no /auto", async (t) => {
  const s = await serve(t, { withAuto: false });
  for (const [method, path, json] of [
    ["GET", "/auto", undefined],
    ["POST", "/auto", { mode: "on" }],
    ["POST", "/auto/feed", { server: FEED.server, token: FEED.token }],
  ] as const) {
    const reply = await call(s.port, { method, path, json });
    assert.equal(reply.status, 404, `${method} ${path}`);
    assert.equal(reply.body.code, "not_found");
  }
  assert.equal(s.auto.mode, "on"); // the automation behind it was never reached
  assert.equal((await call(s.port, { path: "/status" })).status, 200);
});
