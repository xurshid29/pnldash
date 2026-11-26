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

function makeLink(t: TestContext, world: FakeTws, handlers: LinkHandlers = {}, handshakeTimeoutMs = 1000): TwsLink {
  const link = new TwsLink({
    factory: world.factory,
    host: "127.0.0.1",
    port: 7497,
    clientId: 77,
    reconnectMinMs: 5,
    reconnectMaxMs: 20,
    handshakeTimeoutMs,
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
