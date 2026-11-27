import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultConfig } from "../src/config.js";
import type { Config, OrderConfig } from "../src/config.js";
import { BridgeError } from "../src/errors.js";
import { FileJournal } from "../src/journal.js";
import { formatUsd, planOrder } from "../src/order.js";
import type { PlanInput } from "../src/order.js";
import { until } from "./fake-tws.js";
import { buy, refuses, rig, T0, TOKEN } from "./harness.js";
import { tempDir, working } from "./scenes.js";

// order.amountUsd: a buy sized in dollars. Above 0, a click that names no quantity buys as many
// whole shares as the amount pays for at the limit the order carries.
//
// order.askFallback: with priceFrom "ask", what a buy does when TWS gives no live ask.

function cfg(overrides: Partial<OrderConfig> = {}): OrderConfig {
  return { ...defaultConfig("x").order, amountUsd: 400, ...overrides };
}

function input(alertPrice: number, overrides: Partial<PlanInput> = {}): PlanInput {
  return { qty: null, alertPrice, alertStop: null, ask: null, ...overrides };
}

const USD = (c: Config): void => void (c.order.amountUsd = 400);

// ------------------------------------------------------- the arithmetic

test("sizing: dollars become whole shares at the buy's limit, rounded down, on both sides of $1", () => {
  // Above $1: 2.50 + 1% → 2.53; 400 / 2.53 = 158.1
  const plan = planOrder(cfg(), input(2.5));
  assert.deepEqual([plan.limit, plan.qty, plan.notional], [2.53, 158, 399.74]);
  assert.deepEqual(plan.sizing, { mode: "usd", amount_usd: 400 });
  // The exits are for the same shares, at their usual distances.
  assert.deepEqual([plan.takeProfit, plan.stop, plan.stopLimit], [2.78, 2.4, 2.37]);

  // 12.00 → 12.12; 400 / 12.12 = 33.003
  assert.deepEqual([planOrder(cfg(), input(12)).qty, planOrder(cfg(), input(12)).notional], [33, 399.96]);
  // Under $1, on the hundredth of a cent: 0.98 → 0.9898; 400 / 0.9898 = 404.1
  assert.deepEqual([planOrder(cfg(), input(0.98)).limit, planOrder(cfg(), input(0.98)).qty], [0.9898, 404]);
  // A limit that rounds onto $1 from under it: 0.995 → 1.00495 → 1.00
  assert.deepEqual([planOrder(cfg(), input(0.995)).limit, planOrder(cfg(), input(0.995)).qty], [1, 400]);
  // Pennies: 0.0408 → 0.0412; 400 / 0.0412 = 9708.7
  assert.deepEqual([planOrder(cfg(), input(0.0408)).limit, planOrder(cfg(), input(0.0408)).qty], [0.0412, 9708]);
  // Under a penny: 0.0051 → 0.0052 (the tick is a big step there); 400 / 0.0052 = 76923.08
  const subPenny = planOrder(cfg(), input(0.0051));
  assert.deepEqual([subPenny.limit, subPenny.qty], [0.0052, 76923]);
  assert.ok(subPenny.qty * subPenny.limit <= 400);
  // The smallest prices (a bracket's exits cannot be told apart from the buy there, so none here):
  // 0.0002 → 0.0002; 400 / 0.0002 = 2,000,000
  assert.equal(planOrder(cfg({ takeProfitPct: 0, stopPct: 0 }), input(0.0002)).qty, 2_000_000);
});

