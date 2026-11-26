import assert from "node:assert/strict";
import { test } from "node:test";
import { SecType } from "@stoqey/ib";
import { tickerOfConid } from "../src/bridge.js";
import { describeDisplayGroups, parseContractInfo } from "../src/groups.js";
import type { GroupReading } from "../src/groups.js";
import { REQUEST_ID_BASE } from "../src/link.js";
import { listing, sleep, until } from "./fake-tws.js";
import type { FakeTws } from "./fake-tws.js";
import { buy, rig } from "./harness.js";
import type { Rig } from "./harness.js";

// Which TWS display group shows which ticker: said once per connection on the console and kept
// current in /status, so `displayGroup` can be set without guessing.

const LINE = "display groups: 1 nothing · 2 nothing · 4 WHLR ← windows are linked here · 5 nothing";
const HINT = 'displayGroup is 1 but the linked windows look like group 4: set "displayGroup": 4 in config.json and restart';

/** The operator's TWS: four groups, every window linked to group 4, which shows WHLR. */
function whlrInGroup4(world: FakeTws): void {
  world.contracts.set("WHLR", [listing("WHLR", 700, "NASDAQ")]);
  world.groups = "4|1|2|5";
  world.groupShows.set(4, "700@SMART");
}

/** The same, with a TWS that never answers a contract lookup. */
function whlrWithSilentLookups(world: FakeTws): void {
  whlrInGroup4(world);
  world.silentLookups = true;
}

function report(r: Rig): string[] {
  return r.said.filter((line) => line.startsWith("display groups:") || line.startsWith("displayGroup is"));
}

async function reported(r: Rig, times = 1): Promise<void> {
  await until(() => r.said.filter((line) => line.startsWith("display groups:")).length >= times, "the display-group report");
}

/** The contract ids the bridge asked TWS to name on the current connection, in order. */
function lookedUp(r: Rig): Array<number | undefined> {
  return r.world.current.callsOf("reqContractDetails").map((call) => (call.args[1] as { conId?: number }).conId);
}

function shows(r: Rig, id: number): string | null | undefined {
  return r.bridge.status().display_groups.find((group) => group.id === id)?.shows;
}

function group(id: number, what: string | null, answered = true): GroupReading {
  return { id, shows: what, answered };
}

// ------------------------------------------------------------ the wording

test("groups: the console lines for each situation", () => {
  const whlr = [group(1, null), group(2, null), group(4, "WHLR"), group(5, null)];
  // The configured group is empty and one other group is in use: say which, and what to set.
  assert.deepEqual(describeDisplayGroups(1, whlr), [LINE, HINT]);
  // The configured group is the one in use: nothing to add.
  assert.deepEqual(describeDisplayGroups(4, whlr), [LINE]);
  // Given in TWS's own order (most used first), printed by number.
  assert.deepEqual(describeDisplayGroups(4, [whlr[2], whlr[0], whlr[3], whlr[1]] as GroupReading[]), [LINE]);

  // Two groups in use, one of them the configured one: no guess to make.
  assert.deepEqual(describeDisplayGroups(1, [group(1, "AAPL"), group(4, "WHLR")]), ["display groups: 1 AAPL · 4 WHLR"]);
  // The configured group empty and two others in use: it is one of those.
  assert.deepEqual(describeDisplayGroups(1, [group(1, null), group(2, "AAPL"), group(4, "WHLR")]), [
    "display groups: 1 nothing · 2 AAPL · 4 WHLR",
    "displayGroup is 1, which shows nothing: the linked windows are in one of the groups that show a ticker (2, 4)",
  ]);
  // Nothing anywhere: nothing to say beyond the list.
  assert.deepEqual(describeDisplayGroups(1, [group(1, null), group(2, null)]), ["display groups: 1 nothing · 2 nothing"]);

  // A ticker that could not be looked up stays as TWS gave it; a combo is named as one.
  assert.deepEqual(describeDisplayGroups(1, [group(1, null), group(4, "700@SMART")]), [
    "display groups: 1 nothing · 4 700@SMART ← windows are linked here",
    HINT,
  ]);
  assert.deepEqual(describeDisplayGroups(4, [group(1, null), group(4, "combo")]), [
    "display groups: 1 nothing · 4 a combo ← windows are linked here",
  ]);

  // A group that has not answered is not called empty, and no advice rests on it.
  assert.deepEqual(describeDisplayGroups(1, [group(1, null, false), group(4, "WHLR")]), [
    "display groups: 1 no answer · 4 WHLR ← windows are linked here",
  ]);

  // The configured number is not one of TWS's groups.
  assert.deepEqual(describeDisplayGroups(9, [group(1, null), group(4, "WHLR")]), [
    "display groups: 1 nothing · 4 WHLR ← windows are linked here",
    'displayGroup is 9 but TWS lists no such group, and the linked windows look like group 4: set "displayGroup": 4 in config.json and restart',
  ]);
  assert.deepEqual(describeDisplayGroups(9, [group(1, null), group(2, null)]), [
    "display groups: 1 nothing · 2 nothing",
    'displayGroup is 9 but TWS lists no such group: set "displayGroup" to one of the groups above in config.json and restart',
  ]);
  assert.deepEqual(describeDisplayGroups(1, []), [
    "display groups: TWS lists none (displayGroup is 1: /focus may change no window)",
  ]);
});

