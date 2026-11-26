import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { OrderAction, OrderType, SecType } from "@stoqey/ib";
import type { Contract, Order } from "@stoqey/ib";
import { createIbApi } from "../src/ib.js";
import { NotConnectedError, REQUEST_ID_BASE, TwsLink, TwsRequestError, TwsTimeoutError } from "../src/link.js";
import type { LinkHandlers, OrderMessageEvent } from "../src/link.js";
import { FakeTws, sleep, until } from "./fake-tws.js";

const STOCK: Contract = { conId: 111, symbol: "ABCD", secType: SecType.STK, exchange: "SMART", currency: "USD" };
const BUY: Order = { action: OrderAction.BUY, orderType: OrderType.LMT, totalQuantity: 1, lmtPrice: 1, transmit: true };

function makeLink(
  t: TestContext,
  world: FakeTws,
  handlers: LinkHandlers = {},
  handshakeTimeoutMs = 1000,
  backgroundGapMs = 1,
): TwsLink {
  const link = new TwsLink({
    factory: world.factory,
    host: "127.0.0.1",
    port: 7497,
    clientId: 77,
    reconnectMinMs: 5,
    reconnectMaxMs: 20,
    handshakeTimeoutMs,
    backgroundGapMs,
  });
  link.handlers = handlers;
  t.after(() => link.stop());
  return link;
}

test("link: up once TWS has sent the next valid order id; the library gets every option", async (t) => {
  const world = new FakeTws();
  const ups: Array<{ accounts: string[]; nextValidId: number }> = [];
  const link = makeLink(t, world, { onUp: (info) => ups.push(info) });
  assert.equal(link.isReady(), false);
  link.start();
  await until(() => link.isReady(), "ready");

  assert.deepEqual(link.getAccounts(), ["DU1234567"]);
  assert.deepEqual(ups, [{ accounts: ["DU1234567"], nextValidId: 1000 }]);
  // host, port, clientId and maxReqPerSec are all passed: the library reads its own config (and .env) otherwise.
  assert.deepEqual(world.current.options, { host: "127.0.0.1", port: 7497, clientId: 77, maxReqPerSec: 40 });
  assert.deepEqual(world.current.callsOf("connect")[0]?.args, [77]);
});

test("link: reconnects with a new library object after a drop, and the old one is cut off", async (t) => {
  const world = new FakeTws();
  const downs: string[] = [];
  const link = makeLink(t, world, { onDown: (reason) => downs.push(reason) });
  link.start();
  await until(() => link.isReady(), "ready");
  const first = world.current;

  world.drop();
  assert.equal(link.isReady(), false);
  assert.deepEqual(link.getAccounts(), []);
  assert.deepEqual(downs, ["TWS closed the connection"]);
  await until(() => link.isReady(), "ready again");

  assert.equal(world.instances.length, 2);
  assert.notEqual(world.current, first);
  // The first object was never asked to connect a second time: its queue can never be replayed.
  assert.equal(first.callsOf("connect").length, 1);
  assert.equal(first.callsOf("removeAllListeners").length, 1);
});

test("link: an order is never sent, held or replayed across a reconnect", async (t) => {
  const world = new FakeTws();
  const link = makeLink(t, world);
  link.start();
  await until(() => link.isReady(), "ready");

  link.placeOrder(link.allocateOrderIds(1), STOCK, BUY);
  assert.equal(world.allPlaced().length, 1);

  world.drop();
  // While down, placing throws at once: nothing is queued for later.
  assert.throws(() => link.placeOrder(5000, STOCK, BUY), NotConnectedError);
  assert.throws(() => link.allocateOrderIds(3), NotConnectedError);
  assert.throws(() => link.cancelOrder(1000), NotConnectedError);

  await until(() => link.isReady(), "ready again");
  await sleep(20);
  assert.equal(world.instances.length, 2);
  assert.deepEqual(world.current.callsOf("placeOrder"), []);
  assert.equal(world.allPlaced().length, 1);
});

