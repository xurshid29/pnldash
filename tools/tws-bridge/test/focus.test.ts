import assert from "node:assert/strict";
import { test } from "node:test";
import { SecType } from "@stoqey/ib";
import { pickContract } from "../src/bridge.js";
import { BridgeError } from "../src/errors.js";
import { listing, until } from "./fake-tws.js";
import { buy, refuses, rig } from "./harness.js";

// ------------------------------------------------------------------ focus

test("focus: subscribes to the display group once, then updates it with <conid>@SMART", async (t) => {
  const r = await rig(t);
  assert.deepEqual(await r.bridge.focus({ ticker: "abcd" }), { ticker: "ABCD", conid: 111, group: 1 });
  assert.deepEqual(await r.bridge.focus({ ticker: "WXYZ" }), { ticker: "WXYZ", conid: 222, group: 1 });
  assert.deepEqual(await r.bridge.focus({ ticker: "ABCD" }), { ticker: "ABCD", conid: 111, group: 1 });

  const ib = r.world.current;
  const subscriptions = ib.callsOf("subscribeToGroupEvents");
  assert.equal(subscriptions.length, 1);
  const reqId = subscriptions[0]?.args[0];
  assert.deepEqual(subscriptions[0]?.args, [reqId, 1]);
  assert.deepEqual(
    ib.callsOf("updateDisplayGroup").map((call) => call.args),
    [
      [reqId, "111@SMART"],
      [reqId, "222@SMART"],
      [reqId, "111@SMART"],
    ],
  );
  // The subscription comes before the first update.
  const names = ib.calls.map((call) => call.name).filter((name) => name.includes("Group"));
  assert.deepEqual(names.slice(0, 3), ["queryDisplayGroups", "subscribeToGroupEvents", "updateDisplayGroup"]);

  // The contract id is looked up once per ticker and remembered.
  assert.equal(ib.callsOf("reqContractDetails").length, 2);
  assert.deepEqual(ib.callsOf("reqContractDetails")[0]?.args[1], {
    symbol: "ABCD",
    secType: "STK",
    exchange: "SMART",
    currency: "USD",
  });
  // Focus places nothing.
  assert.deepEqual(r.world.allPlaced(), []);
  assert.deepEqual(r.journal.ofType("focus")[0], { type: "focus", ticker: "ABCD", conid: 111, group: 1 });
});

test("focus: the configured display group is the one used", async (t) => {
  const r = await rig(t, { config: (c) => (c.displayGroup = 3) });
  assert.deepEqual(await r.bridge.focus({ ticker: "ABCD" }), { ticker: "ABCD", conid: 111, group: 3 });
  const [subscription] = r.world.current.callsOf("subscribeToGroupEvents");
  assert.equal(subscription?.args[1], 3);
});

test("focus: a new connection subscribes again, once", async (t) => {
  const r = await rig(t);
  await r.bridge.focus({ ticker: "ABCD" });
  r.world.drop();
  await until(() => r.link.isReady(), "ready again");
  await r.bridge.focus({ ticker: "ABCD" });
  await r.bridge.focus({ ticker: "WXYZ" });

  const [first, second] = r.world.instances;
  assert.equal(first?.callsOf("subscribeToGroupEvents").length, 1);
  assert.equal(second?.callsOf("subscribeToGroupEvents").length, 1);
  assert.equal(second?.callsOf("updateDisplayGroup").length, 2);
  // ABCD's contract id was remembered across the reconnect.
  assert.equal(second?.callsOf("reqContractDetails").length, 1);
});

test("focus: allowed when orders are disabled, halted, or the account is live", async (t) => {
  const r = await rig(t, {
    config: (c) => {
      c.enabled = false;
      c.halted = true;
    },
    world: (w) => (w.accounts = "U7654321"),
  });
  assert.deepEqual(await r.bridge.focus({ ticker: "ABCD" }), { ticker: "ABCD", conid: 111, group: 1 });
  assert.equal(r.world.current.callsOf("updateDisplayGroup").length, 1);
  await refuses(r.bridge.order(buy()), 409, "disabled");
});

test("focus: only a ticker is accepted; an unknown one is 404", async (t) => {
  const r = await rig(t);
  await refuses(r.bridge.focus({ ticker: "ABCD", group: 2 }), 400, "bad_request", /unknown field "group"/);
  await refuses(r.bridge.focus({}), 400, "bad_request", /ticker/);
  await refuses(r.bridge.focus(null), 400, "bad_request");
  await refuses(r.bridge.focus({ ticker: "NOPE" }), 404, "unknown_ticker", /^TWS knows no US stock NOPE$/);
  assert.deepEqual(r.world.current.callsOf("updateDisplayGroup"), []);
});

