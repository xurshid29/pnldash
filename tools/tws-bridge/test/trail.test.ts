import assert from "node:assert/strict";
import { test } from "node:test";
import { listing, sleep, until } from "./fake-tws.js";
import type { FakeTws } from "./fake-tws.js";
import { rig } from "./harness.js";
import type { Rig } from "./harness.js";

// The trail to hold a /focus against: every time TWS says what a display group shows it is a log
// line (`display_group_shows`), the `focus` line says exactly what was sent, and the console says
// when the configured group changes and whether a focus did it.

const RAYA = 755531415;

/** Four groups, the windows linked to group 4 (showing WHLR), and `displayGroup` set to 4. */
function operatorsTws(world: FakeTws): void {
  world.contracts.set("WHLR", [listing("WHLR", 700, "NASDAQ")]);
  world.contracts.set("RAYA", [listing("RAYA", RAYA, "NASDAQ")]);
  world.groups = "4|1|2|5";
  world.groupShows.set(4, "700@SMART");
}

const onGroup4 = { world: operatorsTws, config: (c: { displayGroup: number }): void => void (c.displayGroup = 4) };

/** The console's lines about a group changing. */
function moves(r: Rig): string[] {
  return r.said.filter((line) => line.startsWith("group "));
}

/** The log's lines about what groups show: [group, what TWS sent, ticker, cause]. */
function shown(r: Rig, group?: number): unknown[][] {
  return r.journal
    .ofType("display_group_shows")
    .filter((line) => group === undefined || line["group"] === group)
    .map((line) => [line["group"], line["contract_info"], line["ticker"], line["cause"]]);
}

async function surveyed(r: Rig, times = 1): Promise<void> {
  await until(() => r.said.filter((line) => line.startsWith("display groups:")).length >= times, "the display-group report");
}

test("trail: what each group shows is logged as TWS says it, with the subscription's request id", async (t) => {
  const r = await rig(t, onGroup4);
  await surveyed(r);
  const ib = r.world.current;

  // The first thing each group says on a connection.
  assert.deepEqual(r.journal.ofType("display_group_shows"), [
    { type: "display_group_shows", group: 4, contract_info: "700@SMART", ticker: null, request_id: ib.subscriptionOf(4), cause: "initial" },
    { type: "display_group_shows", group: 1, contract_info: "none", ticker: null, request_id: ib.subscriptionOf(1), cause: "initial" },
    { type: "display_group_shows", group: 2, contract_info: "none", ticker: null, request_id: ib.subscriptionOf(2), cause: "initial" },
    { type: "display_group_shows", group: 5, contract_info: "none", ticker: null, request_id: ib.subscriptionOf(5), cause: "initial" },
  ]);
  // The name of a contract id is logged when TWS gives it.
  assert.deepEqual(r.journal.ofType("display_group_ticker"), [{ type: "display_group_ticker", conid: 700, ticker: "WHLR" }]);
  // A first reading is not a change: the report line covers it.
  assert.deepEqual(moves(r), []);

  // Another group, with stray spaces: logged exactly as sent, read without them.
  ib.operatorShows(2, " 333@SMART ");
  assert.deepEqual(shown(r, 2).at(-1), [2, " 333@SMART ", null, "tws"]);
  await until(() => r.bridge.status().display_groups.find((group) => group.id === 2)?.shows === "QQQQ", "group 2 to read QQQQ");
  assert.deepEqual(moves(r), []); // the console speaks of the configured group only

  // An event under an id that is no subscription of this connection is logged as such.
  ib.emit("displayGroupUpdated", 123, "5@SMART");
  assert.deepEqual(r.journal.ofType("display_group_unknown"), [
    { type: "display_group_unknown", request_id: 123, contract_info: "5@SMART" },
  ]);
});