test("link: order ids are never reused within a run, whatever TWS says after a reconnect", async (t) => {
  const world = new FakeTws();
  const link = makeLink(t, world);
  link.start();
  await until(() => link.isReady(), "ready");
  assert.equal(link.allocateOrderIds(3), 1000);
  assert.equal(link.allocateOrderIds(3), 1003);

  // TWS repeats the same next id (nothing of ours reached it).
  world.drop();
  await until(() => link.isReady(), "ready again");
  assert.equal(link.allocateOrderIds(3), 1006);

  // TWS has moved on by itself: follow it.
  world.nextValidId = 2000;
  world.drop();
  await until(() => link.isReady(), "ready a third time");
  assert.equal(link.allocateOrderIds(3), 2000);
});

test("link: a closed TWS port is retried with backoff and reported once", async (t) => {
  const world = new FakeTws();
  world.mode = "refuse";
  const downs: string[] = [];
  const link = makeLink(t, world, { onDown: (reason) => downs.push(reason) });
  link.start();
  await until(() => world.instances.length >= 4, "four attempts");
  assert.equal(link.isReady(), false);
  assert.deepEqual(downs, ["connect ECONNREFUSED 127.0.0.1:7497 (code 502)"]);
  for (const attempt of world.instances.slice(0, 3)) assert.equal(attempt.callsOf("connect").length, 1);

  // TWS is started: the next attempt gets through.
  world.mode = "accept";
  await until(() => link.isReady(), "ready");
});

test("link: a TWS that never answers the handshake is dropped and retried", async (t) => {
  const world = new FakeTws();
  world.mode = "hang";
  const downs: string[] = [];
  const link = makeLink(t, world, { onDown: (reason) => downs.push(reason) }, 40);
  link.start();
  await until(() => world.instances.length >= 2, "a second attempt");
  assert.equal(link.isReady(), false);
  assert.match(downs[0] ?? "", /did not finish the API handshake/);
  assert.equal(world.instances[0]?.callsOf("disconnect").length, 1);
});

test("link: stop() ends the connection and the retries", async (t) => {
  const world = new FakeTws();
  const link = makeLink(t, world);
  link.start();
  await until(() => link.isReady(), "ready");
  link.stop();
  assert.equal(link.isReady(), false);
  assert.equal(world.current.callsOf("disconnect").length, 1);
  await sleep(40);
  assert.equal(world.instances.length, 1);
});

test("link: contract lookups resolve, fail with TWS's error, time out, and die with the connection", async (t) => {
  const world = new FakeTws();
  const link = makeLink(t, world);
  link.start();
  await until(() => link.isReady(), "ready");

  const found = await link.contractDetails({ symbol: "ABCD" }, 50);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.contract.conId, 111);
  const reqId = world.current.callsOf("reqContractDetails")[0]?.args[0] as number;
  assert.ok(reqId >= REQUEST_ID_BASE);

  await assert.rejects(
    link.contractDetails({ symbol: "NOPE" }, 50),
    (err: unknown) => err instanceof TwsRequestError && err.code === 200,
  );

  world.silentLookups = true;
  await assert.rejects(link.contractDetails({ symbol: "ABCD" }, 20), TwsTimeoutError);

  const hanging = link.contractDetails({ symbol: "ABCD" }, 5000);
  world.drop();
  await assert.rejects(hanging, NotConnectedError);
  await assert.rejects(async () => link.contractDetails({ symbol: "ABCD" }, 50), NotConnectedError);
});