test("sizing: the order never costs more than the amount, and a division that comes out even is not rounded away", () => {
  // 350 / 0.56 is 624.9999999999999 in binary floating point, and 350 / 0.14 is 2499.9999999999995:
  // they are 625 and 2500 shares, costing the $350 exactly.
  assert.equal(Math.floor(350 / 0.56), 624);
  const even = planOrder(cfg({ amountUsd: 350, limitOffsetPct: 0 }), input(0.56));
  assert.deepEqual([even.limit, even.qty, even.notional], [0.56, 625, 350]);
  assert.equal(planOrder(cfg({ amountUsd: 350, limitOffsetPct: 0 }), input(0.14)).qty, 2500);
  assert.equal(planOrder(cfg({ amountUsd: 300, limitOffsetPct: 0 }), input(0.1)).qty, 3000);
  assert.equal(planOrder(cfg({ amountUsd: 400, limitOffsetPct: 0 }), input(0.8)).qty, 500);
  assert.equal(planOrder(cfg({ amountUsd: 412.5, limitOffsetPct: 0 }), input(1.65)).qty, 250);

  for (const alert of [0.0037, 0.0412, 0.2999, 0.9999, 1, 1.07, 2.5, 3.333, 17.77, 99.99, 250, 396]) {
    for (const amountUsd of [50, 400, 999.99]) {
      let plan;
      try {
        plan = planOrder(cfg({ amountUsd }), input(alert));
      } catch (err) {
        assert.ok(err instanceof BridgeError && err.code === "too_expensive", `${amountUsd} at ${alert}: ${String(err)}`);
        continue;
      }
      assert.ok(Number.isInteger(plan.qty) && plan.qty >= 1, `${amountUsd} at ${alert}`);
      assert.ok(plan.qty * plan.limit <= amountUsd + 1e-9, `${amountUsd} at ${alert}: ${plan.qty} × ${plan.limit}`);
      assert.ok((plan.qty + 1) * plan.limit > amountUsd, `${amountUsd} at ${alert}: one more share would still fit`);
    }
  }
});

test("sizing: at least one share; a share that costs more than the amount is refused", () => {
  // 396.04 + 1% = 400.0004 → 400.00: exactly one share.
  const one = planOrder(cfg(), input(396.04));
  assert.deepEqual([one.limit, one.qty, one.notional], [400, 1, 400]);
  // 396.05 + 1% → 400.01: one cent too much.
  assert.throws(
    () => planOrder(cfg(), input(396.05)),
    (err: unknown) =>
      err instanceof BridgeError &&
      err.status === 422 &&
      err.code === "too_expensive" &&
      /^one share at 400\.01 costs more than the \$400 of an order \(amountUsd\)$/.test(err.message),
  );
  assert.throws(() => planOrder(cfg({ amountUsd: 0.5 }), input(0.98)), (err: unknown) => err instanceof BridgeError && err.code === "too_expensive");
  assert.equal(formatUsd(400), "$400");
  assert.equal(formatUsd(412.5), "$412.50");
});

test("sizing: a quantity the click names wins; with amountUsd 0 it is order.qty shares as before", () => {
  const named = planOrder(cfg(), input(2.5, { qty: 25 }));
  assert.deepEqual([named.qty, named.sizing, named.notional], [25, { mode: "shares" }, 63.25]);
  const off = planOrder(cfg({ amountUsd: 0 }), input(2.5));
  assert.deepEqual([off.qty, off.sizing], [100, { mode: "shares" }]);
  // order.qty plays no part while amountUsd is on.
  assert.equal(planOrder(cfg({ qty: 7 }), input(2.5)).qty, 158);
});

test('sizing: with priceFrom "ask" the shares are worked out at the limit above the ask', () => {
  const plan = planOrder(cfg({ priceFrom: "ask" }), input(2.6, { ask: 2.62 }));
  assert.deepEqual([plan.limit, plan.qty], [2.65, 150]); // 400 / 2.65 = 150.9
});

// ------------------------------------------------- preview, order, orders

test("sizing: /preview, /order and /orders carry the quantity and how it was arrived at", async (t) => {
  const r = await rig(t, { config: USD });
  assert.equal(r.bridge.status().order.amountUsd, 400);

  const preview = await r.bridge.preview(buy());
  assert.deepEqual(
    { ...preview, checks: preview.checks.map((check) => check.name) },
    {
      ticker: "ABCD",
      entry: "now",
      qty: 158,
      sizing: { mode: "usd", amount_usd: 400 },
      limit: 2.53,
      trigger: null,
      good_until: null,
      take_profit: 2.78,
      stop: 2.4,
      stop_limit: 2.37,
      notional: 399.74,
      price_from: "alert",
      note: null,
      // The same checks in the same order as an order sized in shares.
      checks: ["switches", "account", "shares", "daily", "duplicate", "contract", "limit", "take_profit", "stop", "notional"],
    },
  );
  assert.equal(preview.checks.find((check) => check.name === "shares")?.detail, "158 of 500 allowed ($400 at 2.53)");
  assert.equal(preview.checks.find((check) => check.name === "notional")?.detail, "$399.74 of $1000 allowed");

  const order = await r.bridge.order(buy());
  assert.deepEqual([order.qty, order.sizing, order.limit], [158, { mode: "usd", amount_usd: 400 }, 2.53]);
  assert.deepEqual(r.world.allPlaced().map((p) => [p.id, p.order.totalQuantity]), [
    [1000, 158],
    [1001, 158],
    [1002, 158],
  ]);
  const record = r.bridge.orders()[0];
  assert.deepEqual([record?.sent.qty, record?.sizing, record?.asked.qty], [158, { mode: "usd", amount_usd: 400 }, null]);
  assert.deepEqual(r.journal.ofType("order_placed")[0]?.["sizing"], { mode: "usd", amount_usd: 400 });
  assert.match(r.said.at(-1) ?? "", /^order 1000 ABCD: buy 158 @ 2\.53 \(\$400\), take-profit/);
});

