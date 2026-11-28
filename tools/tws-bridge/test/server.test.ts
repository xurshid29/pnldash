import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { Bridge } from "../src/bridge.js";
import { FileJournal, MemoryJournal } from "../src/journal.js";
import { createBridgeServer, listenOnLoopback, MAX_BODY_BYTES } from "../src/server.js";
import { until } from "./fake-tws.js";
import { rig, T0, TOKEN } from "./harness.js";
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
    // The bridge and the HTTP side write one log, as in main.ts.
    journal: options.journal ?? r.journal,
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
  for (const path of ["/focus", "/preview", "/order", "/cancel", "/halt", "/chase", "/sell"]) {
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
    "display_groups",
    "order",
    "limits",
    "today",
  ]);
  assert.deepEqual(status.body.data.tws, { connected: true, port: 7497, paper: true, accounts: ["DU…67"], offline: false });

  const focus = await call(s.port, { ...from, path: "/focus", json: { ticker: "abcd" } });
  assert.deepEqual(focus.body, { data: { ticker: "ABCD", conid: 111, group: 1 } });

  const request = { ticker: "ABCD", alert_price: 2.5, alert_stop: 2.42, stage: "band", alert_id: "ev-1" };
  const preview = await call(s.port, { ...from, path: "/preview", json: request });
  assert.equal(preview.status, 200);
  assert.deepEqual(
    { ...preview.body.data, checks: preview.body.data.checks.length },
    {
      ticker: "ABCD",
      entry: "now",
      qty: 100,
      sizing: { mode: "shares" },
      limit: 2.53,
      trigger: null,
      good_until: null,
      take_profit: 2.78,
      stop: 2.42,
      stop_limit: 2.39,
      notional: 253,
      price_from: "alert",
      note: null,
      checks: 11,
    },
  );
  assert.deepEqual(Object.keys(preview.body.data.checks[0]), ["name", "detail"]);
  assert.deepEqual(s.world.allPlaced(), []);

  const order = await call(s.port, { ...from, path: "/order", json: request });
  assert.deepEqual(order.body, {
    data: {
      order_id: 1000,
      ticker: "ABCD",
      entry: "now",
      qty: 100,
      sizing: { mode: "shares" },
      limit: 2.53,
      trigger: null,
      good_until: null,
      take_profit: 2.78,
      stop: 2.42,
      stop_limit: 2.39,
      price_from: "alert",
      note: null,
      status: "PendingSubmit",
    },
  });
  assert.equal(s.world.allPlaced().length, 3);

  // The same alert again: one order per alert.
  const again = await call(s.port, { ...from, path: "/order", json: request });
  assert.equal(again.status, 409);
  assert.deepEqual(again.body, {
    error: "this alert already has an order (order 1000, ABCD, 10:00:00 New York)",
    code: "duplicate_alert",
  });
  assert.equal((await call(s.port, { ...from, path: "/preview", json: request })).body.code, "duplicate_alert");
  // Another alert on the same ticker, seconds later: the ticker's duplicate window.
  const other = await call(s.port, { ...from, path: "/order", json: { ...request, alert_id: "ev-2" } });
  assert.equal(other.status, 409);
  assert.deepEqual(Object.keys(other.body), ["error", "code"]);
  assert.equal(other.body.code, "duplicate");

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