test("link: the ask comes from a plain snapshot, never the paid regulatory one", async (t) => {
  const world = new FakeTws();
  world.asks.set("ABCD", 2.52);
  const link = makeLink(t, world);
  link.start();
  await until(() => link.isReady(), "ready");

  assert.equal(await link.askSnapshot(STOCK, 50), 2.52);
  const call = world.current.callsOf("reqMktData")[0];
  assert.deepEqual(call?.args.slice(1), [STOCK, "", true, false]); // snapshot true, regulatorySnapshot false

  // No ask in time: null, and the request is cancelled.
  world.asks.clear();
  assert.equal(await link.askSnapshot(STOCK, 20), null);
  const second = world.current.callsOf("reqMktData")[1]?.args[0];
  assert.deepEqual(world.current.callsOf("cancelMktData")[0]?.args, [second]);

  // A delayed ask (tick type 67) and "no data" (-1) are not prices.
  const pending = link.askSnapshot(STOCK, 30);
  const third = world.current.callsOf("reqMktData")[2]?.args[0];
  world.current.emit("tickPrice", third, 67, 2.4);
  world.current.emit("tickPrice", third, 2, -1);
  assert.equal(await pending, null);

  // "Not subscribed" from TWS is an error, not a silent wait.
  const refused = link.askSnapshot(STOCK, 200);
  const fourth = world.current.callsOf("reqMktData")[3]?.args[0];
  world.current.emit("error", new Error("Requested market data is not subscribed"), 354, fourth);
  await assert.rejects(refused, (err: unknown) => err instanceof TwsRequestError && err.code === 354);
});

test("link: errors about lookups never look like errors about orders", async (t) => {
  const world = new FakeTws();
  const messages: OrderMessageEvent[] = [];
  const link = makeLink(t, world, { onOrderMessage: (event) => messages.push(event) });
  link.start();
  await until(() => link.isReady(), "ready");

  // A late answer to a request that is no longer waiting.
  world.current.emit("error", new Error("Can't find EId with tickerId"), 300, REQUEST_ID_BASE + 5);
  assert.deepEqual(messages, []);

  world.current.emit("error", new Error("Order rejected - reason: no"), 201, 1000);
  world.current.emit("error", new Error("Order Message: Warning: your order will not be placed until 04:00"), 399, 1001);
  assert.deepEqual(messages, [
    { orderId: 1000, code: 201, message: "Order rejected - reason: no", nonFatal: false },
    { orderId: 1001, code: 399, message: "Order Message: Warning: your order will not be placed until 04:00", nonFatal: true },
  ]);
});

test("link: TWS losing IB's servers is tracked (1100 lost, 1101 / 1102 back)", async (t) => {
  const world = new FakeTws();
  const notes: string[] = [];
  const link = makeLink(t, world, { onNote: (kind, fields) => notes.push(`${kind}:${String(fields["code"])}`) });
  link.start();
  await until(() => link.isReady(), "ready");
  assert.equal(link.isServerLinkLost(), false);

  world.current.emit("info", "Connectivity between IB and Trader Workstation has been lost.", 1100);
  assert.equal(link.isServerLinkLost(), true);
  world.current.emit("info", "Connectivity restored - data maintained.", 1102);
  assert.equal(link.isServerLinkLost(), false);

  world.current.emit("info", "Market data farm connection is OK:usfarm", 2104);
  assert.deepEqual(notes, ["tws_notice:1100", "tws_notice:1102"]);

  // 2110: the bridge connected to a TWS that is itself offline.
  world.current.emit("info", "Connectivity between Trader Workstation and server is broken.", 2110);
  assert.equal(link.isServerLinkLost(), true);
  world.current.emit("info", "Connectivity restored - data lost.", 1101);
  assert.equal(link.isServerLinkLost(), false);

  // A new connection starts from "not known to be lost".
  world.current.emit("info", "Connectivity between IB and Trader Workstation has been lost.", 1100);
  world.drop();
  await until(() => link.isReady(), "ready again");
  assert.equal(link.isServerLinkLost(), false);
});