test("groups: what TWS says a group shows is read as a contract, nothing, a combo, or kept as text", () => {
  assert.deepEqual(parseContractInfo("700@SMART"), { kind: "contract", conid: 700, exchange: "SMART" });
  assert.deepEqual(parseContractInfo(" 265598@NASDAQ "), { kind: "contract", conid: 265598, exchange: "NASDAQ" });
  assert.deepEqual(parseContractInfo("8314"), { kind: "contract", conid: 8314, exchange: "" });
  for (const nothing of ["none", "None", "", "  "]) assert.deepEqual(parseContractInfo(nothing), { kind: "none" });
  assert.deepEqual(parseContractInfo("combo"), { kind: "combo" });
  assert.deepEqual(parseContractInfo("0@SMART"), { kind: "other", text: "0@SMART" });
  assert.deepEqual(parseContractInfo("something else"), { kind: "other", text: "something else" });
});

test("groups: a contract id's name is the stock's ticker, or the local symbol of anything else", () => {
  assert.equal(tickerOfConid(700, [listing("WHLR", 700, "NASDAQ")]), "WHLR");
  assert.equal(tickerOfConid(555, [listing("BRK B", 555, "NYSE")]), "BRK.B"); // the tape's spelling
  assert.equal(tickerOfConid(700, [listing("OTHER", 701, "NASDAQ"), listing("WHLR", 700, "NASDAQ")]), "WHLR");
  assert.equal(
    tickerOfConid(9, [{ contract: { conId: 9, symbol: "AAPL", secType: SecType.OPT, localSymbol: "AAPL  261218C00200000" } }]),
    "AAPL  261218C00200000",
  );
  assert.equal(tickerOfConid(700, []), null);
  assert.equal(tickerOfConid(700, [{ contract: { conId: 700 } }]), null);
});

// -------------------------------------------------- against the fake TWS

test("groups: several groups, one showing a contract: said once, with the group to set", async (t) => {
  const r = await rig(t, { world: whlrInGroup4 }); // displayGroup is the default, 1
  await reported(r);
  assert.deepEqual(report(r), [LINE, HINT]);
  assert.deepEqual(r.bridge.status().display_groups, [
    { id: 1, shows: null },
    { id: 2, shows: null },
    { id: 4, shows: "WHLR" },
    { id: 5, shows: null },
  ]);
  assert.equal(r.bridge.status().display_group, 1);

  // What went to TWS for it: one subscription per listed group and one lookup by contract id,
  // all under the bridge's own request ids. Nothing that changes a window, nothing about orders.
  const ib = r.world.current;
  assert.deepEqual([...new Set(ib.calls.map((call) => call.name))].sort(), [
    "connect",
    "queryDisplayGroups",
    "reqContractDetails",
    "subscribeToGroupEvents",
  ]);
  assert.deepEqual(ib.callsOf("subscribeToGroupEvents").map((call) => call.args[1]), [4, 1, 2, 5]);
  // The lookup names the contract the way the group did: its id and the exchange after the "@".
  assert.deepEqual(ib.callsOf("reqContractDetails").map((call) => call.args[1]), [{ conId: 700, exchange: "SMART" }]);
  for (const call of [...ib.callsOf("subscribeToGroupEvents"), ...ib.callsOf("reqContractDetails")]) {
    assert.ok((call.args[0] as number) >= REQUEST_ID_BASE);
  }
  assert.deepEqual(r.journal.ofType("display_groups_shown"), [
    {
      type: "display_groups_shown",
      display_group: 1,
      groups: [
        { id: 1, shows: null, answered: true },
        { id: 2, shows: null, answered: true },
        { id: 4, shows: "WHLR", answered: true },
        { id: 5, shows: null, answered: true },
      ],
    },
  ]);

  // Once per connection: later changes update /status and are not announced.
  ib.operatorShows(2, "222@SMART");
  await until(() => shows(r, 2) === "WXYZ", "group 2 to read WXYZ");
  await sleep(20);
  assert.deepEqual(report(r), [LINE, HINT]);
});