test("focus: a TWS that does not answer the lookup is a 504, and the next try asks again", async (t) => {
  const r = await rig(t, { contractTimeoutMs: 60 });
  r.world.silentLookups = true;
  await refuses(r.bridge.focus({ ticker: "ABCD" }), 504, "tws_timeout", /did not answer the contract lookup within 60 ms/);
  r.world.silentLookups = false;
  assert.equal((await r.bridge.focus({ ticker: "ABCD" })).conid, 111);
  assert.equal(r.world.current.callsOf("reqContractDetails").length, 2);
});

// ------------------------------------------------- contract disambiguation

function refusal(status: number, code: string, message?: RegExp): (err: unknown) => boolean {
  return (err) => {
    assert.ok(err instanceof BridgeError);
    assert.equal(err.status, status);
    assert.equal(err.code, code);
    if (message !== undefined) assert.match(err.message, message);
    return true;
  };
}

test("contract: a single listing is taken as it is", () => {
  assert.deepEqual(pickContract("ABCD", "ABCD", [listing("ABCD", 111, "NASDAQ")]), {
    conid: 111,
    symbol: "ABCD",
    primaryExch: "NASDAQ",
  });
  // Also when its primary exchange is not one of the five.
  assert.equal(pickContract("OTCQ", "OTCQ", [listing("OTCQ", 9, "PINK")]).conid, 9);
  // TWS repeating the same contract is still one listing.
  assert.equal(pickContract("ABCD", "ABCD", [listing("ABCD", 111, "NASDAQ"), listing("ABCD", 111, "NASDAQ")]).conid, 111);
});

test("contract: among several listings the one on a US primary exchange wins", () => {
  for (const exchange of ["NASDAQ", "NYSE", "AMEX", "ARCA", "BATS"]) {
    const picked = pickContract("DUAL", "DUAL", [listing("DUAL", 900, "VENTURE"), listing("DUAL", 901, exchange), listing("DUAL", 902, "LSE")]);
    assert.deepEqual(picked, { conid: 901, symbol: "DUAL", primaryExch: exchange });
  }
});

test("contract: still ambiguous is an error, never a guess", () => {
  assert.throws(
    () => pickContract("DUAL", "DUAL", [listing("DUAL", 900, "NASDAQ"), listing("DUAL", 901, "NYSE")]),
    refusal(409, "ambiguous_ticker", /^DUAL is ambiguous in TWS: 2 listings \(900 on NASDAQ, 901 on NYSE\), 2 of them on a US primary exchange$/),
  );
  assert.throws(
    () => pickContract("DUAL", "DUAL", [listing("DUAL", 900, "VENTURE"), listing("DUAL", 902, "LSE")]),
    refusal(409, "ambiguous_ticker", /none of them on a US primary exchange/),
  );
});

test("contract: no listing, or only things that are not a US-dollar stock, is 404", () => {
  assert.throws(() => pickContract("NOPE", "NOPE", []), refusal(404, "unknown_ticker"));
  assert.throws(() => pickContract("EURO", "EURO", [listing("EURO", 5, "IBIS", "EUR")]), refusal(404, "unknown_ticker"));
  const option = listing("ABCD", 6, "NASDAQ");
  option.contract.secType = SecType.OPT;
  assert.throws(() => pickContract("ABCD", "ABCD", [option]), refusal(404, "unknown_ticker"));
  // A non-dollar line next to the dollar one does not make it ambiguous.
  assert.equal(pickContract("DUAL", "DUAL", [listing("DUAL", 5, "IBIS", "EUR"), listing("DUAL", 7, "NYSE")]).conid, 7);
});

test("contract: the bridge orders the listing it picked, and refuses an ambiguous ticker", async (t) => {
  const r = await rig(t, {
    world: (w) => {
      w.contracts.set("DUAL", [listing("DUAL", 900, "VENTURE"), listing("DUAL", 901, "NASDAQ")]);
      w.contracts.set("TWIN", [listing("TWIN", 800, "NASDAQ"), listing("TWIN", 801, "NYSE")]);
    },
  });
  assert.equal((await r.bridge.focus({ ticker: "DUAL" })).conid, 901);
  await r.bridge.order(buy({ ticker: "DUAL" }));
  assert.deepEqual(r.world.allPlaced().map((p) => p.contract.conId), [901, 901, 901]);

  await refuses(r.bridge.focus({ ticker: "TWIN" }), 409, "ambiguous_ticker");
  await refuses(r.bridge.order(buy({ ticker: "TWIN" })), 409, "ambiguous_ticker");
  await refuses(r.bridge.preview(buy({ ticker: "TWIN" })), 409, "ambiguous_ticker");
  assert.equal(r.world.allPlaced().length, 3);
});