test("link: display groups are asked for on connect; focus subscribes once per connection", async (t) => {
  const world = new FakeTws();
  const link = makeLink(t, world);
  link.start();
  await until(() => link.isReady(), "ready");

  const query = world.current.callsOf("queryDisplayGroups")[0]?.args[0];
  assert.equal(link.getDisplayGroups(), null);
  world.current.emit("displayGroupList", query, "4|1|2|3");
  assert.deepEqual(link.getDisplayGroups(), [4, 1, 2, 3]);

  link.focus(1, 111);
  link.focus(1, 222);
  const subscriptions = world.current.callsOf("subscribeToGroupEvents");
  assert.equal(subscriptions.length, 1);
  const subscriptionId = subscriptions[0]?.args[0];
  assert.deepEqual(subscriptions[0]?.args, [subscriptionId, 1]);
  assert.deepEqual(
    world.current.callsOf("updateDisplayGroup").map((call) => call.args),
    [
      [subscriptionId, "111@SMART"],
      [subscriptionId, "222@SMART"],
    ],
  );

  // A new connection knows nothing of the old subscription.
  world.drop();
  assert.throws(() => link.focus(1, 111), NotConnectedError);
  await until(() => link.isReady(), "ready again");
  link.focus(1, 111);
  assert.equal(world.current.callsOf("subscribeToGroupEvents").length, 1);
  assert.equal(world.current.callsOf("updateDisplayGroup").length, 1);
});

test("link: every listed display group is subscribed to in the background, and what each shows is kept", async (t) => {
  const world = new FakeTws();
  world.groups = "2|1|2"; // TWS's order, with a repeat
  world.groupShows.set(2, "222@SMART");
  const lists: number[][] = [];
  const shown: Array<[number, string]> = [];
  const link = makeLink(
    t,
    world,
    { onDisplayGroups: (groups) => lists.push(groups), onDisplayGroupShows: (group, info) => shown.push([group, info]) },
    1000,
    10,
  );
  link.start();
  await until(() => link.isReady(), "ready");
  // The list is in; no group has been asked yet (the first subscription waits one gap).
  assert.deepEqual(link.getDisplayGroupContents(), [
    { id: 1, contractInfo: null },
    { id: 2, contractInfo: null },
  ]);
  assert.deepEqual(world.current.callsOf("subscribeToGroupEvents"), []);
  await until(() => shown.length === 2, "both groups to answer");

  assert.deepEqual(lists, [[2, 1]]);
  assert.deepEqual(shown, [
    [2, "222@SMART"],
    [1, "none"],
  ]);
  assert.deepEqual(link.getDisplayGroupContents(), [
    { id: 1, contractInfo: "none" },
    { id: 2, contractInfo: "222@SMART" },
  ]);
  const subscriptions = world.current.callsOf("subscribeToGroupEvents");
  assert.deepEqual(subscriptions.map((call) => call.args[1]), [2, 1]);
  for (const call of subscriptions) assert.ok((call.args[0] as number) >= REQUEST_ID_BASE);

  // /focus on a group the survey subscribed to sends only the update, under that subscription.
  link.focus(2, 111);
  assert.equal(world.current.callsOf("subscribeToGroupEvents").length, 2);
  assert.deepEqual(world.current.callsOf("updateDisplayGroup")[0]?.args, [subscriptions[0]?.args[0], "111@SMART"]);
  await until(() => shown.length === 3, "the group's own report of the change");
  assert.deepEqual(link.getDisplayGroupContents()[1], { id: 2, contractInfo: "111@SMART" });

  // An event under an id that is no subscription of ours changes nothing.
  world.current.emit("displayGroupUpdated", REQUEST_ID_BASE + 9999, "5@SMART");
  assert.equal(shown.length, 3);
});