test("groups: with displayGroup on the group in use there is one line and no advice", async (t) => {
  const r = await rig(t, { world: whlrInGroup4, config: (c) => (c.displayGroup = 4) });
  await reported(r);
  assert.deepEqual(report(r), [LINE]);
  assert.equal(r.bridge.status().display_group, 4);
});

test("groups: a lookup TWS refuses leaves the contract id, and is not repeated on that connection", async (t) => {
  const r = await rig(t, {
    world: (w) => {
      w.groups = "1|4";
      w.groupShows.set(4, "999@SMART"); // no such contract in this TWS
    },
  });
  await reported(r);
  assert.deepEqual(report(r), ["display groups: 1 nothing · 4 999@SMART ← windows are linked here", HINT]);
  assert.equal(shows(r, 4), "999@SMART");

  const first = r.world.current;
  first.operatorShows(4, "none");
  first.operatorShows(4, "999@SMART");
  await sleep(20);
  assert.equal(first.callsOf("reqContractDetails").length, 1);
  assert.equal(shows(r, 4), "999@SMART");

  // A new connection may ask once more.
  r.world.drop();
  await reported(r, 2);
  assert.equal(r.world.current.callsOf("reqContractDetails").length, 1);
});

test("groups: a slow lookup does not hold the report past its own timeout", async (t) => {
  const r = await rig(t, { world: whlrWithSilentLookups, groupLookupTimeoutMs: 20, groupReportMs: 5000 });
  await reported(r);
  assert.deepEqual(report(r), ["display groups: 1 nothing · 2 nothing · 4 700@SMART ← windows are linked here · 5 nothing", HINT]);
  assert.equal(shows(r, 4), "700@SMART");
});

test("groups: after the wait the report is said with what has arrived; a ticker that comes later still lands in /status", async (t) => {
  const r = await rig(t, { world: whlrWithSilentLookups, groupReportMs: 30, groupLookupTimeoutMs: 5000 });
  await reported(r);
  assert.deepEqual(report(r), ["display groups: 1 nothing · 2 nothing · 4 700@SMART ← windows are linked here · 5 nothing", HINT]);

  const ib = r.world.current;
  const reqId = ib.callsOf("reqContractDetails")[0]?.args[0];
  ib.emit("contractDetails", reqId, listing("WHLR", 700, "NASDAQ"));
  ib.emit("contractDetailsEnd", reqId);
  await until(() => shows(r, 4) === "WHLR", "group 4 to read WHLR");
  assert.equal(report(r).length, 2); // not said a second time
});

test("groups: a group that answers late is 'no answer' in the report and filled in afterwards", async (t) => {
  const r = await rig(t, {
    world: (w) => {
      whlrInGroup4(w);
      w.silentGroups.add(2);
    },
    groupReportMs: 30,
  });
  await reported(r);
  assert.deepEqual(report(r), ["display groups: 1 nothing · 2 no answer · 4 WHLR ← windows are linked here · 5 nothing", HINT]);
  assert.equal(shows(r, 2), null);

  r.world.current.operatorShows(2, "222@SMART"); // the late answer
  await until(() => shows(r, 2) === "WXYZ", "group 2 to read WXYZ");
  assert.deepEqual(lookedUp(r), [700, 222]);
  assert.equal(report(r).length, 2);
});