test("sizing: a quantity in the click overrides the amount, and is then held to the share rail as before", async (t) => {
  const r = await rig(t, { config: USD });
  const preview = await r.bridge.preview(buy({ qty: 30 }));
  assert.deepEqual([preview.qty, preview.sizing, preview.notional], [30, { mode: "shares" }, 75.9]);
  assert.equal(preview.checks.find((check) => check.name === "shares")?.detail, "30 of 500 allowed");
  await refuses(r.bridge.order(buy({ qty: 501 })), 422, "too_many_shares", /^501 shares is above maxShares \(500\)$/);

  const order = await r.bridge.order(buy({ qty: 30 }));
  assert.deepEqual([order.qty, order.sizing], [30, { mode: "shares" }]);
  assert.deepEqual([r.bridge.orders()[0]?.sizing, r.bridge.orders()[0]?.asked.qty], [{ mode: "shares" }, 30]);
});

test("sizing: maxShares still holds, and the refusal names the amount", async (t) => {
  const r = await rig(t, { config: USD });
  // 0.0408 → 0.0412; $400 buys 9,708 of them.
  await refuses(
    r.bridge.order(buy({ ticker: "PENY", alert_price: 0.0408 })),
    422,
    "too_many_shares",
    /^\$400 at 0\.0412 is 9,708 shares, above maxShares \(500\)$/,
  );
  await refuses(r.bridge.preview(buy({ ticker: "PENY", alert_price: 0.0408 })), 422, "too_many_shares", /\$400 at 0\.0412 is 9,708 shares/);
  // 0.78 → 0.7878: 507 shares; 0.80 → 0.808: 495.
  await refuses(r.bridge.preview(buy({ alert_price: 0.78 })), 422, "too_many_shares", /^\$400 at 0\.7878 is 507 shares, above maxShares \(500\)$/);
  assert.equal((await r.bridge.preview(buy({ alert_price: 0.8 }))).qty, 495);
  assert.deepEqual(r.world.allPlaced(), []);

  // With room in maxShares the penny order goes, for 9,708 shares.
  const roomy = await rig(t, { config: (c) => (USD(c), (c.limits.maxShares = 20_000)) });
  const order = await roomy.bridge.order(buy({ ticker: "PENY", alert_price: 0.0408 }));
  assert.deepEqual([order.qty, order.limit], [9708, 0.0412]);
  assert.deepEqual(roomy.world.allPlaced().map((p) => p.order.totalQuantity), [9708, 9708, 9708]);
  assert.equal(roomy.bridge.orders()[0]?.sent.qty, 9708);
});

test("sizing: maxNotionalUsd still holds for an order sized in dollars", async (t) => {
  // config.json cannot say this (amountUsd above maxNotionalUsd is refused at the start); the rail is there all the same.
  const r = await rig(t, { config: (c) => ((c.order.amountUsd = 1500), (c.limits.maxShares = 1000)) });
  await refuses(
    r.bridge.order(buy()),
    422,
    "too_large",
    /^the order is \$1497\.76 \(592 × 2\.53, sized from \$1500\), above maxNotionalUsd \(\$1000\)$/,
  );
  assert.deepEqual(r.world.allPlaced(), []);

  // The amount at the limit exactly: 1000 / 2.50 = 400 shares, $1000.00 of $1000 allowed.
  const edge = await rig(t, { config: (c) => ((c.order.amountUsd = 1000), (c.order.limitOffsetPct = 0)) });
  const preview = await edge.bridge.preview(buy());
  assert.deepEqual([preview.qty, preview.notional], [400, 1000]);
});