test("link: background work waits its turn and is dropped with the connection", async (t) => {
  const world = new FakeTws();
  const link = makeLink(t, world, {}, 1000, 15);
  assert.equal(link.inBackground(() => undefined), false); // nothing to queue for before a connection
  link.start();
  await until(() => link.isReady(), "ready");

  const ran: string[] = [];
  assert.equal(link.inBackground(() => ran.push("a")), true);
  assert.equal(link.inBackground(() => ran.push("b")), true);
  assert.equal(ran.join(), ""); // never at once
  await until(() => ran.length === 1, "the first task");
  assert.equal(ran.join(), "a"); // one per gap
  await until(() => ran.length === 2, "the second task");

  // Queued, then the connection drops: the task is gone and does not run on the next connection.
  link.inBackground(() => ran.push("c"));
  world.drop();
  assert.equal(link.inBackground(() => ran.push("d")), false);
  await until(() => link.isReady(), "ready again");
  await sleep(50);
  assert.equal(ran.join(), "a,b");
});

test("link: a handler that throws is reported and stops nothing after it", async (t) => {
  const errors = t.mock.method(console, "error", () => undefined);
  const world = new FakeTws();
  const statuses: number[] = [];
  const failures: string[] = [];
  const link = makeLink(t, world, {
    onDisplayGroupShows: () => {
      throw new Error("a bug in the group report");
    },
    onOrderStatus: (event) => statuses.push(event.orderId),
    onNote: (kind, fields) => {
      if (kind === "internal_error") failures.push(`${String(fields["where"])}: ${String(fields["message"])}`);
    },
  });
  link.start();
  await until(() => link.isReady(), "ready");

  link.focus(1, 111); // the fake TWS answers the subscription, and the handler throws
  await until(() => failures.length >= 1, "the failure to be reported");
  assert.equal(failures[0], "the displayGroupUpdated event: a bug in the group report");
  assert.ok(errors.mock.callCount() >= 1);

  // The connection and everything after it carry on.
  assert.equal(link.isReady(), true);
  world.current.emit("orderStatus", 1000, "Filled", 100, 0, 2.5);
  assert.deepEqual(statuses, [1000]);
  assert.equal(link.allocateOrderIds(3), 1000);
  link.focus(1, 222);
  assert.equal(world.current.callsOf("updateDisplayGroup").length, 2);

  // A failing background task is reported the same way and the queue goes on.
  const ran: string[] = [];
  link.inBackground(() => {
    throw new Error("a bug in a background task");
  });
  link.inBackground(() => ran.push("next"));
  await until(() => ran.length === 1, "the task after the failing one");
  assert.ok(failures.includes("background task: a bug in a background task"));
});

test("link: events of a connection that was dropped are ignored", async (t) => {
  const world = new FakeTws();
  const statuses: number[] = [];
  const link = makeLink(t, world, { onOrderStatus: (event) => statuses.push(event.orderId) });
  link.start();
  await until(() => link.isReady(), "ready");
  const old = world.current;
  world.drop();
  await until(() => link.isReady(), "ready again");

  old.emit("orderStatus", 1000, "Filled", 100, 0, 2.5);
  old.emit("nextValidId", 999999);
  assert.deepEqual(statuses, []);
  assert.equal(link.allocateOrderIds(1), 1000);
});

test("the real library object: every call the bridge needs exists, and building it reads no .env", () => {
  const require = createRequire(import.meta.url);
  const loaded = (pkg: RegExp): boolean => Object.keys(require.cache).some((file) => pkg.test(file));
  const dotenvLoaded = (): boolean => loaded(/[\\/]node_modules[\\/]dotenv[\\/]/);
  // The check below means something only if this cache is the one the library was loaded into.
  assert.equal(loaded(/[\\/]node_modules[\\/]@stoqey[\\/]ib[\\/]/), true);
  assert.equal(dotenvLoaded(), false);

  // Built, never connected: no socket is opened here.
  const api = createIbApi({ host: "127.0.0.1", port: 7497, clientId: 77, maxReqPerSec: 40 }) as unknown as Record<
    string,
    unknown
  >;
  for (const name of [
    "connect",
    "disconnect",
    "reqContractDetails",
    "reqMktData",
    "cancelMktData",
    "placeOrder",
    "cancelOrder",
    "reqPositions",
    "cancelPositions",
    "queryDisplayGroups",
    "subscribeToGroupEvents",
    "updateDisplayGroup",
    "reqOpenOrders",
    "reqExecutions",
    "on",
    "removeAllListeners",
  ]) {
    assert.equal(typeof api[name], "function", name);
  }
  assert.equal(api["isConnected"], false);
  assert.equal(dotenvLoaded(), false);
});

