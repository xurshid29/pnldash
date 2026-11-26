import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { Bridge } from "../src/bridge.js";
import { MemoryJournal } from "../src/journal.js";
import { createBridgeServer, listenOnLoopback, MAX_BODY_BYTES } from "../src/server.js";
import { until } from "./fake-tws.js";
import { rig, TOKEN } from "./harness.js";
import type { Rig, RigOptions } from "./harness.js";

const DASHBOARD = "https://pnldash.uz";
const DEV = "http://localhost:5173";

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

interface CallOptions {
  method?: string;
  path?: string;
  /** The token to send; null sends none. Default: the right one. */
  token?: string | null;
  origin?: string;
  headers?: Record<string, string>;
  /** Sent as JSON with the right Content-Type. */
  json?: unknown;
  /** Sent as it is; the test sets the headers. */
  raw?: string | Buffer;
  /** Sent chunk by chunk with no Content-Length. */
  chunks?: Buffer[];
}

function call(port: number, options: CallOptions = {}): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (options.token !== null) headers["X-Bridge-Token"] = options.token ?? TOKEN;
  if (options.origin !== undefined) headers["Origin"] = options.origin;
  let payload: Buffer | null = null;
  if (options.json !== undefined) {
    payload = Buffer.from(JSON.stringify(options.json));
    headers["Content-Type"] = "application/json";
  } else if (options.raw !== undefined) {
    payload = Buffer.from(options.raw);
  }
  if (payload !== null) headers["Content-Length"] = String(payload.length);
  Object.assign(headers, options.headers);
  const method = options.method ?? (payload !== null || options.chunks !== undefined ? "POST" : "GET");

  return new Promise<Reply>((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: options.path ?? "/status", headers, agent: false },
      (res) => {
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
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, body });
        });
      },
    );
    req.on("error", reject);
    if (options.chunks !== undefined) for (const chunk of options.chunks) req.write(chunk);
    req.end(payload ?? undefined);
  });
}

interface Served extends Rig {
  port: number;
}

async function serve(t: TestContext, options: RigOptions = {}): Promise<Served> {
  const r = await rig(t, options);
  const server = createBridgeServer({
    bridge: r.bridge,
    token: TOKEN,
    allowedOrigins: r.config.allowedOrigins,
    journal: r.journal,
    clock: () => r.clock.now,
  });
  const port = await listenOnLoopback(server, 0);
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { ...r, port };
}

// ------------------------------------------------------------------ token

test("auth: every request needs the X-Bridge-Token header", async (t) => {
  const s = await serve(t);
  const none = await call(s.port, { token: null });
  assert.equal(none.status, 401);
  assert.deepEqual(none.body, { error: "the X-Bridge-Token header is missing or wrong", code: "bad_token" });

  for (const token of ["", "wrong", TOKEN.slice(0, -1), `${TOKEN}0`, TOKEN.toUpperCase(), `Bearer ${TOKEN}`]) {
    assert.equal((await call(s.port, { token })).status, 401, JSON.stringify(token));
  }
  // The token in the URL or in another header does not count.
  assert.equal((await call(s.port, { token: null, path: `/status?token=${TOKEN}` })).status, 401);
  assert.equal((await call(s.port, { token: null, headers: { Authorization: `Bearer ${TOKEN}` } })).status, 401);
  // Without the token nothing is done, on any path.
  for (const path of ["/orders", "/nothing"]) assert.equal((await call(s.port, { token: null, path })).status, 401);
  for (const path of ["/focus", "/preview", "/order", "/cancel", "/halt"]) {
    assert.equal((await call(s.port, { token: null, path, json: { ticker: "ABCD", alert_price: 2.5, halted: true } })).status, 401);
  }
  assert.deepEqual(s.world.allPlaced(), []);
  assert.equal(s.bridge.status().halted, false);

  const ok = await call(s.port);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.version, "0.0.0-test");
  assert.equal(ok.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(ok.headers["cache-control"], "no-store");
});

// ----------------------------------------------------------------- origin