test("groups: /status follows what the operator does in TWS", async (t) => {
  const r = await rig(t, { world: whlrInGroup4 });
  await reported(r);
  const ib = r.world.current;

  ib.operatorShows(4, "222@SMART");
  await until(() => shows(r, 4) === "WXYZ", "WXYZ");
  ib.operatorShows(4, "555@SMART");
  await until(() => shows(r, 4) === "BRK.B", "BRK.B");
  ib.operatorShows(4, "none");
  assert.equal(shows(r, 4), null);
  ib.operatorShows(4, "combo");
  assert.equal(shows(r, 4), "combo");
  ib.operatorShows(1, "700@SMART"); // a contract already looked up reads at once
  assert.equal(shows(r, 1), "WHLR");

  // One lookup per contract id, ever.
  ib.operatorShows(4, "222@SMART");
  ib.operatorShows(4, "700@SMART");
  await sleep(20);
  assert.deepEqual(lookedUp(r), [700, 222, 555]);

  // A group that names no exchange is looked up by the contract id alone.
  ib.operatorShows(5, "333");
  await until(() => shows(r, 5) === "QQQQ", "QQQQ");
  assert.deepEqual(ib.callsOf("reqContractDetails").at(-1)?.args[1], { conId: 333 });
});

test("groups: a contract the operator has already left is not looked up", async (t) => {
  const r = await rig(t, { world: whlrInGroup4, backgroundGapMs: 25 });
  await reported(r);
  const ib = r.world.current;
  // Arrowing through a watchlist: three tickers within one background gap.
  ib.operatorShows(4, "222@SMART");
  ib.operatorShows(4, "333@SMART");
  ib.operatorShows(4, "444@SMART");
  await until(() => shows(r, 4) === "PENY", "the last one to be named");
  await sleep(60);
  assert.deepEqual(lookedUp(r), [700, 444]);
});

test("groups: /focus before the survey reaches its group: that group is subscribed to once", async (t) => {
  const r = await rig(t, { world: whlrInGroup4, config: (c) => (c.displayGroup = 4), backgroundGapMs: 80 });
  const ib = r.world.current;
  // The list has just arrived; the background subscriptions have not started.
  assert.deepEqual(ib.callsOf("subscribeToGroupEvents"), []);
  assert.deepEqual(await r.bridge.focus({ ticker: "ABCD" }), { ticker: "ABCD", conid: 111, group: 4 });

  await reported(r);
  const subscribed = ib.callsOf("subscribeToGroupEvents").map((call) => call.args[1]);
  assert.deepEqual(subscribed, [4, 1, 2, 5]); // 4 by /focus, the rest by the survey; 4 not twice
  const focusId = ib.callsOf("subscribeToGroupEvents")[0]?.args[0];
  assert.deepEqual(ib.callsOf("updateDisplayGroup").map((call) => call.args), [[focusId, "111@SMART"]]);

  // The group now shows what /focus put there, named without another lookup.
  assert.equal(shows(r, 4), "ABCD");
  assert.deepEqual(report(r), ["display groups: 1 nothing · 2 nothing · 4 ABCD ← windows are linked here · 5 nothing"]);
  assert.deepEqual(ib.callsOf("reqContractDetails").map((call) => (call.args[1] as { symbol?: string }).symbol), ["ABCD"]);
});

test("groups: /focus after the survey reuses the survey's subscription", async (t) => {
  const r = await rig(t, { world: whlrInGroup4, config: (c) => (c.displayGroup = 4) });
  await reported(r);
  const ib = r.world.current;
  const group4 = ib.callsOf("subscribeToGroupEvents").find((call) => call.args[1] === 4)?.args[0];

  await r.bridge.focus({ ticker: "WXYZ" });
  await r.bridge.focus({ ticker: "ABCD" });
  assert.equal(ib.callsOf("subscribeToGroupEvents").length, 4);
  assert.deepEqual(ib.callsOf("updateDisplayGroup").map((call) => call.args), [
    [group4, "222@SMART"],
    [group4, "111@SMART"],
  ]);
  await until(() => shows(r, 4) === "ABCD", "group 4 to read ABCD");
});