// ------------------------------------------- what /chase and /sell read

test("link: the bid comes from the same plain snapshot, read for its own tick", async (t) => {
  const world = new FakeTws();
  world.asks.set("ABCD", 2.52);
  world.bids.set("ABCD", 2.47);
  const link = makeLink(t, world);
  link.start();
  await until(() => link.isReady(), "ready");

  assert.equal(await link.bidSnapshot(STOCK, 50), 2.47);
  assert.equal(await link.askSnapshot(STOCK, 50), 2.52); // the two never read each other's tick
  for (const call of world.current.callsOf("reqMktData")) {
    assert.deepEqual(call.args.slice(1), [STOCK, "", true, false]); // snapshot true, regulatorySnapshot false
  }

  // An ask alone is not a bid; nor is a delayed bid (tick type 66) or "no data".
  world.asks.clear();
  world.bids.clear();
  const pending = link.bidSnapshot(STOCK, 30);
  const reqId = world.current.callsOf("reqMktData")[2]?.args[0];
  world.current.emit("tickPrice", reqId, 2, 2.52);
  world.current.emit("tickPrice", reqId, 66, 2.47);
  world.current.emit("tickPrice", reqId, 1, -1);
  assert.equal(await pending, null);
  assert.deepEqual(world.current.callsOf("cancelMktData").map((call) => call.args), [[reqId]]);

  // TWS ending the snapshot without a bid is "none", at once.
  const ended = link.bidSnapshot(STOCK, 5000);
  world.current.emit("tickSnapshotEnd", world.current.callsOf("reqMktData")[3]?.args[0]);
  assert.equal(await ended, null);
});

test("link: positions are read fresh, up to TWS's end marker, and the stream is stopped again", async (t) => {
  const world = new FakeTws();
  world.positions.set(111, 100);
  world.positions.set(222, -5);
  world.otherPositions = [{ account: "DU7654321", conId: 111, shares: 30 }];
  const link = makeLink(t, world);
  link.start();
  await until(() => link.isReady(), "ready");

  assert.deepEqual(await link.positions(50), [
    { account: "DU1234567", conid: 111, position: 100 },
    { account: "DU1234567", conid: 222, position: -5 },
    { account: "DU7654321", conid: 111, position: 30 },
  ]);
  assert.equal(world.current.callsOf("reqPositions").length, 1);
  assert.equal(world.current.callsOf("cancelPositions").length, 1);

  // A second read asks TWS again: nothing is remembered from the first.
  world.positions.set(111, 40);
  assert.equal((await link.positions(50))[0]?.position, 40);
  assert.equal(world.current.callsOf("reqPositions").length, 2);

  // Two callers at the same moment share one request and one answer.
  const [a, b] = await Promise.all([link.positions(50), link.positions(50)]);
  assert.deepEqual(a, b);
  assert.equal(world.current.callsOf("reqPositions").length, 3);

  // A line whose number TWS left out is kept as "not a number", not dropped.
  world.otherPositions = [{ account: "DU1234567", conId: 333, shares: undefined }];
  const rows = await link.positions(50);
  assert.ok(Number.isNaN(rows.find((row) => row.conid === 333)?.position));

  // A position line with nobody asking (a late one, after the stream was stopped) is ignored.
  world.current.emit("position", "DU1234567", { conId: 111 }, 999, 0);
  world.current.emit("positionEnd");
  assert.equal(world.current.callsOf("cancelPositions").length, 4);
});

