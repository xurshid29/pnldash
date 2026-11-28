import assert from "node:assert/strict";
import { test } from "node:test";
import { isPaper, maskAccount } from "../src/bridge.js";
import { listing, until } from "./fake-tws.js";
import { buy, refuses, refusesNow, rig, T0 } from "./harness.js";

const ABCD = { conId: 111, symbol: "ABCD", secType: "STK", exchange: "SMART", currency: "USD" };

// ------------------------------------------------------------------ status

test("status: the shape the dashboard reads, with masked accounts", async (t) => {
  const r = await rig(t);
  assert.deepEqual(r.bridge.status(), {
    version: "0.0.0-test",
    tws: { connected: true, port: 7497, paper: true, accounts: ["DU…67"], offline: false },
    enabled: true,
    halted: false,
    paper_only: true,
    display_group: 1,
    display_groups: [],
    order: {
      qty: 100,
      priceFrom: "alert",
      limitOffsetPct: 1,
      maxChasePct: 3,
      takeProfitPct: 10,
      stopPct: 5,
      stopLimitOffsetPct: 1,
      useAlertStop: true,
      outsideRth: true,
      maxChases: 5,
      sellOffsetPct: 2,
      amountUsd: 0,
      askFallback: "alert",
      entryStopPct: 3,
      entryStopLimitPct: 1,
      entryValidSec: 300,
    },
    limits: { maxShares: 500, maxNotionalUsd: 1000, maxOrdersPerDay: 20, duplicateWindowSec: 10 },
    today: { orders: 0, filled: 0 },
  });
  // The full account id is nowhere in the answer.
  assert.equal(JSON.stringify(r.bridge.status()).includes("DU1234567"), false);
});

test("status: account masking and the paper test", () => {
  assert.equal(maskAccount("DU1234567"), "DU…67");
  assert.equal(maskAccount("U7654321"), "U7…21");
  assert.equal(maskAccount("DU12"), "…"); // too short to show both ends without showing it all
  assert.equal(isPaper(["DU1234567"]), true);
  assert.equal(isPaper(["DU1234567", "DF7654321"]), true);
  assert.equal(isPaper(["U7654321"]), false);
  assert.equal(isPaper(["DU1234567", "U7654321"]), false); // every account must be paper
  assert.equal(isPaper([]), false); // no account known yet is not paper
});

test("status: a live account and several accounts", async (t) => {
  const live = await rig(t, { world: (w) => (w.accounts = "U7654321") });
  assert.deepEqual(live.bridge.status().tws, {
    connected: true,
    port: 7497,
    paper: false,
    accounts: ["U7…21"],
    offline: false,
  });

  const mixed = await rig(t, { world: (w) => (w.accounts = "DU1234567,U7654321") });
  assert.deepEqual(mixed.bridge.status().tws.accounts, ["DU…67", "U7…21"]);
  assert.equal(mixed.bridge.status().tws.paper, false);
});

test("status: TWS not running", async (t) => {
  const r = await rig(t, { world: (w) => (w.mode = "refuse"), connect: false });
  await until(() => r.world.instances.length >= 2, "a retry");
  assert.deepEqual(r.bridge.status().tws, { connected: false, port: 7497, paper: false, accounts: [], offline: false });
});

test("status: tws.offline is true while TWS has lost IB's servers, and never while TWS is not connected", async (t) => {
  const r = await rig(t);
  assert.equal(r.bridge.status().tws.offline, false);

  r.world.current.emit("info", "Connectivity between IB and Trader Workstation has been lost.", 1100);
  assert.deepEqual(r.bridge.status().tws, { connected: true, port: 7497, paper: true, accounts: ["DU…67"], offline: true });
  await refuses(r.bridge.order(buy()), 503, "tws_offline"); // the same condition as the order rail

  r.world.current.emit("info", "Connectivity restored - data maintained.", 1102);
  assert.equal(r.bridge.status().tws.offline, false);

  // Lost again, and then TWS itself goes away: that is "not connected", not "offline".
  r.world.current.emit("info", "Connectivity between Trader Workstation and server is broken.", 2110);
  assert.equal(r.bridge.status().tws.offline, true);
  r.world.mode = "refuse";
  r.world.drop();
  assert.deepEqual(r.bridge.status().tws, { connected: false, port: 7497, paper: false, accounts: [], offline: false });
});

