import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultConfig } from "../src/config.js";
import type { OrderConfig } from "../src/config.js";
import { BridgeError } from "../src/errors.js";
import { buildBracket, planOrder, roundDown, roundNearest } from "../src/order.js";
import type { PlanInput } from "../src/order.js";

function cfg(overrides: Partial<OrderConfig> = {}): OrderConfig {
  return { ...defaultConfig("x").order, ...overrides };
}

function input(alertPrice: number, overrides: Partial<PlanInput> = {}): PlanInput {
  return { qty: 100, alertPrice, alertStop: null, ask: null, ...overrides };
}

function refusal(code: string, message?: RegExp): (err: unknown) => boolean {
  return (err) => {
    assert.ok(err instanceof BridgeError);
    assert.equal(err.code, code);
    assert.equal(err.status, 422);
    if (message !== undefined) assert.match(err.message, message);
    return true;
  };
}

test("rounding: cents from $1 up, hundredths of a cent below, without float drift", () => {
  assert.equal(roundDown(1.15), 1.15); // 1.15 * 100 is 114.99999999999999
  assert.equal(roundDown(0.3), 0.3);
  assert.equal(roundDown(2.4099), 2.4);
  assert.equal(roundDown(123.456), 123.45);
  assert.equal(roundDown(0.99999), 0.9999);
  assert.equal(roundDown(1.0049), 1);
  assert.equal(roundNearest(1.005), 1.01); // half a tick goes up
  assert.equal(roundNearest(1.0049), 1);
  assert.equal(roundNearest(0.123449), 0.1234);
  assert.equal(roundNearest(0.12345), 0.1235);
  assert.equal(roundNearest(0.99996), 1); // a sub-dollar price may round onto $1
  assert.equal(roundNearest(2.525), 2.53);
});

test("plan: the default bracket from an alert at $2.50", () => {
  const plan = planOrder(cfg(), input(2.5));
  assert.equal(plan.limit, 2.53); // 2.50 + 1% = 2.525, nearest cent
  assert.equal(plan.takeProfit, 2.78); // 2.53 + 10% = 2.783, nearest cent
  assert.equal(plan.stop, 2.4); // 2.53 - 5% = 2.4035, down
  assert.equal(plan.stopLimit, 2.37); // 2.40 - 1% = 2.376, down
  assert.equal(plan.notional, 253);
  assert.equal(plan.qty, 100);
  assert.equal(plan.priceFrom, "alert");
  assert.equal(plan.stopFrom, "pct");
  assert.equal(plan.alertStopIgnored, null);
  assert.ok(Math.abs(plan.chasePct - 1.2) < 1e-9);
});

test("plan: every price on cents when all of them are above $1", () => {
  const plan = planOrder(cfg(), input(1.1));
  assert.deepEqual([plan.limit, plan.takeProfit, plan.stop, plan.stopLimit], [1.11, 1.22, 1.05, 1.03]);
});

test("plan: below $1 every price is on a $0.0001 tick", () => {
  const plan = planOrder(cfg(), input(0.5));
  assert.equal(plan.limit, 0.505);
  assert.equal(plan.takeProfit, 0.5555);
  assert.equal(plan.stop, 0.4797); // 0.479750, down
  assert.equal(plan.stopLimit, 0.4749); // 0.474903, down
  assert.equal(plan.notional, 50.5);
});

test("plan: each price takes the tick of its own side of $1", () => {
  // The buy is under $1, its take-profit lands above $1.
  const under = planOrder(cfg(), input(0.95));
  assert.equal(under.limit, 0.9595);
  assert.equal(under.takeProfit, 1.06); // 1.05545 → cents
  assert.equal(under.stop, 0.9115);
  assert.equal(under.stopLimit, 0.9023);

  // The buy is above $1, its stop lands under $1.
  const over = planOrder(cfg(), input(1.0));
  assert.equal(over.limit, 1.01);
  assert.equal(over.takeProfit, 1.11);
  assert.equal(over.stop, 0.9595); // hundredths of a cent
  assert.equal(over.stopLimit, 0.9499);
});

