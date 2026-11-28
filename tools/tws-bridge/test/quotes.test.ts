import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { SecType } from "@stoqey/ib";
import type { Contract } from "@stoqey/ib";
import { NotConnectedError, REQUEST_ID_BASE, TwsLink } from "../src/link.js";
import type { LinkHandlers, QuoteField, QuoteListener } from "../src/link.js";
import { FakeTws, sleep, until } from "./fake-tws.js";

const ABCD: Contract = { conId: 111, symbol: "ABCD", secType: SecType.STK, exchange: "SMART", currency: "USD" };
const WXYZ: Contract = { conId: 222, symbol: "WXYZ", secType: SecType.STK, exchange: "SMART", currency: "USD" };

function makeLink(t: TestContext, world: FakeTws, handlers: LinkHandlers = {}): TwsLink {
  const link = new TwsLink({
    factory: world.factory,
    host: "127.0.0.1",
    port: 7497,
    clientId: 77,
    reconnectMinMs: 5,
    reconnectMaxMs: 20,
    handshakeTimeoutMs: 1000,
    backgroundGapMs: 1,
  });
  link.handlers = handlers;
  t.after(() => link.stop());
  return link;
}

async function connected(t: TestContext, world = new FakeTws(), handlers: LinkHandlers = {}): Promise<TwsLink> {
  const link = makeLink(t, world, handlers);
  link.start();
  await until(() => link.isReady(), "ready");
  return link;
}

/** A listener that writes down what it hears: "ask 2.52", "error 354 ...". */
function recorder(): QuoteListener & { heard: string[] } {
  const heard: string[] = [];
  return {
    heard,
    onPrice: (field: QuoteField, price: number) => heard.push(`${field} ${price}`),
    onError: (code: number, message: string) => heard.push(`error ${code} ${message}`),
  };
}

test("quotes: a plain stream (no snapshot, no regulatory snapshot); bid, ask and last arrive by field", async (t) => {
  const world = new FakeTws();
  const link = await connected(t, world);
  const quotes = recorder();

  const id = link.watchQuotes(ABCD, quotes);
  assert.ok(id >= REQUEST_ID_BASE);
  const call = world.current.callsOf("reqMktData")[0];
  assert.deepEqual(call?.args, [id, ABCD, "", false, false]);
  assert.deepEqual(world.streams(), [{ reqId: id, conId: 111, symbol: "ABCD" }]);

  assert.equal(world.tick(111, "bid", 2.5), 1);
  world.tick(111, "ask", 2.52);
  world.tick(111, "last", 2.51);
  world.tick(111, "ask", 2.53);
  assert.deepEqual(quotes.heard, ["bid 2.5", "ask 2.52", "last 2.51", "ask 2.53"]);
});

test("quotes: other tick types, the delayed ones, and -1 / 0 / NaN / Infinity are not prices", async (t) => {
  const world = new FakeTws();
  const link = await connected(t, world);
  const quotes = recorder();
  const id = link.watchQuotes(ABCD, quotes);
  const ib = world.current;

  ib.rawTick(id, 66, 2.4); // delayed bid
  ib.rawTick(id, 67, 2.42); // delayed ask
  ib.rawTick(id, 68, 2.41); // delayed last
  ib.rawTick(id, 6, 2.9); // the day's high
  ib.rawTick(id, 9, 2.1); // yesterday's close
  ib.rawTick(id, 14, 2.2); // the open
  world.tick(111, "bid", -1); // "no quote"
  world.tick(111, "ask", 0);
  world.tick(111, "last", Number.NaN);
  world.tick(111, "ask", Number.POSITIVE_INFINITY);
  assert.deepEqual(quotes.heard, []);

  // The stream is still open and still delivers.
  world.tick(111, "ask", 2.52);
  assert.deepEqual(quotes.heard, ["ask 2.52"]);
});