test("groups: orders and /focus do not wait behind the survey", async (t) => {
  const r = await rig(t, { world: whlrInGroup4, backgroundGapMs: 80 });
  const ib = r.world.current;
  const result = await r.bridge.order(buy());
  assert.equal(result.order_id, 1000);
  await r.bridge.focus({ ticker: "WXYZ" });
  // Both went out before the survey sent its first message.
  const names = ib.calls.map((call) => call.name);
  assert.deepEqual(names.filter((name) => name === "placeOrder").length, 3);
  assert.deepEqual(ib.callsOf("subscribeToGroupEvents").map((call) => call.args[1]), [1]); // /focus's own
  assert.equal(ib.callsOf("updateDisplayGroup").length, 1);

  await reported(r);
  assert.deepEqual(ib.callsOf("subscribeToGroupEvents").map((call) => call.args[1]), [1, 4, 2, 5]);
  assert.equal(r.world.allPlaced().length, 3);
  assert.deepEqual(ib.callsOf("cancelOrder"), []);
});

test("groups: the survey's messages go out one at a time, with a gap", async (t) => {
  const r = await rig(t, { world: whlrInGroup4, backgroundGapMs: 20 });
  const ib = r.world.current;
  const seen: number[] = [];
  const started = Date.now();
  while (ib.callsOf("subscribeToGroupEvents").length < 4) {
    seen.push(ib.callsOf("subscribeToGroupEvents").length);
    assert.ok(Date.now() - started < 2000, "the survey did not finish");
    await sleep(2);
  }
  // Never two between two looks 2 ms apart, and not all at once at the start.
  assert.equal(seen[0], 0);
  for (let i = 1; i < seen.length; i += 1) assert.ok((seen[i] ?? 0) - (seen[i - 1] ?? 0) <= 1);
  assert.ok(Date.now() - started >= 60, "four messages 20 ms apart take at least 60 ms");
});

test("groups: a reconnect reads the groups again and says it again; tickers already known are not asked for", async (t) => {
  const r = await rig(t, { world: whlrInGroup4 });
  await reported(r);
  const first = r.world.current;

  r.world.mode = "refuse";
  r.world.drop();
  assert.deepEqual(r.bridge.status().display_groups, []); // nothing is known while TWS is away

  r.world.groupShows.set(4, "none"); // meanwhile the operator relinks the windows to group 2
  r.world.groupShows.set(2, "700@SMART");
  r.world.mode = "accept";
  await reported(r, 2);
  assert.deepEqual(report(r), [
    LINE,
    HINT,
    "display groups: 1 nothing · 2 WHLR ← windows are linked here · 4 nothing · 5 nothing",
    'displayGroup is 1 but the linked windows look like group 2: set "displayGroup": 2 in config.json and restart',
  ]);

  const second = r.world.current;
  assert.notEqual(second, first);
  assert.equal(second.callsOf("subscribeToGroupEvents").length, 4);
  assert.deepEqual(second.callsOf("reqContractDetails"), []); // 700 is WHLR, as before
  assert.equal(first.callsOf("subscribeToGroupEvents").length, 4); // nothing more went to the old connection
});

test("groups: a TWS that does not list its groups: no report, and /status shows only the group /focus uses", async (t) => {
  const r = await rig(t); // the fake answers no group list unless told to
  await sleep(20);
  assert.deepEqual(report(r), []);
  assert.deepEqual(r.bridge.status().display_groups, []);
  assert.deepEqual(r.world.current.callsOf("subscribeToGroupEvents"), []);

  await r.bridge.focus({ ticker: "ABCD" });
  await until(() => shows(r, 1) === "ABCD", "group 1 to read ABCD");
  assert.deepEqual(r.bridge.status().display_groups, [{ id: 1, shows: "ABCD" }]);
  assert.deepEqual(report(r), []);
});

test("groups: a TWS that lists no groups at all says so at once", async (t) => {
  const r = await rig(t, { world: (w) => (w.groups = "") });
  await reported(r);
  assert.deepEqual(report(r), ["display groups: TWS lists none (displayGroup is 1: /focus may change no window)"]);
});

test("groups: the bridge stopping ends the wait for the report", async (t) => {
  const r = await rig(t, {
    world: (w) => {
      whlrInGroup4(w);
      w.silentGroups.add(2);
    },
    groupReportMs: 30,
  });
  r.bridge.close();
  r.link.stop();
  await sleep(60);
  assert.deepEqual(report(r), []);
});