// ------------------------------------------------------- preview and order

test("preview: the order that would be sent, the checks it passed, and nothing sent", async (t) => {
  const r = await rig(t);
  const preview = await r.bridge.preview(buy({ alert_stop: 2.42 }));
  assert.deepEqual(
    { ...preview, checks: preview.checks.map((check) => check.name) },
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
      checks: ["switches", "account", "shares", "daily", "duplicate", "contract", "limit", "take_profit", "stop", "notional"],
    },
  );
  const detail = (name: string): string => preview.checks.find((check) => check.name === name)?.detail ?? "";
  assert.equal(detail("account"), "paper account");
  assert.equal(detail("shares"), "100 of 500 allowed");
  assert.equal(detail("daily"), "order 1 of 20 today");
  assert.equal(detail("contract"), "conid 111 on NASDAQ");
  assert.match(detail("limit"), /^2\.53 = the alert's price 2\.50 \+ 1%; 1\.2% past the alert \(max 3%\)$/);
  assert.equal(detail("stop"), "2.42, limit 2.39: the alert's stop");
  assert.equal(detail("notional"), "$253.00 of $1000 allowed");

  assert.deepEqual(r.world.allPlaced(), []);
  assert.deepEqual(r.journal.ofType("order_placed"), []);
  assert.deepEqual(r.bridge.status().today, { orders: 0, filled: 0 });
  // A preview is not an order: it does not start the duplicate window.
  await r.bridge.preview(buy());
  await r.bridge.order(buy());
});