test("origin: a request with an Origin must come from an allowed one", async (t) => {
  const s = await serve(t);
  for (const origin of ["https://evil.example", "https://pnldash.uz.evil.example", "http://pnldash.uz", "https://pnldash.uz:8443", "null"]) {
    const refused = await call(s.port, { origin });
    assert.equal(refused.status, 403, origin);
    assert.deepEqual(refused.body, { error: "this origin is not in allowedOrigins", code: "origin_not_allowed" });
    // No CORS answer: the page that asked cannot even read the refusal.
    assert.equal(refused.headers["access-control-allow-origin"], undefined);
  }
  // A good token does not make up for a wrong origin.
  const posted = await call(s.port, { origin: "https://evil.example", path: "/order", json: { ticker: "ABCD", alert_price: 2.5 } });
  assert.equal(posted.status, 403);
  assert.deepEqual(s.world.allPlaced(), []);

  for (const origin of [DASHBOARD, DEV]) {
    const ok = await call(s.port, { origin });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers["access-control-allow-origin"], origin);
    assert.equal(ok.headers["vary"], "Origin");
  }

  // No Origin at all (curl, a script on this Mac): the token decides; no CORS header is sent.
  const local = await call(s.port);
  assert.equal(local.status, 200);
  assert.equal(local.headers["access-control-allow-origin"], undefined);
  assert.equal(local.headers["vary"], "Origin");
});

test("origin: errors to an allowed origin carry the CORS header, so the page can show them", async (t) => {
  const s = await serve(t);
  const unauthorized = await call(s.port, { origin: DASHBOARD, token: "wrong" });
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers["access-control-allow-origin"], DASHBOARD);

  const bad = await call(s.port, { origin: DASHBOARD, path: "/order", json: { ticker: "ABCD" } });
  assert.equal(bad.status, 400);
  assert.equal(bad.headers["access-control-allow-origin"], DASHBOARD);
});

test("preflight: OPTIONS needs no token and answers 204 with the CORS and private-network headers", async (t) => {
  const s = await serve(t);
  for (const path of ["/order", "/status", "/halt"]) {
    const reply = await call(s.port, {
      method: "OPTIONS",
      path,
      token: null,
      origin: DASHBOARD,
      headers: {
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-bridge-token",
        "Access-Control-Request-Private-Network": "true",
      },
    });
    assert.equal(reply.status, 204);
    assert.equal(reply.text, "");
    assert.equal(reply.headers["access-control-allow-origin"], DASHBOARD);
    assert.equal(reply.headers["access-control-allow-methods"], "GET, POST, OPTIONS");
    assert.equal(reply.headers["access-control-allow-headers"], "Content-Type, X-Bridge-Token");
    assert.equal(reply.headers["access-control-allow-private-network"], "true");
    assert.equal(reply.headers["access-control-max-age"], "600");
    assert.equal(reply.headers["vary"], "Origin");
  }

  const refused = await call(s.port, { method: "OPTIONS", path: "/order", token: null, origin: "https://evil.example" });
  assert.equal(refused.status, 403);
  assert.equal(refused.headers["access-control-allow-origin"], undefined);
  assert.equal(refused.headers["access-control-allow-methods"], undefined);
  assert.equal(refused.headers["access-control-allow-private-network"], undefined);

  // A preflight does nothing but answer.
  assert.deepEqual(s.world.allPlaced(), []);
});

test("host: only a loopback Host is answered (DNS rebinding)", async (t) => {
  const s = await serve(t);
  for (const host of ["evil.example", `evil.example:${s.port}`, "127.0.0.1:1", "pnldash.uz"]) {
    const refused = await call(s.port, { headers: { Host: host } });
    assert.equal(refused.status, 403, host);
    assert.equal(refused.body.code, "bad_host");
  }
  assert.equal((await call(s.port, { headers: { Host: `localhost:${s.port}` } })).status, 200);
  assert.equal((await call(s.port, { headers: { Host: `127.0.0.1:${s.port}` } })).status, 200);
});

// ------------------------------------------------------------------ bodies

test("body: POST must be application/json", async (t) => {
  const s = await serve(t);
  const body = JSON.stringify({ ticker: "ABCD" });
  const noType = await call(s.port, { path: "/focus", raw: body });
  assert.equal(noType.status, 415);
  assert.equal(noType.body.code, "not_json");
  for (const type of ["text/plain", "application/x-www-form-urlencoded", "application/jsonp", "text/json"]) {
    assert.equal((await call(s.port, { path: "/focus", raw: body, headers: { "Content-Type": type } })).status, 415, type);
  }
  for (const type of ["application/json", "application/json; charset=utf-8", "Application/JSON"]) {
    assert.equal((await call(s.port, { path: "/focus", raw: body, headers: { "Content-Type": type } })).status, 200, type);
  }
  assert.equal(s.world.current.callsOf("updateDisplayGroup").length, 3);
});