test("plan: the alert's stop is used when it is below the limit and within 3 × stopPct", () => {
  const plan = planOrder(cfg(), input(2.5, { alertStop: 2.42 }));
  assert.equal(plan.limit, 2.53);
  assert.equal(plan.stop, 2.42);
  assert.equal(plan.stopFrom, "alert");
  assert.equal(plan.stopLimit, 2.39); // 2.42 - 1% = 2.3958, down
  assert.equal(plan.alertStopIgnored, null);

  // It is rounded down to the tick like any stop.
  const rounded = planOrder(cfg(), input(2.5, { alertStop: 2.4199 }));
  assert.equal(rounded.stop, 2.41);
  assert.equal(rounded.stopLimit, 2.38);
});

test("plan: the alert's stop is ignored when it is too far, not below the limit, or switched off", () => {
  const tooFar = planOrder(cfg(), input(2.5, { alertStop: 2.0 })); // 20.9% under 2.53; the cap is 15%
  assert.equal(tooFar.stop, 2.4);
  assert.equal(tooFar.stopFrom, "pct");
  assert.match(tooFar.alertStopIgnored ?? "", /more than 3 × stopPct/);

  // The edge: 15% under 2.53 is 2.1505.
  assert.equal(planOrder(cfg(), input(2.5, { alertStop: 2.16 })).stopFrom, "alert");
  assert.equal(planOrder(cfg(), input(2.5, { alertStop: 2.15 })).stopFrom, "pct");

  for (const alertStop of [2.53, 2.6]) {
    const above = planOrder(cfg(), input(2.5, { alertStop }));
    assert.equal(above.stop, 2.4);
    assert.equal(above.stopFrom, "pct");
    assert.match(above.alertStopIgnored ?? "", /not below the limit/);
  }

  const off = planOrder(cfg({ useAlertStop: false }), input(2.5, { alertStop: 2.42 }));
  assert.equal(off.stop, 2.4);
  assert.equal(off.stopFrom, "pct");
  assert.match(off.alertStopIgnored ?? "", /useAlertStop is off/);
});

test("plan: legs switched off in the config are absent", () => {
  const noTakeProfit = planOrder(cfg({ takeProfitPct: 0 }), input(2.5));
  assert.equal(noTakeProfit.takeProfit, null);
  assert.equal(noTakeProfit.stop, 2.4);

  const noStop = planOrder(cfg({ stopPct: 0 }), input(2.5));
  assert.equal(noStop.stop, null);
  assert.equal(noStop.stopLimit, null);
  assert.equal(noStop.stopFrom, null);

  // With stopPct 0 the alert's stop has no allowance either (3 × 0%).
  const noStopWithAlertStop = planOrder(cfg({ stopPct: 0 }), input(2.5, { alertStop: 2.42 }));
  assert.equal(noStopWithAlertStop.stop, null);
  assert.match(noStopWithAlertStop.alertStopIgnored ?? "", /3 × stopPct/);
});

test('plan: priceFrom "ask" starts from the ask and refuses to chase', () => {
  const ask = cfg({ priceFrom: "ask" });

  const ok = planOrder(ask, input(2.5, { ask: 2.52 }));
  assert.equal(ok.limit, 2.55); // 2.52 + 1% = 2.5452
  assert.equal(ok.basePrice, 2.52);
  assert.equal(ok.takeProfit, 2.81); // 2.55 + 10% = 2.805, nearest
  assert.equal(ok.stop, 2.42); // 2.55 - 5% = 2.4225, down

  const below = planOrder(ask, input(2.5, { ask: 2.4 }));
  assert.equal(below.limit, 2.42);
  assert.ok(below.chasePct < 0);

  // Exactly maxChasePct above the alert is still allowed: "more than" is the rule.
  assert.equal(planOrder(ask, input(2.0, { ask: 2.04 })).limit, 2.06);

  assert.throws(() => planOrder(ask, input(2.5, { ask: 2.6 })), refusal("chase", /^price has run 5\.2% past the alert/));
  assert.throws(() => planOrder(ask, input(2.5, { ask: null })), refusal("no_ask"));
  assert.throws(() => planOrder(ask, input(2.5, { ask: 0 })), refusal("no_ask"));
});