test("quotes: two streams on two contracts stay apart; two on one contract both hear it", async (t) => {
  const world = new FakeTws();
  const link = await connected(t, world);
  const a = recorder();
  const w = recorder();
  const a2 = recorder();
  const idA = link.watchQuotes(ABCD, a);
  const idW = link.watchQuotes(WXYZ, w);
  assert.notEqual(idA, idW);

  world.tick(111, "ask", 2.52);
  world.tick(222, "ask", 7.1);
  world.tick(222, "bid", 7.05);
  assert.deepEqual(a.heard, ["ask 2.52"]);
  assert.deepEqual(w.heard, ["ask 7.1", "bid 7.05"]);

  const idA2 = link.watchQuotes(ABCD, a2);
  assert.notEqual(idA2, idA);
  assert.equal(world.tick(111, "last", 2.55), 2);
  assert.deepEqual(a.heard, ["ask 2.52", "last 2.55"]);
  assert.deepEqual(a2.heard, ["last 2.55"]);

  // Ending one leaves the other on the same contract.
  link.unwatchQuotes(idA);
  world.tick(111, "last", 2.56);
  assert.deepEqual(a.heard, ["ask 2.52", "last 2.55"]);
  assert.deepEqual(a2.heard, ["last 2.55", "last 2.56"]);
});

test("quotes: a snapshot beside a stream of the same contract resolves, and the stream goes on", async (t) => {
  const world = new FakeTws();
  world.asks.set("ABCD", 2.52);
  world.bids.set("ABCD", 2.47);
  const link = await connected(t, world);
  const quotes = recorder();
  const id = link.watchQuotes(ABCD, quotes);

  assert.equal(await link.askSnapshot(ABCD, 50), 2.52);
  assert.equal(await link.bidSnapshot(ABCD, 50), 2.47);
  const calls = world.current.callsOf("reqMktData").map((call) => call.args.slice(1));
  assert.deepEqual(calls, [
    [ABCD, "", false, false],
    [ABCD, "", true, false],
    [ABCD, "", true, false],
  ]);
  // The snapshots' answers came under their own ids: the stream heard none of them.
  assert.deepEqual(quotes.heard, []);
  assert.deepEqual(world.current.callsOf("cancelMktData"), []);
  assert.deepEqual(world.streams().map((stream) => stream.reqId), [id]);

  // A snapshot that gets no answer is cancelled under its own id, not the stream's.
  world.asks.clear();
  world.bids.clear();
  assert.equal(await link.askSnapshot(ABCD, 20), null);
  const snapshotId = world.current.callsOf("reqMktData")[3]?.args[0];
  assert.deepEqual(world.current.callsOf("cancelMktData").map((call) => call.args), [[snapshotId]]);

  // A stream tick while a snapshot waits goes to the stream alone.
  const waiting = link.askSnapshot(ABCD, 30);
  world.tick(111, "ask", 2.6);
  assert.equal(await waiting, null);
  assert.deepEqual(quotes.heard, ["ask 2.6"]);
});

test("quotes: unwatchQuotes cancels the stream at TWS and nothing after it is delivered", async (t) => {
  const world = new FakeTws();
  const link = await connected(t, world);
  const quotes = recorder();
  const id = link.watchQuotes(ABCD, quotes);
  world.tick(111, "ask", 2.52);

  link.unwatchQuotes(id);
  assert.deepEqual(world.current.callsOf("cancelMktData").map((call) => call.args), [[id]]);
  assert.deepEqual(world.streams(), []);

  // A tick TWS had already sent before the cancel reached it.
  world.current.rawTick(id, 2, 2.53);
  assert.deepEqual(quotes.heard, ["ask 2.52"]);

  // A second unwatch of the same id sends nothing more.
  link.unwatchQuotes(id);
  assert.equal(world.current.callsOf("cancelMktData").length, 1);
});