test("flow: chase and sell over HTTP: a click each, by order id, and nothing but the order id", async (t) => {
  const s = await serve(t, { world: (w) => (w.asks.set("ABCD", 2.54), w.bids.set("ABCD", 2.4)) });
  const from = { origin: DASHBOARD };
  assert.deepEqual([(await call(s.port, from)).body.data.order.maxChases, (await call(s.port, from)).body.data.order.sellOffsetPct], [5, 2]);

  await call(s.port, { ...from, path: "/order", json: { ticker: "ABCD", alert_price: 2.5 } });
  const ib = s.world.current;
  ib.emit("orderStatus", 1000, "Submitted", 0, 100, 0);
  s.clock.now += 1000;

  // Both take POST only, a token, an allowed origin and { order_id }.
  for (const path of ["/chase", "/sell"]) {
    assert.equal((await call(s.port, { path })).status, 405);
    assert.equal((await call(s.port, { path, json: { order_id: 1000 }, token: "wrong" })).status, 401);
    assert.equal((await call(s.port, { path, json: { order_id: 1000 }, origin: "https://evil.example" })).status, 403);
    assert.equal((await call(s.port, { ...from, path, json: { order_id: 1000, limit: 3 } })).body.code, "bad_request");
    assert.equal((await call(s.port, { ...from, path, json: { ticker: "ABCD" } })).status, 400);
    const unknown = await call(s.port, { ...from, path, json: { order_id: 55 } });
    assert.deepEqual([unknown.status, unknown.body.code], [404, "unknown_order"]);
  }
  assert.deepEqual(s.world.allModified(), []);

  const chase = await call(s.port, { ...from, path: "/chase", json: { order_id: 1000 } });
  assert.equal(chase.status, 200);
  assert.deepEqual(chase.body, {
    data: { order_id: 1000, limit: 2.57, take_profit: 2.83, stop: 2.44, stop_limit: 2.41, chases: 1, status: "Submitted" },
  });
  const tooSoon = await call(s.port, { ...from, path: "/chase", json: { order_id: 1000 } });
  assert.deepEqual([tooSoon.status, tooSoon.body.code], [409, "too_soon"]);
  assert.deepEqual(Object.keys(tooSoon.body), ["error", "code"]);

  // Nothing is held yet: there is nothing to sell.
  const early = await call(s.port, { ...from, path: "/sell", json: { order_id: 1000 } });
  assert.deepEqual([early.status, early.body.code], [409, "nothing_to_sell"]);

  ib.emit("execDetails", -1, {}, { orderId: 1000, execId: "e1", shares: 100, price: 2.56, cumQty: 100, avgPrice: 2.56 });
  ib.emit("orderStatus", 1000, "Filled", 100, 0, 2.56);
  ib.emit("orderStatus", 1001, "Submitted", 0, 100, 0);
  s.world.positions.set(111, 100);
  s.clock.now += 1000;
  // A halt does not stand in the way of getting out.
  await call(s.port, { ...from, path: "/halt", json: { halted: true } });
  const sell = await call(s.port, { ...from, path: "/sell", json: { order_id: 1000 } });
  assert.equal(sell.status, 200);
  assert.deepEqual(sell.body, { data: { order_id: 1000, qty: 100, limit: 2.35, status: "Submitted", via: "take_profit" } });
  const chased = await call(s.port, { ...from, path: "/chase", json: { order_id: 1000 } });
  assert.deepEqual([chased.status, chased.body.code], [409, "halted"]);

  // /orders: the chase count, the current and the first prices, what is held, and the sell.
  const [item] = (await call(s.port, { ...from, path: "/orders" })).body.data;
  assert.deepEqual(Object.keys(item), [
    "order_id",
    "ticker",
    "conid",
    "placed_at",
    "source",
    "asked",
    "sizing",
    "entry",
    "sent",
    "chases",
    "status",
    "filled_qty",
    "avg_fill_price",
    "slip_pct",
    "held_qty",
    "legs",
    "exit",
    "loose_exit",
    "watch",
    "error",
    "note",
  ]);
  assert.deepEqual(
    [item.chases, item.held_qty, item.sent.limit, item.sent.first_limit, item.sent.take_profit, item.sent.first_take_profit],
    [1, 100, 2.57, 2.53, 2.35, 2.78],
  );
  assert.deepEqual(Object.keys(item.exit), [
    "via",
    "order_id",
    "qty",
    "limit",
    "first_limit",
    "bid",
    "reprices",
    "sent_at",
    "status",
    "filled_qty",
    "avg_fill_price",
    "exit_pct",
  ]);
  assert.deepEqual([item.exit.via, item.exit.order_id, item.exit.limit, item.exit.status], ["take_profit", 1001, 2.35, "Submitted"]);

  // The request log has each click with its order id, and its refusal when there was one.
  const clicks = s.journal
    .ofType("request")
    .filter((line) => (line["path"] === "/chase" || line["path"] === "/sell") && line["order_id"] === 1000 && line["status"] !== 400 && line["status"] !== 401 && line["status"] !== 403)
    .map((line) => [line["path"], line["status"], line["code"]]);
  assert.deepEqual(clicks, [
    ["/chase", 200, undefined],
    ["/chase", 409, "too_soon"],
    ["/sell", 409, "nothing_to_sell"],
    ["/sell", 200, undefined],
    ["/chase", 409, "halted"],
  ]);
  assert.equal(s.world.allPlaced().length, 3);
  assert.deepEqual(s.world.allModified().map((sent) => sent.id), [1000, 1001, 1002, 1001]);
});