test("body: at most 4 KB, whether the size is declared or not", async (t) => {
  const s = await serve(t);
  const json = { "Content-Type": "application/json" };
  const padded = (size: number): string => {
    const start = '{"ticker":"ABCD"';
    return `${start}${" ".repeat(size - start.length - 1)}}`;
  };
  assert.equal(MAX_BODY_BYTES, 4096);

  const exact = await call(s.port, { path: "/focus", raw: padded(4096), headers: json });
  assert.equal(exact.status, 200);

  const declared = await call(s.port, { path: "/focus", raw: padded(4097), headers: json });
  assert.equal(declared.status, 413);
  assert.deepEqual(declared.body, { error: "the body is larger than 4096 bytes", code: "body_too_large" });

  const big = Buffer.from(padded(6000));
  const streamed = await call(s.port, { path: "/focus", chunks: [big.subarray(0, 3000), big.subarray(3000)], headers: json });
  assert.equal(streamed.status, 413);

  const order = await call(s.port, { path: "/order", raw: JSON.stringify({ ticker: "ABCD", alert_price: 2.5, stage: "x".repeat(5000) }), headers: json });
  assert.equal(order.status, 413);
  assert.deepEqual(s.world.allPlaced(), []);
  assert.equal(s.world.current.callsOf("updateDisplayGroup").length, 1);
});

test("body: must be a JSON object", async (t) => {
  const s = await serve(t);
  const json = { "Content-Type": "application/json" };
  for (const raw of ["{ not json", "", "ticker=ABCD"]) {
    const reply = await call(s.port, { path: "/focus", raw, headers: json });
    assert.equal(reply.status, 400, raw);
    assert.equal(reply.body.error, "the body is not valid JSON");
  }
  for (const raw of ['["ABCD"]', '"ABCD"', "5", "null"]) {
    const reply = await call(s.port, { path: "/focus", raw, headers: json });
    assert.equal(reply.status, 400, raw);
    assert.equal(reply.body.error, "the body must be a JSON object");
  }
});

// ----------------------------------------------------------------- routes

test("routes: unknown paths are 404, the wrong method is 405", async (t) => {
  const s = await serve(t);
  for (const path of ["/", "/config", "/paperOnly", "/orders/1000", "/status/", "/shutdown"]) {
    const reply = await call(s.port, { path });
    assert.equal(reply.status, 404, path);
    assert.equal(reply.body.code, "not_found");
  }
  const get = await call(s.port, { path: "/order" });
  assert.equal(get.status, 405);
  assert.equal(get.headers["allow"], "POST, OPTIONS");
  const post = await call(s.port, { path: "/status", json: {} });
  assert.equal(post.status, 405);
  assert.equal(post.headers["allow"], "GET, OPTIONS");
  for (const method of ["PUT", "DELETE", "PATCH"]) {
    assert.equal((await call(s.port, { path: "/halt", method, json: { halted: true } })).status, 405, method);
  }
  assert.equal(s.bridge.status().halted, false);
  // A query string does not change the route.
  assert.equal((await call(s.port, { path: "/status?t=1" })).status, 200);
});

test("there is no HTTP way to turn paperOnly off", async (t) => {
  const s = await serve(t, { world: (w) => (w.accounts = "U7654321") });
  assert.equal((await call(s.port, { path: "/halt", json: { halted: false, paperOnly: false } })).status, 400);
  assert.equal((await call(s.port, { path: "/order", json: { ticker: "ABCD", alert_price: 2.5, paperOnly: false } })).status, 400);
  assert.equal((await call(s.port, { path: "/config", json: { paperOnly: false } })).status, 404);
  assert.equal((await call(s.port, { path: "/status", json: { paper_only: false } })).status, 405);

  const refused = await call(s.port, { path: "/order", json: { ticker: "ABCD", alert_price: 2.5 } });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "paper_only");
  assert.match(refused.body.error, /set "paperOnly": false in config\.json by hand/);
  assert.equal((await call(s.port)).body.data.paper_only, true);
  assert.deepEqual(s.world.allPlaced(), []);
});

// --------------------------------------------------------------- the flow