test("quotes: unwatchQuotes of an unknown id, or with no connection, does nothing and never throws", async (t) => {
  const world = new FakeTws();
  const link = makeLink(t, world);
  link.unwatchQuotes(REQUEST_ID_BASE); // never connected
  link.start();
  await until(() => link.isReady(), "ready");

  link.unwatchQuotes(REQUEST_ID_BASE + 12345);
  link.unwatchQuotes(1000); // an order id, not a stream
  link.unwatchQuotes(Number.NaN);
  assert.deepEqual(world.current.callsOf("cancelMktData"), []);
  assert.deepEqual(world.current.callsOf("cancelOrder"), []);
});

test("quotes: watchQuotes throws NotConnectedError when TWS is not connected, and sends nothing", async (t) => {
  const world = new FakeTws();
  const link = makeLink(t, world);
  assert.throws(() => link.watchQuotes(ABCD, recorder()), NotConnectedError);
  assert.equal(world.instances.length, 0);

  link.start();
  await until(() => link.isReady(), "ready");
  world.mode = "refuse";
  world.drop();
  assert.throws(() => link.watchQuotes(ABCD, recorder()), NotConnectedError);
  await until(() => world.instances.length >= 2, "a reconnect attempt");
  for (const ib of world.instances) assert.deepEqual(ib.callsOf("reqMktData"), []);
});

test("quotes: an error from TWS ends the stream, tells the listener and the log", async (t) => {
  const world = new FakeTws();
  world.refusedStreams.set(222, { code: 354, message: "Requested market data is not subscribed." });
  const notes: Array<[string, Record<string, unknown>]> = [];
  const orderMessages: unknown[] = [];
  const link = await connected(t, world, {
    onNote: (kind, fields) => notes.push([kind, fields]),
    onOrderMessage: (event) => orderMessages.push(event),
  });

  // Refused at the start.
  const refused = recorder();
  const refusedId = link.watchQuotes(WXYZ, refused);
  await until(() => refused.heard.length === 1, "the refusal");
  assert.deepEqual(refused.heard, ["error 354 Requested market data is not subscribed."]);
  assert.deepEqual(notes, [
    ["quote_stream_error", { request_id: refusedId, code: 354, message: "Requested market data is not subscribed." }],
  ]);

  // Ended later, while it ran.
  const quotes = recorder();
  const id = link.watchQuotes(ABCD, quotes);
  world.tick(111, "ask", 2.52);
  world.current.streamError(id, 10197, "No market data during competing live session");
  assert.deepEqual(quotes.heard, ["ask 2.52", "error 10197 No market data during competing live session"]);
  assert.deepEqual(notes[1], [
    "quote_stream_error",
    { request_id: id, code: 10197, message: "No market data during competing live session" },
  ]);

  // The id is dead: a late tick under it is not delivered, a second error is not said again,
  // and unwatching it sends no cancel (TWS has already ended it).
  world.current.rawTick(id, 2, 2.53);
  world.current.emit("error", new Error("Requested market data is not subscribed."), 354, id);
  link.unwatchQuotes(id);
  link.unwatchQuotes(refusedId);
  assert.equal(quotes.heard.length, 2);
  assert.equal(notes.length, 2);
  assert.deepEqual(world.current.callsOf("cancelMktData"), []);
  // An error about a stream is never an error about an order.
  assert.deepEqual(orderMessages, []);
});

test("quotes: a warning from TWS about a stream leaves it open and is not reported", async (t) => {
  const world = new FakeTws();
  const notes: string[] = [];
  const link = await connected(t, world, { onNote: (kind) => notes.push(kind) });
  const quotes = recorder();
  const id = link.watchQuotes(ABCD, quotes);

  world.current.streamError(id, 10090, "Part of requested market data is not subscribed.");
  world.current.streamError(id, 2104, "Market data farm connection is OK:usfarm");
  world.current.streamError(id, 399, "Warning: something about the data");
  assert.deepEqual(world.streams().map((stream) => stream.reqId), [id]);

  world.tick(111, "bid", 2.5);
  assert.deepEqual(quotes.heard, ["bid 2.5"]);
  assert.deepEqual(notes, []);

  // A warning when the stream starts (the fake opens it anyway, as TWS does).
  world.refusedStreams.set(222, { code: 10090, message: "Part of requested market data is not subscribed." });
  const other = recorder();
  link.watchQuotes(WXYZ, other);
  await sleep(5);
  world.tick(222, "last", 7.1);
  assert.deepEqual(other.heard, ["last 7.1"]);
  assert.deepEqual(notes, []);
});