test("preview: says when the alert's stop was not used", async (t) => {
  const r = await rig(t);
  const preview = await r.bridge.preview(buy({ alert_stop: 1.9 }));
  assert.equal(preview.stop, 2.4);
  assert.match(preview.checks.find((check) => check.name === "stop")?.detail ?? "", /5% under the limit; the alert's stop was not used: it \(1\.90\) is 24\.9% under the limit/);
});

test("order: the bracket goes out as three orders, in order, on the resolved contract", async (t) => {
  const r = await rig(t);
  const alertAt = new Date(T0 - 30_000).toISOString();
  const result = await r.bridge.order(buy({ alert_stop: 2.42, stage: "band", alert_id: 987, alert_at: alertAt }));
  assert.deepEqual(result, {
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
  });

  const placed = r.world.current.placed();
  assert.deepEqual(placed.map((p) => p.id), [1000, 1001, 1002]);
  for (const p of placed) assert.deepEqual(p.contract, ABCD);
  assert.deepEqual(
    placed.map((p) => p.order),
    [
      { action: "BUY", orderType: "LMT", totalQuantity: 100, lmtPrice: 2.53, tif: "DAY", outsideRth: true, parentId: 0, transmit: false },
      { action: "SELL", orderType: "LMT", totalQuantity: 100, lmtPrice: 2.78, tif: "GTC", outsideRth: true, parentId: 1000, transmit: false },
      { action: "SELL", orderType: "STP LMT", totalQuantity: 100, auxPrice: 2.42, lmtPrice: 2.39, tif: "GTC", outsideRth: true, parentId: 1000, transmit: true },
    ],
  );

  const [record] = r.bridge.orders();
  assert.deepEqual(record, {
    order_id: 1000,
    ticker: "ABCD",
    conid: 111,
    placed_at: new Date(T0).toISOString(),
    // A click's order says so: the automation's exit watch leaves it alone.
    source: "click",
    asked: { alert_price: 2.5, alert_stop: 2.42, qty: null, stage: "band", alert_at: alertAt, alert_id: "987" },
    sizing: { mode: "shares" },
    entry: "now",
    sent: {
      qty: 100,
      limit: 2.53,
      trigger: null,
      good_until: null,
      take_profit: 2.78,
      // A click's take-profit is for the whole position.
      take_profit_qty: 100,
      stop: 2.42,
      stop_limit: 2.39,
      stop_own: false,
      // The prices the bracket was placed with: these stay when a chase or a sell moves the others.
      first_limit: 2.53,
      first_take_profit: 2.78,
      first_stop: 2.42,
      first_stop_limit: 2.39,
      price_from: "alert",
      stop_from: "alert",
      outside_rth: true,
      order_ids: { parent: 1000, take_profit: 1001, stop: 1002 },
    },
    chases: 0,
    status: "PendingSubmit",
    filled_qty: 0,
    avg_fill_price: null,
    slip_pct: null,
    held_qty: 0,
    legs: {
      take_profit: { order_id: 1001, status: "PendingSubmit", filled_qty: 0, avg_fill_price: null },
      stop: { order_id: 1002, status: "PendingSubmit", filled_qty: 0, avg_fill_price: null },
    },
    exit: null,
    loose_exit: false,
    watch: null,
    error: null,
    note: null,
  });

  // The log line carries the ticker, the alert's price, the computed prices and the order ids.
  const [line] = r.journal.ofType("order_placed");
  assert.deepEqual({ ...line, type: undefined }, { ...record, type: undefined });
  assert.deepEqual(r.bridge.status().today, { orders: 1, filled: 0 });
});

test("order: ids are three in a row per order and never reused", async (t) => {
  const r = await rig(t, { config: (c) => (c.order.takeProfitPct = 0) });
  const first = await r.bridge.order(buy({ ticker: "ABCD" }));
  const second = await r.bridge.order(buy({ ticker: "WXYZ" }));
  assert.equal(first.order_id, 1000);
  assert.equal(second.order_id, 1003);
  // No take-profit: its id (1001, 1004) stays unused; the stop is the leg that transmits.
  assert.deepEqual(
    r.world.allPlaced().map((p) => [p.id, p.order.parentId, p.order.transmit]),
    [
      [1000, 0, false],
      [1002, 1000, true],
      [1003, 0, false],
      [1005, 1003, true],
    ],
  );
  assert.equal(first.take_profit, null);
  assert.deepEqual(r.bridge.orders().map((o) => o.order_id), [1003, 1000]); // newest first
});

test("order: /order waits a moment for TWS's first word and answers with it", async (t) => {
  const r = await rig(t, { ackWaitMs: 500 });
  const pending = r.bridge.order(buy());
  await until(() => r.world.current.placed().length === 3, "the bracket");
  r.world.current.emit("orderStatus", 1000, "Submitted", 0, 100, 0);
  assert.equal((await pending).status, "Submitted");
});

test("order: qty from the request, outsideRth and the defaults from the config", async (t) => {
  const r = await rig(t, { config: (c) => (c.order.outsideRth = false) });
  const result = await r.bridge.order(buy({ qty: 30 }));
  assert.equal(result.qty, 30);
  assert.deepEqual(r.world.allPlaced().map((p) => [p.order.totalQuantity, p.order.outsideRth]), [
    [30, false],
    [30, false],
    [30, false],
  ]);
  assert.equal(r.bridge.orders()[0]?.asked.qty, 30);
});

// ------------------------------------------------------------- the request

test("request: only the documented fields are accepted; prices cannot be sent in", async (t) => {
  const r = await rig(t);
  for (const extra of ["limit", "take_profit", "stop", "stop_limit", "limitOffsetPct", "paperOnly", "outsideRth"]) {
    await refuses(r.bridge.order(buy({ [extra]: 1 })), 400, "bad_request", new RegExp(`unknown field "${extra}"`));
    await refuses(r.bridge.preview(buy({ [extra]: 1 })), 400, "bad_request");
  }
  for (const body of [null, undefined, "ABCD", 5, [buy()]]) {
    await refuses(r.bridge.order(body), 400, "bad_request", /must be a JSON object/);
  }
  assert.deepEqual(r.world.allPlaced(), []);
});

test("request: the ticker is upper-cased and must look like a US symbol", async (t) => {
  const r = await rig(t);
  assert.equal((await r.bridge.preview(buy({ ticker: "abcd" }))).ticker, "ABCD");
  for (const ticker of ["1ABC", "", "AB CD", " ABCD", "TOOLONGX", "AB-C", "AB/C", ".AB", 5, null, undefined, ["ABCD"]]) {
    await refuses(r.bridge.preview(buy({ ticker })), 400, "bad_request", /ticker/);
    await refuses(r.bridge.order(buy({ ticker })), 400, "bad_request", /ticker/);
    await refuses(r.bridge.focus({ ticker }), 400, "bad_request", /ticker/);
  }
  // Seven characters is the longest symbol; TWS just does not know this one.
  await refuses(r.bridge.preview(buy({ ticker: "ABCDEFG" })), 404, "unknown_ticker");
  assert.deepEqual(r.world.allPlaced(), []);
});

test("request: a class share is looked up the way TWS spells it", async (t) => {
  const r = await rig(t);
  const result = await r.bridge.order(buy({ ticker: "brk.b" }));
  assert.equal(result.ticker, "BRK.B");
  assert.equal((r.world.current.callsOf("reqContractDetails")[0]?.args[1] as { symbol: string }).symbol, "BRK B");
  assert.deepEqual(r.world.allPlaced()[0]?.contract, { ...ABCD, conId: 555, symbol: "BRK B" });
});

test("request: alert_price must be a positive finite number under 100000", async (t) => {
  const r = await rig(t);
  for (const alert_price of [0, -1, "2.5", null, undefined, true, 100000, 1e9, Number.NaN, Number.POSITIVE_INFINITY]) {
    await refuses(r.bridge.order(buy({ alert_price })), 400, "bad_request", /alert_price must be a number above 0 and under 100000/);
    await refuses(r.bridge.preview(buy({ alert_price })), 400, "bad_request");
  }
  for (const alert_stop of [0, -2, "2.4", 100000]) {
    await refuses(r.bridge.order(buy({ alert_stop })), 400, "bad_request", /alert_stop/);
  }
  for (const qty of [0, -5, 1.5, "100"]) {
    await refuses(r.bridge.order(buy({ qty })), 400, "bad_request", /qty/);
  }
  await refuses(r.bridge.order(buy({ stage: 5 })), 400, "bad_request", /stage/);
  await refuses(r.bridge.order(buy({ alert_id: { a: 1 } })), 400, "bad_request", /alert_id/);
  assert.deepEqual(r.world.allPlaced(), []);

  // null is "not given" for the optional fields.
  const ok = await r.bridge.preview(buy({ alert_stop: null, qty: null, stage: null, alert_at: null, alert_id: null }));
  assert.equal(ok.stop, 2.4);
  assert.equal(ok.limit, 2.53);
});

test("request: a stale alert is refused; alert_at takes ISO text or epoch time", async (t) => {
  const r = await rig(t);
  const minutesAgo = (m: number): number => T0 - m * 60_000;

  await refuses(
    r.bridge.order(buy({ alert_at: new Date(minutesAgo(11)).toISOString() })),
    422,
    "stale_alert",
    /^the alert is stale: it is 11 min old \(the limit is 10 min\)$/,
  );
  await refuses(r.bridge.order(buy({ alert_at: minutesAgo(10) - 1000 })), 422, "stale_alert");
  await refuses(r.bridge.order(buy({ alert_at: Math.floor(minutesAgo(30) / 1000) })), 422, "stale_alert"); // epoch seconds
  assert.deepEqual(r.world.allPlaced(), []);

  const fresh = await r.bridge.preview(buy({ alert_at: new Date(minutesAgo(9)).toISOString() }));
  assert.equal(fresh.checks.find((check) => check.name === "alert_age")?.detail, "540s old");
  await r.bridge.preview(buy({ alert_at: minutesAgo(9) })); // epoch milliseconds
  await r.bridge.preview(buy({ alert_at: Math.floor(minutesAgo(9) / 1000) })); // epoch seconds
  await r.bridge.preview(buy({ alert_at: T0 + 30_000 })); // the server's clock may run a little ahead

  await refuses(r.bridge.preview(buy({ alert_at: T0 + 5 * 60_000 })), 400, "bad_request", /in the future/);
  for (const alert_at of ["soon", "", true, {}]) {
    await refuses(r.bridge.preview(buy({ alert_at })), 400, "bad_request", /alert_at/);
  }
});

// ------------------------------------------------------------- the switches

test("rail: enabled false means no orders", async (t) => {
  const r = await rig(t, { config: (c) => (c.enabled = false) });
  await refuses(r.bridge.order(buy()), 409, "disabled", /"enabled" is false in config\.json/);
  await refuses(r.bridge.preview(buy()), 409, "disabled");
  assert.deepEqual(r.world.allPlaced(), []);
  assert.equal(r.bridge.status().enabled, false);
});

test("rail: halted true means no orders", async (t) => {
  const r = await rig(t, { config: (c) => (c.halted = true) });
  await refuses(r.bridge.order(buy()), 409, "halted", /orders are halted/);
  await refuses(r.bridge.preview(buy()), 409, "halted");
  assert.deepEqual(r.world.allPlaced(), []);
  assert.equal(r.bridge.status().halted, true);
});

test("rail: TWS not connected is 503 for focus, preview and order", async (t) => {
  const r = await rig(t, { world: (w) => (w.mode = "refuse"), connect: false });
  await refuses(r.bridge.focus({ ticker: "ABCD" }), 503, "tws_down", /TWS is not connected \(API port 7497\)/);
  await refuses(r.bridge.preview(buy()), 503, "tws_down");
  await refuses(r.bridge.order(buy()), 503, "tws_down");
  assert.deepEqual(r.world.allPlaced(), []);
});

test("rail: the connection dropping while an order is being prepared sends nothing", async (t) => {
  const r = await rig(t);
  r.world.silentLookups = true;
  const pending = r.bridge.order(buy());
  await until(() => r.world.current.callsOf("reqContractDetails").length === 1, "the lookup");
  r.world.mode = "refuse";
  r.world.drop();
  await refuses(pending, 503, "tws_down", /nothing was sent for ABCD/);
  assert.deepEqual(r.world.allPlaced(), []);
  assert.deepEqual(r.bridge.orders(), []);
});

test("rail: TWS cut off from IB's servers means no orders (they would go out later)", async (t) => {
  const r = await rig(t);
  r.world.current.emit("info", "Connectivity between IB and Trader Workstation has been lost.", 1100);
  await refuses(r.bridge.order(buy()), 503, "tws_offline", /would wait in TWS and go out later/);
  await refuses(r.bridge.preview(buy()), 503, "tws_offline");
  assert.deepEqual(r.world.allPlaced(), []);
  await r.bridge.focus({ ticker: "ABCD" }); // looking at a chart is still fine

  r.world.current.emit("info", "Connectivity restored - data maintained.", 1102);
  await r.bridge.order(buy());
  assert.equal(r.world.allPlaced().length, 3);
});

// ------------------------------------------------------------ paper only

test("rail: paperOnly refuses a live account and says how to change it", async (t) => {
  const r = await rig(t, { world: (w) => (w.accounts = "U7654321") });
  const message =
    /^paperOnly is on and the account TWS is logged in to is not a paper account: no orders\. To trade a live account, set "paperOnly": false in config\.json by hand and restart the bridge; it cannot be changed over HTTP\.$/;
  await refuses(r.bridge.order(buy()), 409, "paper_only", message);
  await refuses(r.bridge.preview(buy()), 409, "paper_only", message);
  assert.deepEqual(r.world.allPlaced(), []);
});

test("rail: paperOnly needs every account to be paper, and an account to be known", async (t) => {
  const mixed = await rig(t, { world: (w) => (w.accounts = "DU1234567,U7654321") });
  await refuses(mixed.bridge.order(buy()), 409, "paper_only");
  assert.deepEqual(mixed.world.allPlaced(), []);

  const unknown = await rig(t, { world: (w) => (w.accounts = null) });
  await refuses(unknown.bridge.order(buy()), 409, "paper_only", /TWS has not reported its account yet/);
  assert.deepEqual(unknown.world.allPlaced(), []);
});

test("rail: with paperOnly switched off by hand, a live account trades", async (t) => {
  const r = await rig(t, { world: (w) => (w.accounts = "U7654321"), config: (c) => (c.paperOnly = false) });
  const preview = await r.bridge.preview(buy());
  assert.equal(preview.checks.find((check) => check.name === "account")?.detail, "LIVE account (paperOnly is off)");
  await r.bridge.order(buy());
  assert.equal(r.world.allPlaced().length, 3);
  assert.equal(r.bridge.status().paper_only, false);
});

// ------------------------------------------------------------ size limits

test("rail: qty ≤ maxShares and qty × limit ≤ maxNotionalUsd", async (t) => {
  const r = await rig(t);
  await refuses(r.bridge.order(buy({ qty: 501 })), 422, "too_many_shares", /^501 shares is above maxShares \(500\)$/);
  // 396 × 2.53 = 1001.88
  await refuses(r.bridge.order(buy({ qty: 396 })), 422, "too_large", /^the order is \$1001\.88 \(396 × 2\.53\), above maxNotionalUsd \(\$1000\)$/);
  await refuses(r.bridge.preview(buy({ qty: 396 })), 422, "too_large");
  // The default 100 shares of a $12 stock is $1212.
  await refuses(r.bridge.order(buy({ alert_price: 12 })), 422, "too_large");
  assert.deepEqual(r.world.allPlaced(), []);

  // 395 × 2.53 = 999.35
  assert.equal((await r.bridge.preview(buy({ qty: 395 }))).notional, 999.35);
  assert.equal((await r.bridge.order(buy({ qty: 395 }))).qty, 395);
});

test("rail: the price running away is refused before anything is sent", async (t) => {
  const r = await rig(t, { config: (c) => (c.order.priceFrom = "ask"), world: (w) => w.asks.set("ABCD", 2.6) });
  await refuses(r.bridge.order(buy()), 422, "chase", /^price has run 5\.2% past the alert/);
  await refuses(r.bridge.preview(buy()), 422, "chase");
  assert.deepEqual(r.world.allPlaced(), []);
});

test('order: priceFrom "ask" takes one free snapshot and prices off its ask', async (t) => {
  const r = await rig(t, {
    config: (c) => {
      c.order.priceFrom = "ask";
      // Without a live ask this refuses, as it always did; the fallback to the alert's price
      // (the default since) has its own tests in sizing.test.ts.
      c.order.askFallback = "none";
    },
    world: (w) => w.asks.set("ABCD", 2.52),
  });
  const result = await r.bridge.order(buy());
  assert.equal(result.limit, 2.55); // 2.52 + 1%
  assert.equal(result.take_profit, 2.81);
  assert.equal(result.stop, 2.42);

  const snapshots = r.world.current.callsOf("reqMktData");
  assert.equal(snapshots.length, 1);
  assert.deepEqual(snapshots[0]?.args.slice(1), [ABCD, "", true, false]); // snapshot: true, regulatorySnapshot: false
  assert.equal(r.bridge.orders()[0]?.sent.price_from, "ask");

  // No ask within the wait (40 ms here, 800 ms by default): an error, nothing sent.
  await refuses(r.bridge.order(buy({ ticker: "WXYZ" })), 504, "no_ask", /^no ask for WXYZ from TWS within 40 ms$/);
  assert.equal(r.world.allPlaced().length, 3);
});

// ----------------------------------------------------------- daily count

test("rail: the daily count is by New York date, and resets at New York midnight", async (t) => {
  // 23:50 on Wednesday the 25th in New York; in UTC it is already the 26th.
  const r = await rig(t, { config: (c) => (c.limits.maxOrdersPerDay = 2), now: Date.parse("2026-11-26T04:50:00Z") });
  await r.bridge.order(buy({ ticker: "ABCD" }));
  await r.bridge.order(buy({ ticker: "WXYZ" }));
  await refuses(
    r.bridge.order(buy({ ticker: "QQQQ" })),
    409,
    "daily_limit",
    /^the daily order limit is reached: 2 of 2 today \(New York date 2026-11-25\)$/,
  );
  await refuses(r.bridge.preview(buy({ ticker: "QQQQ" })), 409, "daily_limit");
  assert.deepEqual(r.bridge.status().today, { orders: 2, filled: 0 });
  assert.equal(r.world.allPlaced().length, 6);

  // 00:01 on the 26th in New York: a new day, though the UTC date has not changed.
  r.clock.now = Date.parse("2026-11-26T05:01:00Z");
  assert.deepEqual(r.bridge.status().today, { orders: 0, filled: 0 });
  assert.deepEqual(r.bridge.orders(), []);
  await r.bridge.order(buy({ ticker: "QQQQ" }));
  assert.deepEqual(r.bridge.orders().map((o) => o.ticker), ["QQQQ"]);
  assert.deepEqual(r.bridge.status().today, { orders: 1, filled: 0 });
});

test("rail: UTC midnight is not a new day", async (t) => {
  // 18:59 in New York on the 25th.
  const r = await rig(t, { config: (c) => (c.limits.maxOrdersPerDay = 2), now: Date.parse("2026-11-25T23:59:00Z") });
  await r.bridge.order(buy({ ticker: "ABCD" }));
  await r.bridge.order(buy({ ticker: "WXYZ" }));
  r.clock.now = Date.parse("2026-11-26T00:30:00Z"); // 19:30 in New York, still the 25th
  await refuses(r.bridge.order(buy({ ticker: "QQQQ" })), 409, "daily_limit", /New York date 2026-11-25/);
  assert.deepEqual(r.bridge.status().today, { orders: 2, filled: 0 });
});

test("rail: maxOrdersPerDay 0 allows nothing", async (t) => {
  const r = await rig(t, { config: (c) => (c.limits.maxOrdersPerDay = 0) });
  await refuses(r.bridge.order(buy()), 409, "daily_limit", /0 of 0 today/);
  assert.deepEqual(r.world.allPlaced(), []);
});

// ------------------------------------------------------------- duplicates

test("rail: the same ticker inside the duplicate window is refused", async (t) => {
  const r = await rig(t);
  await r.bridge.order(buy());
  r.clock.now += 3000;
  await refuses(r.bridge.order(buy()), 409, "duplicate", /^duplicate: ABCD was ordered 3s ago \(the window is 10s\)$/);
  await refuses(r.bridge.preview(buy()), 409, "duplicate");
  await refuses(r.bridge.order(buy({ ticker: "abcd", alert_price: 2.6 })), 409, "duplicate"); // same ticker, whatever the price
  assert.equal(r.world.allPlaced().length, 3);

  await r.bridge.order(buy({ ticker: "WXYZ" })); // another ticker is not a duplicate
  r.clock.now += 6999;
  await refuses(r.bridge.order(buy()), 409, "duplicate"); // 9.999 s
  r.clock.now += 1;
  await r.bridge.order(buy()); // 10 s: the window is over
  assert.equal(r.world.allPlaced().length, 9);
});

test("rail: a double click places one order", async (t) => {
  const r = await rig(t);
  const results = await Promise.allSettled([r.bridge.order(buy()), r.bridge.order(buy()), r.bridge.order(buy())]);
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "rejected", "rejected"]);
  for (const result of results.slice(1)) {
    assert.equal((result as PromiseRejectedResult).reason.code, "duplicate");
  }
  assert.equal(r.world.allPlaced().length, 3);
  assert.equal(r.bridge.orders().length, 1);
});