test("sizing: a share dearer than the amount is refused with a plain text, and nothing is sent", async (t) => {
  const r = await rig(t, { config: USD });
  await refuses(
    r.bridge.order(buy({ alert_price: 505 })),
    422,
    "too_expensive",
    /^one share at 510\.05 costs more than the \$400 of an order \(amountUsd\)$/,
  );
  await refuses(r.bridge.preview(buy({ alert_price: 505 })), 422, "too_expensive");
  assert.deepEqual(r.world.allPlaced(), []);
  assert.deepEqual(r.bridge.orders(), []);
  // A refused order does not start the duplicate window or count for the day.
  assert.equal((await r.bridge.order(buy())).qty, 158);
});

test("sizing: a chase keeps the order's quantity, though each share now costs more", async (t) => {
  const r = await rig(t, { config: USD, world: (w) => w.asks.set("ABCD", 2.54) });
  const ib = await working(r);
  assert.equal(r.bridge.orders()[0]?.sent.qty, 158);

  const result = await r.bridge.chase({ order_id: 1000 });
  assert.equal(result.limit, 2.57);
  // 158 × 2.57 = 406.06: more than the $400, by the chase and no more. No share was added.
  assert.deepEqual(ib.modified().map((s) => [s.id, s.order.totalQuantity]), [
    [1000, 158],
    [1001, 158],
    [1002, 158],
  ]);
  assert.deepEqual([r.bridge.orders()[0]?.sent.qty, r.bridge.orders()[0]?.sizing], [158, { mode: "usd", amount_usd: 400 }]);
});

test("sizing: it survives a restart with the order", async (t) => {
  const dir = tempDir(t, "sizing");
  const a = await rig(t, { config: USD, journal: new FileJournal(dir, () => T0, [TOKEN]) });
  await a.bridge.order(buy());
  const before = a.bridge.orders();
  a.link.stop();
  const b = await rig(t, { config: USD, journal: new FileJournal(dir, () => T0 + 5000, [TOKEN]), now: T0 + 5000 });
  assert.deepEqual(b.bridge.orders(), before);
  assert.deepEqual(b.bridge.orders()[0]?.sizing, { mode: "usd", amount_usd: 400 });
});

// ---------------------------------------------------------- no live ask

const FROM_ASK = (c: Config): void => void (c.order.priceFrom = "ask");

test('ask fallback "alert" (the default): with no ask in time the buy is priced from the alert, and says so', async (t) => {
  const r = await rig(t, { config: FROM_ASK });
  assert.equal(r.bridge.status().order.askFallback, "alert");

  const preview = await r.bridge.preview(buy());
  assert.deepEqual(
    [preview.limit, preview.take_profit, preview.stop, preview.price_from, preview.note],
    [2.53, 2.78, 2.4, "alert", "no live ask from TWS in 40 ms: priced from the alert"],
  );
  assert.match(
    preview.checks.find((check) => check.name === "limit")?.detail ?? "",
    /^2\.53 = the alert's price 2\.50 \+ 1%; 1\.2% past the alert \(max 3%\) \(no live ask from TWS in 40 ms: priced from the alert\)$/,
  );
  assert.deepEqual(r.world.allPlaced(), []);

  const order = await r.bridge.order(buy({ alert_stop: 2.42 }));
  assert.deepEqual(order, {
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
    note: "no live ask from TWS in 40 ms: priced from the alert",
    status: "PendingSubmit",
  });
  assert.equal(r.world.allPlaced().length, 3);
  assert.equal(r.world.allPlaced()[0]?.order.lmtPrice, 2.53);
  // /orders and the log say it too.
  const record = r.bridge.orders()[0];
  assert.deepEqual([record?.sent.price_from, record?.note], ["alert", "no live ask from TWS in 40 ms: priced from the alert"]);
  const line = r.journal.ofType("order_placed")[0] as Record<string, any>;
  assert.deepEqual([line["sent"].price_from, line["note"]], ["alert", "no live ask from TWS in 40 ms: priced from the alert"]);
  assert.match(r.said.at(-1) ?? "", /\(no live ask from TWS in 40 ms: priced from the alert\)$/);
  // One snapshot was asked for per call, and given up on.
  assert.equal(r.world.current.callsOf("reqMktData").length, 2);
});