test("trail: a /focus is logged with the exact string sent, and the group's answer is marked as the focus's", async (t) => {
  const r = await rig(t, onGroup4);
  await surveyed(r);
  const ib = r.world.current;
  const subscription = ib.subscriptionOf(4);

  await r.bridge.focus({ ticker: "RAYA" });
  await until(() => moves(r).length === 1, "the group's answer");
  assert.deepEqual(r.journal.ofType("focus"), [
    { type: "focus", ticker: "RAYA", conid: RAYA, group: 4, sent: `${RAYA}@SMART`, request_id: subscription },
  ]);
  assert.deepEqual(ib.callsOf("updateDisplayGroup").map((call) => call.args), [[subscription, `${RAYA}@SMART`]]);
  assert.deepEqual(r.journal.ofType("display_group_shows").at(-1), {
    type: "display_group_shows",
    group: 4,
    contract_info: `${RAYA}@SMART`,
    ticker: "RAYA",
    request_id: subscription,
    cause: "focus",
  });
  assert.deepEqual(moves(r), [`group 4 now shows RAYA (${RAYA}@SMART) ← focus`]);
});

test("trail: a change made in TWS is told apart from a focus", async (t) => {
  const r = await rig(t, onGroup4);
  await surveyed(r);
  const ib = r.world.current;
  await r.bridge.focus({ ticker: "RAYA" });
  await until(() => moves(r).length === 1, "the focus's answer");

  // Right after the focus, but another contract: the operator picked it in TWS. Its name is not
  // known yet, so the number is said at once and the name when TWS gives it.
  ib.operatorShows(4, "222@SMART");
  assert.equal(moves(r).at(-1), "group 4 now shows 222@SMART ← changed in TWS");
  assert.deepEqual(shown(r, 4).at(-1), [4, "222@SMART", null, "tws"]);
  await until(() => moves(r).length === 3, "the contract's name");
  assert.equal(moves(r).at(-1), "group 4: 222@SMART is WXYZ");
  assert.deepEqual(r.journal.ofType("display_group_ticker").at(-1), { type: "display_group_ticker", conid: 222, ticker: "WXYZ" });

  // The focused contract again, but three seconds after the focus: that was not the focus.
  r.clock.now += 3000;
  ib.operatorShows(4, `${RAYA}@SMART`);
  assert.equal(moves(r).at(-1), `group 4 now shows RAYA (${RAYA}@SMART) ← changed in TWS`);
  assert.deepEqual(shown(r, 4).at(-1), [4, `${RAYA}@SMART`, "RAYA", "tws"]);

  ib.operatorShows(4, "none");
  assert.equal(moves(r).at(-1), "group 4 now shows nothing ← changed in TWS");
  ib.operatorShows(4, "combo");
  assert.equal(moves(r).at(-1), "group 4 now shows a combo ← changed in TWS");
  assert.equal(moves(r).length, 6);
});

test("trail: no event is thinned out, and only an identical repeat is collapsed", async (t) => {
  const r = await rig(t, onGroup4);
  await surveyed(r);
  const ib = r.world.current;
  const subscription = ib.subscriptionOf(4);
  assert.deepEqual(shown(r, 4), [[4, "700@SMART", null, "initial"]]);

  // TWS says again what it has just said: one line stands for both.
  ib.emit("displayGroupUpdated", subscription, "700@SMART");
  ib.emit("displayGroupUpdated", subscription, "700@SMART");
  assert.equal(shown(r, 4).length, 1);
  assert.deepEqual(moves(r), []);

  // Three changes in a row, as fast as they come: three lines each, in the log and on the console.
  ib.operatorShows(4, "111@SMART");
  ib.operatorShows(4, "222@SMART");
  ib.operatorShows(4, "111@SMART");
  assert.deepEqual(shown(r, 4).slice(1), [
    [4, "111@SMART", null, "tws"],
    [4, "222@SMART", null, "tws"],
    [4, "111@SMART", null, "tws"],
  ]);
  assert.deepEqual(moves(r), [
    "group 4 now shows 111@SMART ← changed in TWS",
    "group 4 now shows 222@SMART ← changed in TWS",
    "group 4 now shows 111@SMART ← changed in TWS",
  ]);
  ib.emit("displayGroupUpdated", subscription, "111@SMART"); // a repeat again
  assert.equal(shown(r, 4).length, 4);

  // The same words after a /focus are news: TWS answering that focus.
  await r.bridge.focus({ ticker: "ABCD" }); // contract 111, which the group already shows
  await until(() => shown(r, 4).length === 5, "the answer to the first focus");
  assert.deepEqual(shown(r, 4).at(-1), [4, "111@SMART", "ABCD", "focus"]);
  await r.bridge.focus({ ticker: "ABCD" });
  await until(() => shown(r, 4).length === 6, "the answer to the second focus");
  assert.deepEqual(shown(r, 4).at(-1), [4, "111@SMART", "ABCD", "focus"]);
  assert.deepEqual(
    moves(r).filter((line) => line.endsWith("← focus")),
    ["group 4 now shows ABCD (111@SMART) ← focus", "group 4 now shows ABCD (111@SMART) ← focus"],
  );
  // And a repeat with no focus in between is a repeat.
  ib.emit("displayGroupUpdated", subscription, "111@SMART");
  await sleep(10);
  assert.equal(shown(r, 4).length, 6);
});