test("plan: after rounding, stop < limit < take-profit must still hold", () => {
  // At $0.0001 the take-profit rounds back onto the limit.
  assert.throws(() => planOrder(cfg(), input(0.0001)), refusal("bad_prices", /take-profit .* is not above the limit/));
  // At $0.0002 the stop is one tick under the limit and its own limit rounds to zero.
  assert.throws(() => planOrder(cfg({ takeProfitPct: 0 }), input(0.0002)), refusal("bad_prices", /stop's own limit/));
});

test("bracket: three legs, consecutive ids, only the last one transmits", () => {
  const plan = planOrder(cfg(), input(2.5));
  const legs = buildBracket(plan, 1000, true);
  assert.deepEqual(
    legs.map((leg) => [leg.leg, leg.orderId]),
    [
      ["parent", 1000],
      ["take_profit", 1001],
      ["stop", 1002],
    ],
  );
  const [parent, takeProfit, stop] = legs.map((leg) => leg.order);
  assert.deepEqual(parent, {
    action: "BUY",
    orderType: "LMT",
    totalQuantity: 100,
    lmtPrice: 2.53,
    tif: "DAY",
    outsideRth: true,
    parentId: 0,
    transmit: false,
  });
  assert.deepEqual(takeProfit, {
    action: "SELL",
    orderType: "LMT",
    totalQuantity: 100,
    lmtPrice: 2.78,
    tif: "GTC",
    outsideRth: true,
    parentId: 1000,
    transmit: false,
  });
  assert.deepEqual(stop, {
    action: "SELL",
    orderType: "STP LMT",
    totalQuantity: 100,
    auxPrice: 2.4,
    lmtPrice: 2.37,
    tif: "GTC",
    outsideRth: true,
    parentId: 1000,
    transmit: true,
  });
});

test("bracket: outsideRth follows the config on every leg", () => {
  const plan = planOrder(cfg(), input(2.5));
  assert.deepEqual(buildBracket(plan, 5, false).map((leg) => leg.order.outsideRth), [false, false, false]);
  assert.deepEqual(buildBracket(plan, 5, true).map((leg) => leg.order.outsideRth), [true, true, true]);
});

test("bracket: with a leg switched off, the last leg left transmits and ids keep their slots", () => {
  const noTakeProfit = buildBracket(planOrder(cfg({ takeProfitPct: 0 }), input(2.5)), 40, true);
  assert.deepEqual(
    noTakeProfit.map((leg) => [leg.leg, leg.orderId, leg.order.transmit, leg.order.parentId]),
    [
      ["parent", 40, false, 0],
      ["stop", 42, true, 40],
    ],
  );

  const noStop = buildBracket(planOrder(cfg({ stopPct: 0 }), input(2.5)), 40, true);
  assert.deepEqual(
    noStop.map((leg) => [leg.leg, leg.orderId, leg.order.transmit, leg.order.parentId]),
    [
      ["parent", 40, false, 0],
      ["take_profit", 41, true, 40],
    ],
  );

  const alone = buildBracket(planOrder(cfg({ takeProfitPct: 0, stopPct: 0 }), input(2.5)), 40, true);
  assert.deepEqual(
    alone.map((leg) => [leg.leg, leg.orderId, leg.order.transmit]),
    [["parent", 40, true]],
  );
});

test("bracket: the stop from an alert goes out as the stop price, its limit under it", () => {
  const plan = planOrder(cfg(), input(2.5, { alertStop: 2.42 }));
  const stop = buildBracket(plan, 7, true)[2]?.order;
  assert.equal(stop?.auxPrice, 2.42);
  assert.equal(stop?.lmtPrice, 2.39);
  assert.equal(stop?.orderType, "STP LMT");
});