test("quotes: a drop forgets every stream silently; after the reconnect a new stream works", async (t) => {
  const world = new FakeTws();
  const notes: string[] = [];
  const link = await connected(t, world, { onNote: (kind) => notes.push(kind) });
  const quotes = recorder();
  const oldId = link.watchQuotes(ABCD, quotes);
  world.tick(111, "ask", 2.52);
  const old = world.current;

  world.drop();
  assert.deepEqual(quotes.heard, ["ask 2.52"]); // no error, no callback at the drop
  link.unwatchQuotes(oldId); // while down: nothing to send, no throw
  await until(() => link.isReady(), "ready again");
  assert.notEqual(world.current, old);

  // The old stream is gone: its connection's ticks are dropped, and so is its id on the new one.
  old.emit("tickPrice", oldId, 2, 2.6);
  world.current.rawTick(oldId, 2, 2.61);
  assert.equal(world.tick(111, "ask", 2.62), 0);
  link.unwatchQuotes(oldId);
  assert.deepEqual(old.callsOf("cancelMktData"), []);
  assert.deepEqual(world.current.callsOf("cancelMktData"), []);
  assert.deepEqual(quotes.heard, ["ask 2.52"]);
  assert.deepEqual(world.current.callsOf("reqMktData"), []); // nothing was asked again on its own

  // Asking again works, under a new id.
  const newId = link.watchQuotes(ABCD, quotes);
  assert.notEqual(newId, oldId);
  world.tick(111, "ask", 2.63);
  assert.deepEqual(quotes.heard, ["ask 2.52", "ask 2.63"]);
  link.unwatchQuotes(newId);
  assert.deepEqual(world.current.callsOf("cancelMktData").map((call) => call.args), [[newId]]);
  assert.deepEqual(notes.filter((kind) => kind === "quote_stream_error"), []);
});

test("quotes: a listener that throws is reported, and later ticks still arrive", async (t) => {
  const errors = t.mock.method(console, "error", () => undefined);
  const world = new FakeTws();
  const failures: string[] = [];
  const streamErrors: unknown[] = [];
  const link = await connected(t, world, {
    onNote: (kind, fields) => {
      if (kind === "internal_error") failures.push(`${String(fields["where"])}: ${String(fields["message"])}`);
      if (kind === "quote_stream_error") streamErrors.push(fields["request_id"]);
    },
  });

  const heard: string[] = [];
  const id = link.watchQuotes(ABCD, {
    onPrice: (field, price) => {
      heard.push(`${field} ${price}`);
      if (heard.length === 1) throw new Error("a bug in the watcher");
    },
    onError: () => {
      throw new Error("a bug in the watcher's error handling");
    },
  });
  const other = recorder();
  link.watchQuotes(WXYZ, other);

  world.tick(111, "ask", 2.52);
  world.tick(111, "ask", 2.53);
  world.tick(222, "bid", 7.05);
  assert.deepEqual(heard, ["ask 2.52", "ask 2.53"]);
  assert.deepEqual(other.heard, ["bid 7.05"]);
  assert.deepEqual(failures, ["the tickPrice event: a bug in the watcher"]);
  assert.ok(errors.mock.callCount() >= 1);
  assert.equal(link.isReady(), true);

  // An onError that throws: the stream is still over and the log still says so.
  world.current.streamError(id, 354, "Requested market data is not subscribed.");
  assert.deepEqual(streamErrors, [id]);
  assert.equal(failures[1], "the error event: a bug in the watcher's error handling");
  world.tick(111, "ask", 2.54);
  assert.equal(heard.length, 2);
  world.tick(222, "bid", 7.06);
  assert.deepEqual(other.heard, ["bid 7.05", "bid 7.06"]);
});