test("trail: a focus TWS takes and does nothing with leaves a focus line and no answer to it", async (t) => {
  const r = await rig(t, {
    ...onGroup4,
    world: (w) => {
      operatorsTws(w);
      w.ignoreGroupUpdates = true;
    },
  });
  await surveyed(r);
  const before = shown(r).length;

  assert.deepEqual(await r.bridge.focus({ ticker: "RAYA" }), { ticker: "RAYA", conid: RAYA, group: 4 });
  await sleep(20);
  // What was sent is on record; that nothing came back is what the log now shows.
  assert.equal(r.journal.ofType("focus")[0]?.["sent"], `${RAYA}@SMART`);
  assert.equal(shown(r).length, before);
  assert.deepEqual(moves(r), []);
});

test("trail: on the first focus TWS first says what the group showed, then the change", async (t) => {
  // No group list from this TWS; the test plays TWS's part for group 1 by hand.
  const r = await rig(t, {
    world: (w) => {
      w.contracts.set("RAYA", [listing("RAYA", RAYA, "NASDAQ")]);
      w.silentGroups.add(1);
      w.ignoreGroupUpdates = true;
    },
  });
  await r.bridge.focus({ ticker: "RAYA" });
  const ib = r.world.current;
  const subscription = ib.subscriptionOf(1);
  ib.emit("displayGroupUpdated", subscription, "222@SMART"); // the answer to the subscription
  ib.emit("displayGroupUpdated", subscription, `${RAYA}@SMART`); // the update taking effect

  assert.deepEqual(shown(r), [
    [1, "222@SMART", null, "initial"],
    [1, `${RAYA}@SMART`, "RAYA", "focus"],
  ]);
  assert.deepEqual(moves(r), [`group 1 now shows RAYA (${RAYA}@SMART) ← focus`]);
});

test("trail: when the subscription's own answer already shows the focused contract, it is said once", async (t) => {
  const r = await rig(t); // this fake answers a new subscription with the group's contract after the update
  await r.bridge.focus({ ticker: "ABCD" });
  await sleep(10);
  assert.deepEqual(shown(r), [[1, "111@SMART", "ABCD", "focus"]]);
  assert.deepEqual(moves(r), ["group 1 now shows ABCD (111@SMART) ← focus"]);
});

test("trail: a new connection starts the trail afresh", async (t) => {
  const r = await rig(t, onGroup4);
  await surveyed(r);
  await r.bridge.focus({ ticker: "RAYA" });
  await until(() => moves(r).length === 1, "the focus's answer");

  r.world.drop(); // the group keeps showing RAYA in TWS
  await surveyed(r, 2);
  // Its first word on the new connection is a first reading, not the answer to the old focus.
  assert.deepEqual(shown(r, 4).at(-1), [4, `${RAYA}@SMART`, "RAYA", "initial"]);
  assert.equal(moves(r).length, 1);
  assert.equal(r.journal.ofType("display_group_shows").at(-1)?.["request_id"], r.world.current.subscriptionOf(5));
});