test("flow: with TWS down, /status still answers and the rest is 503", async (t) => {
  const s = await serve(t, { world: (w) => (w.mode = "refuse"), connect: false });
  await until(() => s.world.instances.length >= 1, "a connection attempt");
  const status = await call(s.port);
  assert.equal(status.status, 200);
  assert.deepEqual(status.body.data.tws, { connected: false, port: 7497, paper: false, accounts: [], offline: false });
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

test("log: requests are logged with what they were about, and never the token", async (t) => {
  const s = await serve(t);
  await call(s.port, { origin: DASHBOARD, path: "/focus", json: { ticker: "ABCD" } });
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
      ["POST", "/focus", 200],
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
  assert.equal(lines[0]?.["ticker"], "ABCD");
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
  await call(s.port, { path: "/focus", json: { ticker: "ABCD" } }); // a good call is logged whatever the flood
  assert.equal(s.journal.ofType("request").length, 31);

  s.clock.now += 60_000;
  await call(s.port, { token: null });
  assert.deepEqual(s.journal.ofType("requests_refused"), [{ type: "requests_refused", not_logged: 10 }]);
  assert.equal(s.journal.ofType("request").length, 32);
});

// --------------------------------------------------------------- the polls

test("polls: a hundred answered GET /status and GET /orders add no line to the log", async (t) => {
  const s = await serve(t);
  const before = s.journal.events.length;
  for (let i = 0; i < 50; i += 1) {
    const status = await call(s.port, { origin: DASHBOARD });
    assert.equal(status.status, 200);
    const orders = await call(s.port, { origin: DASHBOARD, path: "/orders" });
    assert.equal(orders.status, 200);
  }
  assert.equal(s.journal.events.length, before);
  assert.deepEqual(s.journal.ofType("request"), []);
  // A query string or the dev origin does not make a poll something else.
  await call(s.port, { origin: DEV, path: "/status?t=1" });
  await call(s.port, { path: "/orders?since=0" });
  assert.equal(s.journal.events.length, before);
});

test("polls: everything else is still logged, and so is a poll that fails", async (t) => {
  const s = await serve(t);
  await call(s.port); // answered: not logged
  await call(s.port, { path: "/orders" }); // answered: not logged
  await call(s.port, { token: "wrong" }); // 401
  await call(s.port, { path: "/orders", token: null }); // 401
  await call(s.port, { path: "/orders", origin: "https://evil.example" }); // 403
  await call(s.port, { path: "/status", json: {} }); // POST to a GET route: 405
  await call(s.port, { method: "OPTIONS", path: "/status", token: null, origin: DASHBOARD }); // the preflight of a poll
  await call(s.port, { path: "/focus", json: { ticker: "ABCD" } });
  await call(s.port, { path: "/preview", json: { ticker: "ABCD", alert_price: 2.5 } });
  await call(s.port, { path: "/halt", json: { halted: false } });
  await call(s.port, { path: "/nothing" }); // 404

  assert.deepEqual(
    s.journal.ofType("request").map((line) => [line["method"], line["path"], line["status"]]),
    [
      ["GET", "/status", 401],
      ["GET", "/orders", 401],
      ["GET", "/orders", 403],
      ["POST", "/status", 405],
      ["OPTIONS", "/status", 204],
      ["POST", "/focus", 200],
      ["POST", "/preview", 200],
      ["POST", "/halt", 200],
      ["GET", "/nothing", 404],
    ],
  );
});

test("polls: one that fails inside the bridge is logged", async (t) => {
  t.mock.method(console, "error", () => undefined);
  const journal = new MemoryJournal();
  const bridge = {
    status(): never {
      throw new Error("boom");
    },
    orders: () => [],
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
  assert.equal((await call(port)).status, 500);
  assert.equal((await call(port, { path: "/orders" })).status, 200);
  assert.deepEqual(
    journal.ofType("request").map((line) => [line["method"], line["path"], line["status"], line["code"]]),
    [["GET", "/status", 500, "internal"]],
  );
});

test("polls: an order placed between polls is logged, and a restart reads it back from a log with no poll lines", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tws-bridge-polls-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "2026-11-25.jsonl");
  const lineCount = (): number => fs.readFileSync(file, "utf8").trim().split("\n").length;
  const poll = async (port: number, times: number): Promise<void> => {
    for (let i = 0; i < times; i += 1) {
      assert.equal((await call(port, { origin: DASHBOARD })).status, 200);
      assert.equal((await call(port, { origin: DASHBOARD, path: "/orders" })).status, 200);
    }
  };

  const a = await serve(t, { journal: new FileJournal(dir, () => T0, [TOKEN]) });
  const atStart = lineCount(); // the connection to TWS is the only thing in the file
  await poll(a.port, 50);
  assert.equal(lineCount(), atStart);

  const request = { ticker: "ABCD", alert_price: 2.5, alert_stop: 2.42, stage: "band", alert_id: "ev-1" };
  const order = await call(a.port, { origin: DASHBOARD, path: "/order", json: request });
  assert.equal(order.body.data.order_id, 1000);
  a.world.current.emit("orderStatus", 1000, "Submitted", 0, 100, 0);
  a.world.current.emit("execDetails", -1, {}, { orderId: 1000, execId: "e1", shares: 100, price: 2.52, cumQty: 100, avgPrice: 2.52 });
  a.world.current.emit("orderStatus", 1000, "Filled", 100, 0, 2.52);
  const afterOrder = lineCount();
  await poll(a.port, 50);
  assert.equal(lineCount(), afterOrder);

  // What the file holds: the order and what happened to it, and the one request that placed it.
  const lines = fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(
    lines.map((line) => line["type"]),
    ["tws_up", "order_placed", "request", "order_status", "fill", "order_status"],
  );
  assert.deepEqual(
    lines.filter((line) => line["type"] === "request").map((line) => [line["method"], line["path"], line["status"], line["ticker"]]),
    [["POST", "/order", 200, "ABCD"]],
  );
  const polled = (await call(a.port, { path: "/orders" })).body.data;
  a.link.stop();

  // The bridge is started again: the day's book comes back whole.
  const b = await serve(t, { journal: new FileJournal(dir, () => T0 + 5000, [TOKEN]), now: T0 + 5000 });
  const status = (await call(b.port)).body.data;
  assert.deepEqual(status.today, { orders: 1, filled: 1 });
  const restored = (await call(b.port, { path: "/orders" })).body.data;
  assert.deepEqual(restored, polled);
  assert.deepEqual(
    [restored[0].order_id, restored[0].status, restored[0].filled_qty, restored[0].avg_fill_price, restored[0].slip_pct, restored[0].asked.alert_id],
    [1000, "Filled", 100, 2.52, 0.8, "ev-1"],
  );
  // The rails that rest on the book hold: the alert is used, the ticker was just ordered.
  const again = await call(b.port, { path: "/order", json: request });
  assert.equal(again.body.code, "duplicate_alert");
  const other = await call(b.port, { path: "/order", json: { ticker: "ABCD", alert_price: 2.5 } });
  assert.equal(other.body.code, "duplicate");
  assert.deepEqual(b.world.allPlaced(), []);
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