test('ask fallback "alert": TWS refusing the snapshot is "no live ask" too', async (t) => {
  const r = await rig(t, { config: FROM_ASK });
  const pending = r.bridge.order(buy());
  await until(() => r.world.current.callsOf("reqMktData").length === 1, "the snapshot");
  r.world.current.emit("error", new Error("Requested market data is not subscribed"), 354, r.world.current.callsOf("reqMktData")[0]?.args[0]);
  const order = await pending;
  assert.deepEqual(
    [order.limit, order.price_from, order.note],
    [2.53, "alert", "TWS gave no ask for ABCD: Requested market data is not subscribed (code 354): priced from the alert"],
  );
  assert.equal(r.world.allPlaced().length, 3);
});

test('ask fallback "alert": with a live ask nothing falls back', async (t) => {
  const r = await rig(t, { config: FROM_ASK, world: (w) => w.asks.set("ABCD", 2.52) });
  const preview = await r.bridge.preview(buy());
  assert.deepEqual([preview.limit, preview.price_from, preview.note], [2.55, "ask", null]);
  const order = await r.bridge.order(buy());
  assert.deepEqual([order.limit, order.price_from, order.note], [2.55, "ask", null]);
  assert.deepEqual([r.bridge.orders()[0]?.sent.price_from, r.bridge.orders()[0]?.note], ["ask", null]);
  // A live ask that has run too far is a refusal, not a reason to use the alert's price instead.
  r.world.asks.set("WXYZ", 2.6);
  await refuses(r.bridge.order(buy({ ticker: "WXYZ" })), 422, "chase");
  assert.equal(r.world.allPlaced().length, 3);
});

test('ask fallback "alert": the fallback price is held to every rail of an alert-priced order', async (t) => {
  // With priceFrom "ask" the offset may be above maxChasePct (it is measured from the ask); from the alert it is chasing.
  const r = await rig(t, { config: (c) => (FROM_ASK(c), (c.order.limitOffsetPct = 4)) });
  await refuses(r.bridge.order(buy()), 422, "chase", /^price has run 4\.0% past the alert/);
  assert.deepEqual(r.world.allPlaced(), []);

  // Sized in dollars, the shares come from the fallback limit.
  const usd = await rig(t, { config: (c) => (FROM_ASK(c), USD(c)) });
  const order = await usd.bridge.order(buy());
  assert.deepEqual([order.qty, order.limit, order.price_from], [158, 2.53, "alert"]);
});

test('ask fallback "none": no live ask is no order, as before', async (t) => {
  const r = await rig(t, { config: (c) => (FROM_ASK(c), (c.order.askFallback = "none")) });
  await refuses(r.bridge.order(buy()), 504, "no_ask", /^no ask for ABCD from TWS within 40 ms$/);
  await refuses(r.bridge.preview(buy()), 504, "no_ask");

  const pending = r.bridge.order(buy());
  await until(() => r.world.current.callsOf("reqMktData").length === 3, "the third snapshot");
  r.world.current.emit("error", new Error("Requested market data is not subscribed"), 354, r.world.current.callsOf("reqMktData")[2]?.args[0]);
  await refuses(pending, 502, "no_ask", /^TWS gave no ask for ABCD: Requested market data is not subscribed \(code 354\)$/);
  assert.deepEqual(r.world.allPlaced(), []);
  assert.deepEqual(r.bridge.orders(), []);
});

test("ask fallback: TWS going away while the ask is read is not a reason to price from the alert", async (t) => {
  const r = await rig(t, { config: FROM_ASK });
  const pending = r.bridge.order(buy());
  await until(() => r.world.current.callsOf("reqMktData").length === 1, "the snapshot");
  r.world.mode = "refuse";
  r.world.drop();
  await refuses(pending, 503, "tws_down");
  assert.deepEqual(r.world.allPlaced(), []);
});

test('ask fallback: priceFrom "alert" never asks TWS for a price, whatever the setting', async (t) => {
  for (const askFallback of ["alert", "none"] as const) {
    const r = await rig(t, { config: (c) => (c.order.askFallback = askFallback) });
    const order = await r.bridge.order(buy());
    assert.deepEqual([order.price_from, order.note], ["alert", null]);
    assert.deepEqual(r.world.current.callsOf("reqMktData"), []);
  }
});