test("rail: a refused order does not start the duplicate window or count for the day", async (t) => {
  const r = await rig(t);
  await refuses(r.bridge.order(buy({ qty: 501 })), 422, "too_many_shares");
  await r.bridge.order(buy());
  assert.deepEqual(r.bridge.status().today, { orders: 1, filled: 0 });
});

// ------------------------------------------------------------------ halt

test("halt: the off switch stops orders at once and is saved; switching it back on works too", async (t) => {
  const r = await rig(t);
  assert.deepEqual(r.bridge.halt({ halted: true }), { halted: true });
  assert.deepEqual(r.saved, [true]);
  assert.equal(r.bridge.status().halted, true);
  await refuses(r.bridge.order(buy()), 409, "halted");
  assert.deepEqual(r.world.allPlaced(), []);
  await r.bridge.focus({ ticker: "ABCD" }); // focus places nothing: still allowed

  assert.deepEqual(r.bridge.halt({ halted: false }), { halted: false });
  assert.deepEqual(r.saved, [true, false]);
  await r.bridge.order(buy());
  assert.equal(r.world.allPlaced().length, 3);
  assert.deepEqual(r.journal.ofType("halt").map((line) => line["halted"]), [true, false]);
});

test("halt: takes only { halted: true | false }; paperOnly cannot be reached through it", async (t) => {
  const r = await rig(t);
  for (const body of [{}, { halted: "true" }, { halted: 1 }, { halted: null }, null, []]) {
    refusesNow(() => r.bridge.halt(body), 400, "bad_request");
  }
  refusesNow(() => r.bridge.halt({ halted: false, paperOnly: false }), 400, "bad_request", /unknown field "paperOnly"/);
  refusesNow(() => r.bridge.halt({ halted: false, enabled: true }), 400, "bad_request", /unknown field "enabled"/);
  assert.deepEqual(r.saved, []);
  assert.equal(r.bridge.status().paper_only, true);
});

test("halt: pressed while an order is being prepared, it still stops that order", async (t) => {
  const r = await rig(t);
  r.world.silentLookups = true;
  const pending = r.bridge.order(buy());
  await until(() => r.world.current.callsOf("reqContractDetails").length === 1, "the lookup");
  r.bridge.halt({ halted: true });
  const reqId = r.world.current.callsOf("reqContractDetails")[0]?.args[0];
  r.world.current.emit("contractDetails", reqId, listing("ABCD", 111, "NASDAQ"));
  r.world.current.emit("contractDetailsEnd", reqId);
  await refuses(pending, 409, "halted");
  assert.deepEqual(r.world.allPlaced(), []);
});

test("halt: when saving fails the halt still holds, and the answer says it was not saved", async (t) => {
  const r = await rig(t, {
    saveHalted: () => {
      throw new Error("EACCES: permission denied");
    },
  });
  refusesNow(() => r.bridge.halt({ halted: true }), 500, "not_saved", /halted is now true in the running bridge, but saving it to config\.json failed: EACCES/);
  assert.equal(r.bridge.status().halted, true);
  await refuses(r.bridge.order(buy()), 409, "halted");
});