test("link: positions that do not come in time are an error, not an empty list", async (t) => {
  const world = new FakeTws();
  world.silentPositions = true;
  const link = makeLink(t, world);
  link.start();
  await until(() => link.isReady(), "ready");

  await assert.rejects(link.positions(20), (err: unknown) => err instanceof TwsTimeoutError && /within 20 ms/.test(err.message));
  assert.equal(world.current.callsOf("cancelPositions").length, 1);

  // Lines without the end marker are not an answer either.
  const partial = link.positions(20);
  world.current.emit("position", "DU1234567", { conId: 111 }, 100, 0);
  await assert.rejects(partial, TwsTimeoutError);

  const hanging = link.positions(5000);
  world.drop();
  await assert.rejects(hanging, NotConnectedError);
  await assert.rejects(async () => link.positions(50), NotConnectedError);
});

test("link: TWS's own report of an order is passed on only for this client's orders", async (t) => {
  const world = new FakeTws();
  const reports: unknown[] = [];
  const link = makeLink(t, world, { onOpenOrder: (event) => reports.push(event) });
  link.start();
  await until(() => link.isReady(), "ready");
  const ib = world.current;

  ib.emit("openOrder", 1000, STOCK, { action: "BUY", orderType: "LMT", totalQuantity: 100, lmtPrice: 2.53, clientId: 77 }, { status: "Submitted" });
  ib.emit("openOrder", 1002, STOCK, { action: "SELL", orderType: "STP LMT", totalQuantity: 100, lmtPrice: 2.37, auxPrice: 2.4, clientId: 77 }, {});
  // Another API client's order, an order typed into TWS (id 0), and one with no id at all.
  ib.emit("openOrder", 1000, STOCK, { action: "BUY", totalQuantity: 5, lmtPrice: 9, clientId: 5 }, {});
  ib.emit("openOrder", 0, STOCK, { action: "BUY", totalQuantity: 5, lmtPrice: 9, clientId: 77 }, {});
  ib.emit("openOrder", undefined, STOCK, { action: "BUY", totalQuantity: 5, lmtPrice: 9 }, {});
  // Prices TWS leaves out arrive as "no price", not as a number.
  ib.emit("openOrder", 1001, STOCK, { action: "SELL", totalQuantity: 100, lmtPrice: undefined, auxPrice: Number.NaN }, {});

  assert.deepEqual(reports, [
    { orderId: 1000, action: "BUY", totalQuantity: 100, lmtPrice: 2.53, auxPrice: null },
    { orderId: 1002, action: "SELL", totalQuantity: 100, lmtPrice: 2.37, auxPrice: 2.4 },
    { orderId: 1001, action: "SELL", totalQuantity: 100, lmtPrice: null, auxPrice: null },
  ]);
});

test("link: a change to an order goes out as the order itself again, and never while the connection is down", async (t) => {
  const world = new FakeTws();
  const link = makeLink(t, world);
  link.start();
  await until(() => link.isReady(), "ready");
  const id = link.allocateOrderIds(1);
  link.placeOrder(id, STOCK, BUY);
  link.modifyOrder(id, STOCK, { ...BUY, lmtPrice: 1.02 });
  assert.deepEqual(world.current.placed().map((p) => [p.id, p.order.lmtPrice]), [[id, 1]]);
  assert.deepEqual(world.current.modified().map((p) => [p.id, p.order.lmtPrice]), [[id, 1.02]]);

  world.drop();
  assert.throws(() => link.modifyOrder(id, STOCK, { ...BUY, lmtPrice: 1.05 }), NotConnectedError);
  await until(() => link.isReady(), "ready again");
  await sleep(20);
  assert.deepEqual(world.current.modified(), []); // nothing was kept for later
  assert.equal(world.allModified().length, 1);
});