test("flow: status, focus, preview, order, orders, cancel, halt over HTTP", async (t) => {
  const s = await serve(t);
  const from = { origin: DASHBOARD };

  const status = await call(s.port, from);
  assert.equal(status.status, 200);
  assert.deepEqual(Object.keys(status.body), ["data"]);
  assert.deepEqual(Object.keys(status.body.data), [
    "version",
    "tws",
    "enabled",
    "halted",
    "paper_only",
    "display_group",
    "order",
    "limits",
    "today",
  ]);
  assert.deepEqual(status.body.data.tws, { connected: true, port: 7497, paper: true, accounts: ["DU…67"] });

  const focus = await call(s.port, { ...from, path: "/focus", json: { ticker: "abcd" } });
  assert.deepEqual(focus.body, { data: { ticker: "ABCD", conid: 111, group: 1 } });

  const request = { ticker: "ABCD", alert_price: 2.5, alert_stop: 2.42, stage: "band", alert_id: "ev-1" };
  const preview = await call(s.port, { ...from, path: "/preview", json: request });
  assert.equal(preview.status, 200);
  assert.deepEqual(
    { ...preview.body.data, checks: preview.body.data.checks.length },
    { ticker: "ABCD", qty: 100, limit: 2.53, take_profit: 2.78, stop: 2.42, stop_limit: 2.39, notional: 253, checks: 10 },
  );
  assert.deepEqual(Object.keys(preview.body.data.checks[0]), ["name", "detail"]);
  assert.deepEqual(s.world.allPlaced(), []);

  const order = await call(s.port, { ...from, path: "/order", json: request });
  assert.deepEqual(order.body, {
    data: { order_id: 1000, ticker: "ABCD", qty: 100, limit: 2.53, take_profit: 2.78, stop: 2.42, stop_limit: 2.39, status: "PendingSubmit" },
  });
  assert.equal(s.world.allPlaced().length, 3);

  const again = await call(s.port, { ...from, path: "/order", json: request });
  assert.equal(again.status, 409);
  assert.deepEqual(Object.keys(again.body), ["error", "code"]);
  assert.equal(again.body.code, "duplicate");

  s.world.current.emit("orderStatus", 1000, "Submitted", 0, 100, 0);
  const orders = await call(s.port, { ...from, path: "/orders" });
  assert.equal(orders.body.data.length, 1);
  assert.equal(orders.body.data[0].order_id, 1000);
  assert.equal(orders.body.data[0].status, "Submitted");
  assert.deepEqual(orders.body.data[0].asked, { alert_price: 2.5, alert_stop: 2.42, qty: null, stage: "band", alert_at: null, alert_id: "ev-1" });
  assert.equal(orders.body.data[0].sent.limit, 2.53);
  assert.deepEqual([orders.body.data[0].filled_qty, orders.body.data[0].avg_fill_price, orders.body.data[0].slip_pct], [0, null, null]);

  const cancel = await call(s.port, { ...from, path: "/cancel", json: { order_id: 1000 } });
  assert.deepEqual(cancel.body, { data: { order_id: 1000, status: "PendingCancel" } });
  assert.deepEqual(s.world.current.callsOf("cancelOrder").map((c) => c.args), [[1000]]);
  assert.equal((await call(s.port, { ...from, path: "/cancel", json: { order_id: 55 } })).status, 404);

  const halt = await call(s.port, { ...from, path: "/halt", json: { halted: true } });
  assert.deepEqual(halt.body, { data: { halted: true } });
  assert.deepEqual(s.saved, [true]);
  const halted = await call(s.port, { ...from, path: "/order", json: { ticker: "WXYZ", alert_price: 2.5 } });
  assert.equal(halted.status, 409);
  assert.equal(halted.body.code, "halted");
  assert.equal((await call(s.port, from)).body.data.halted, true);
  assert.deepEqual((await call(s.port, from)).body.data.today, { orders: 1, filled: 0 });
  assert.equal(s.world.allPlaced().length, 3);
});

test("flow: with TWS down, /status still answers and the rest is 503", async (t) => {
  const s = await serve(t, { world: (w) => (w.mode = "refuse"), connect: false });
  await until(() => s.world.instances.length >= 1, "a connection attempt");
  const status = await call(s.port);
  assert.equal(status.status, 200);
  assert.deepEqual(status.body.data.tws, { connected: false, port: 7497, paper: false, accounts: [] });
  for (const [path, json] of [
    ["/focus", { ticker: "ABCD" }],
    ["/preview", { ticker: "ABCD", alert_price: 2.5 }],
    ["/order", { ticker: "ABCD", alert_price: 2.5 }],
  ] as const) {
    const reply = await call(s.port, { path, json });
    assert.equal(reply.status, 503, path);
    assert.equal(reply.body.code, "tws_down");
  }
  assert.deepEqual((await call(s.port, { path: "/orders" })).body, { data: [] });
});

// ---------------------------------------------------------------- the log

test("log: every request is logged with what it was about, and never the token", async (t) => {
  const s = await serve(t);
  await call(s.port, { origin: DASHBOARD });
  await call(s.port, { token: "a-wrong-token-value" });
  await call(s.port, { origin: "https://evil.example" });
  await call(s.port, { method: "OPTIONS", path: "/order", token: null, origin: DASHBOARD });
  await call(s.port, { path: "/order", json: { ticker: "ABCD", alert_price: 2.5, alert_stop: 2.42, stage: "band", alert_id: 7 } });
  await call(s.port, { path: "/order", json: { ticker: "ABCD", alert_price: 2.5 } });
  await call(s.port, { path: "/cancel", json: { order_id: 1000 } });

  const lines = s.journal.ofType("request");
  assert.deepEqual(
    lines.map((line) => [line["method"], line["path"], line["status"]]),
    [
      ["GET", "/status", 200],
      ["GET", "/status", 401],
      ["GET", "/status", 403],
      ["OPTIONS", "/order", 204],
      ["POST", "/order", 200],
      ["POST", "/order", 409],
      ["POST", "/cancel", 200],
    ],
  );
  for (const line of lines) assert.equal(typeof line["ms"], "number");
  assert.equal(lines[0]?.["origin"], DASHBOARD);
  assert.equal(lines[2]?.["origin"], "https://evil.example");
  assert.deepEqual(
    [lines[4]?.["ticker"], lines[4]?.["alert_price"], lines[4]?.["alert_stop"], lines[4]?.["stage"], lines[4]?.["alert_id"]],
    ["ABCD", 2.5, 2.42, "band", 7],
  );
  assert.equal(lines[5]?.["code"], "duplicate");
  assert.match(String(lines[5]?.["error"]), /^duplicate: ABCD/);
  assert.equal(lines[6]?.["order_id"], 1000);

  const everything = JSON.stringify(s.journal.events);
  assert.equal(everything.includes(TOKEN), false);
  assert.equal(everything.includes("a-wrong-token-value"), false);
});

test("log: a flood of refused requests is counted, not written line by line", async (t) => {
  const s = await serve(t);
  for (let i = 0; i < 40; i += 1) await call(s.port, { token: null });
  assert.equal(s.journal.ofType("request").length, 30);
  await call(s.port); // a good request is always logged
  assert.equal(s.journal.ofType("request").length, 31);

  s.clock.now += 60_000;
  await call(s.port, { token: null });
  assert.deepEqual(s.journal.ofType("requests_refused"), [{ type: "requests_refused", not_logged: 10 }]);
  assert.equal(s.journal.ofType("request").length, 32);
});

test("an unexpected failure inside is a plain 500, with no detail sent out", async (t) => {
  const errors = t.mock.method(console, "error", () => undefined);
  const journal = new MemoryJournal();
  const bridge = {
    status(): never {
      throw new Error("something private");
    },
  } as unknown as Bridge;
  const server = createBridgeServer({ bridge, token: TOKEN, allowedOrigins: [DASHBOARD], journal });
  const port = await listenOnLoopback(server, 0);
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const reply = await call(port);
  assert.equal(reply.status, 500);
  assert.deepEqual(reply.body, { error: "internal error in the bridge (see its console)", code: "internal" });
  assert.equal(reply.text.includes("private"), false);
  assert.equal(errors.mock.callCount(), 1);
  assert.equal(journal.ofType("internal_error")[0]?.["message"], "something private");
});

test("the server listens on the loopback address only", async (t) => {
  const journal = new MemoryJournal();
  const bridge = { status: () => ({}) } as unknown as Bridge;
  const server = createBridgeServer({ bridge, token: TOKEN, allowedOrigins: [], journal });
  await listenOnLoopback(server, 0);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(typeof address === "object" && address !== null);
  assert.equal(address.address, "127.0.0.1");
  assert.equal(address.family, "IPv4");
});
