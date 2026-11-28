import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { AlertFeed, SINCE_OVERLAP_MS, SseParser } from "../src/feed.js";
import type { AlertFeedOptions, FeedSetup, FeedStatus, SseEvent } from "../src/feed.js";

const TOKEN = "feed-token-0123456789abcdef";
const TOKEN2 = "feed-token-fedcba9876543210";
const NOW = Date.parse("2026-11-30T09:00:00.000Z");

/** The setup from the server's description of the feed. */
const FFAI = {
  id: "FFAI:1795786264:tv_setup:pop:1",
  ticker: "FFAI",
  at: "2026-11-27T13:31:04.000Z",
  stage: "pop",
  price: 0.113,
  mode: "notify",
  why: null,
  setup: { stage: "pop", weak: false, vol_x: 27.6, tv_rv1: 48210 },
};

// ------------------------------------------------------------------ a feed server for the tests

interface Hit {
  /** 1 for the first request. */
  n: number;
  /** The request line's target, exactly as it arrived. */
  target: string;
  url: URL;
  since: string | null;
  auth: string | undefined;
  accept: string | undefined;
  res: http.ServerResponse;
  /** The feed went away (or the response ended). */
  closed: boolean;
  /** performance.now() when it arrived. */
  at: number;
}

async function feedServer(t: TestContext, handler: (hit: Hit) => void | Promise<void>): Promise<{ origin: string; hits: Hit[] }> {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    const target = req.url ?? "/";
    const url = new URL(target, "http://127.0.0.1");
    const hit: Hit = {
      n: hits.length + 1,
      target,
      url,
      since: url.searchParams.get("since"),
      auth: req.headers.authorization,
      accept: req.headers.accept,
      res,
      closed: false,
      at: performance.now(),
    };
    res.on("close", () => (hit.closed = true));
    hits.push(hit);
    void Promise.resolve()
      .then(() => handler(hit))
      .catch(() => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, hits };
}

function openStream(res: http.ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
  res.flushHeaders();
}

function hello(res: http.ServerResponse, replayed = 0): void {
  res.write(`event: hello\ndata: ${JSON.stringify({ now: new Date(NOW).toISOString(), replayed })}\n\n`);
}

function sendSetup(res: http.ServerResponse, setup: unknown): void {
  res.write(`event: setup\ndata: ${JSON.stringify(setup)}\n\n`);
}

function refuse(res: http.ServerResponse, status: number): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "the feed token is not valid" }));
}

// ------------------------------------------------------------------ the feed under test

interface FeedRig {
  feed: AlertFeed;
  setups: FeedSetup[];
  /** Every status handed to onState, in order. */
  states: FeedStatus[];
}

function makeFeed(t: TestContext, options: Partial<AlertFeedOptions> = {}): FeedRig {
  const setups: FeedSetup[] = [];
  const states: FeedStatus[] = [];
  const feed = new AlertFeed({
    clock: () => NOW,
    reconnectMinMs: 20,
    reconnectMaxMs: 80,
    idleTimeoutMs: 2000,
    ...options,
    onSetup: (setup) => {
      setups.push(setup);
      // Handed back as it is: a handler's promise is the feed's to look after.
      return options.onSetup?.(setup);
    },
    onState: (status) => {
      states.push(status);
      options.onState?.(status);
    },
  });
  t.after(() => {
    feed.stop();
    // At no point did the token reach a status.
    const seen = JSON.stringify([...states, feed.status()]);
    assert.equal(seen.includes(TOKEN) || seen.includes(TOKEN2), false, seen);
  });
  return { feed, setups, states };
}

async function waitFor(what: string, condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(2);
  }
}

function stateNames(states: FeedStatus[]): string[] {
  return states.map((status) => status.state);
}

// ------------------------------------------------------------------ connecting

test("hello → connected; the token goes in the Authorization header and nowhere in the URL", async (t) => {
  const { origin, hits } = await feedServer(t, (hit) => {
    openStream(hit.res);
    hello(hit.res);
  });
  const { feed, states } = makeFeed(t);
  assert.deepEqual(feed.status(), { state: "off", server: null, connected_at: null, last_event_at: null, error: null });

  feed.start(origin, TOKEN);
  assert.deepEqual(feed.status(), { state: "connecting", server: origin, connected_at: null, last_event_at: null, error: null });
  await waitFor("connected", () => feed.status().state === "connected");

  const iso = new Date(NOW).toISOString();
  assert.deepEqual(feed.status(), { state: "connected", server: origin, connected_at: iso, last_event_at: iso, error: null });
  assert.deepEqual(stateNames(states), ["connecting", "connected"]);

  assert.equal(hits.length, 1);
  const hit = hits[0]!;
  assert.equal(hit.auth, `Bearer ${TOKEN}`);
  assert.equal(hit.accept, "text/event-stream");
  assert.equal(hit.url.pathname, "/api/tv/feed");
  assert.deepEqual([...hit.url.searchParams.keys()], ["since"]);
  assert.equal(hit.target.includes(TOKEN), false);
  assert.equal(decodeURIComponent(hit.target).includes(TOKEN), false);
});

test("a server address with a trailing slash still asks for /api/tv/feed; a bad address or an empty token is refused at start()", async (t) => {
  const { origin, hits } = await feedServer(t, (hit) => {
    openStream(hit.res);
    hello(hit.res);
  });
  const { feed } = makeFeed(t);
  feed.start(`${origin}/`, TOKEN);
  await waitFor("connected", () => feed.status().state === "connected");
  assert.equal(hits[0]?.url.pathname, "/api/tv/feed");

  for (const server of ["ftp://example.com", "not a url", `${origin}/?x=1`, `http://user:${TOKEN}@127.0.0.1:1`]) {
    assert.throws(
      () => feed.start(server, TOKEN),
      (err: unknown) => err instanceof TypeError && !err.message.includes(TOKEN),
      server,
    );
  }
  assert.throws(() => feed.start(origin, ""), /the feed token is empty/);
  // A refused start() leaves the running connection alone.
  assert.equal(feed.status().state, "connected");
  assert.equal(hits.length, 1);
});

// ------------------------------------------------------------------ setups

test("a setup is delivered with all its fields; a price that is not a number is null", async (t) => {
  const { origin } = await feedServer(t, (hit) => {
    openStream(hit.res);
    hello(hit.res, 1);
    sendSetup(hit.res, FFAI);
    sendSetup(hit.res, { ...FFAI, id: "B", price: "0.12", mode: undefined, why: "cap reached", extra: 1 });
    sendSetup(hit.res, { ...FFAI, id: "C", price: null, mode: "quiet" });
    // One event's data over several lines: they join with "\n", which JSON reads as space.
    hit.res.write(`event: setup\ndata: {"id":"D","ticker":"ABCD",\ndata: "at":"2026-11-27T13:32:00.000Z","stage":"back",\ndata: "price":1.5,"mode":"log","setup":{}}\n\n`);
  });
  const { feed, setups } = makeFeed(t);
  feed.start(origin, TOKEN);
  await waitFor("four setups", () => setups.length === 4);

  assert.deepEqual(setups[0], FFAI);
  assert.deepEqual(setups[1], { ...FFAI, id: "B", price: null, mode: "unknown", why: "cap reached" });
  assert.deepEqual(setups[2], { ...FFAI, id: "C", price: null, mode: "quiet" });
  assert.deepEqual(setups[3], { id: "D", ticker: "ABCD", at: "2026-11-27T13:32:00.000Z", stage: "back", price: 1.5, mode: "log", why: null, setup: {} });
  assert.deepEqual(feed.counts, { connects: 1, setups: 4, dropped: 0, handlerErrors: 0 });
});

test("since: now − replaySec on the first connection, then a little before the newest setup delivered; a replayed setup is delivered again", async (t) => {
  const A = "2026-11-30T08:59:30.000Z";
  const { origin, hits } = await feedServer(t, (hit) => {
    openStream(hit.res);
    hello(hit.res);
    if (hit.n === 1) {
      sendSetup(hit.res, { ...FFAI, id: "A", at: A });
      // An older one after it (it should not happen, but it must not pull the replay point back).
      sendSetup(hit.res, { ...FFAI, id: "older", at: "2026-11-30T08:58:00.000Z" });
      hit.res.end();
    } else if (hit.n === 2) {
      // The replay after the reconnect starts with what was already delivered.
      sendSetup(hit.res, { ...FFAI, id: "A", at: A });
      hit.res.end();
    } else if (hit.n === 3) {
      hit.res.end();
    }
  });
  const clock = { now: NOW };
  const { feed, setups } = makeFeed(t, { clock: () => clock.now, replaySec: 300 });
  feed.start(origin, TOKEN);
  await waitFor("the first setups", () => setups.length === 2);
  clock.now = NOW + 60_000;
  await waitFor("four connections", () => hits.length === 4);

  assert.equal(hits[0]?.since, new Date(NOW - 300_000).toISOString());
  // Not A itself: the server replays what is strictly newer, and its times are whole seconds, so
  // another setup of A's own second would be lost. The overlap is told apart by id downstream.
  const beforeA = new Date(Date.parse(A) - SINCE_OVERLAP_MS).toISOString();
  assert.equal(hits[1]?.since, beforeA);
  assert.equal(hits[2]?.since, beforeA);
  assert.equal(hits[3]?.since, beforeA);
  assert.deepEqual(
    setups.map((setup) => setup.id),
    ["A", "older", "A"],
  );
});

test("the default replay is 120 s back from the clock at the time of the connection", async (t) => {
  const { origin, hits } = await feedServer(t, (hit) => {
    openStream(hit.res);
    hello(hit.res);
    if (hit.n === 1) hit.res.end();
  });
  const clock = { now: NOW };
  const { feed } = makeFeed(t, { clock: () => clock.now });
  feed.start(origin, TOKEN);
  await waitFor("the first connection", () => hits.length === 1);
  clock.now = NOW + 5000;
  await waitFor("the reconnect", () => hits.length === 2);
  assert.equal(hits[0]?.since, new Date(NOW - 120_000).toISOString());
  // No setup was delivered: the reconnect asks from its own now.
  assert.equal(hits[1]?.since, new Date(NOW + 5000 - 120_000).toISOString());
});

test("malformed setups are dropped without stopping the stream; unknown events are ignored", async (t) => {
  const bad: string[] = [
    "not json",
    "[]",
    '"a string"',
    "null",
    JSON.stringify({ ...FFAI, id: undefined }),
    JSON.stringify({ ...FFAI, id: 42 }),
    JSON.stringify({ ...FFAI, id: "" }),
    JSON.stringify({ ...FFAI, ticker: undefined }),
    JSON.stringify({ ...FFAI, ticker: ["FFAI"] }),
    JSON.stringify({ ...FFAI, stage: undefined }),
    JSON.stringify({ ...FFAI, at: "yesterday" }),
    JSON.stringify({ ...FFAI, at: undefined }),
    JSON.stringify({ ...FFAI, at: 1795786264 }),
    JSON.stringify({ ...FFAI, setup: undefined }),
    JSON.stringify({ ...FFAI, setup: [] }),
    JSON.stringify({ ...FFAI, setup: "pop" }),
    JSON.stringify({ ...FFAI, setup: null }),
  ];
  const { origin, hits } = await feedServer(t, (hit) => {
    openStream(hit.res);
    hello(hit.res);
    for (const data of bad) hit.res.write(`event: setup\ndata: ${data}\n\n`);
    // Not setups at all: another event name, the default "message" event, a setup with no data.
    hit.res.write(`event: other\ndata: ${JSON.stringify(FFAI)}\n\n`);
    hit.res.write(`data: ${JSON.stringify(FFAI)}\n\n`);
    hit.res.write("event: setup\n\n");
    sendSetup(hit.res, { ...FFAI, id: "good" });
  });
  const { feed, setups } = makeFeed(t);
  feed.start(origin, TOKEN);
  await waitFor("the good setup", () => setups.length === 1);
  await sleep(20);
  assert.deepEqual(
    setups.map((setup) => setup.id),
    ["good"],
  );
  assert.equal(feed.counts.dropped, bad.length);
  assert.equal(feed.status().state, "connected");
  assert.equal(hits.length, 1);
});

test("an onSetup that throws or rejects does not break the stream, and its message is scrubbed", async (t) => {
  const printed: string[] = [];
  t.mock.method(console, "error", (message: unknown) => printed.push(String(message)));
  let calls = 0;
  const { origin, hits } = await feedServer(t, (hit) => {
    openStream(hit.res);
    hello(hit.res);
    sendSetup(hit.res, { ...FFAI, id: "1" });
    sendSetup(hit.res, { ...FFAI, id: "2" });
    sendSetup(hit.res, { ...FFAI, id: "3" });
  });
  const { feed, setups } = makeFeed(t, {
    onSetup: (() => {
      calls++;
      if (calls === 1) throw new Error(`handler bug near ${TOKEN}`);
      if (calls === 2) return Promise.reject(new Error("async handler bug"));
      return undefined;
    }) as (setup: FeedSetup) => void,
  });
  feed.start(origin, TOKEN);
  await waitFor("three setups", () => setups.length === 3);
  await waitFor("two complaints", () => printed.length === 2);
  assert.deepEqual(
    setups.map((setup) => setup.id),
    ["1", "2", "3"],
  );
  assert.equal(feed.counts.handlerErrors, 2);
  assert.equal(feed.status().state, "connected");
  assert.equal(hits.length, 1);
  assert.match(printed[0] ?? "", /handler bug near \[redacted\]/);
  assert.match(printed[1] ?? "", /async handler bug/);
  assert.equal(printed.join("\n").includes(TOKEN), false);
});

test("an onState that throws does not break the feed", async (t) => {
  t.mock.method(console, "error", () => {});
  const { origin } = await feedServer(t, (hit) => {
    openStream(hit.res);
    hello(hit.res);
    sendSetup(hit.res, FFAI);
  });
  const { feed, setups } = makeFeed(t, {
    onState: () => {
      throw new Error("status handler bug");
    },
  });
  feed.start(origin, TOKEN);
  await waitFor("the setup", () => setups.length === 1);
  assert.equal(feed.status().state, "connected");
});

// ------------------------------------------------------------------ the bytes on the wire

test("chunks split mid-line, mid-event and mid-character are put back together", async (t) => {
  const why = "über 🚀 £5 — 引け";
  const payload = Buffer.from(
    `event: hello\ndata: {"now":"2026-11-30T09:00:00.000Z","replayed":0}\n\n` +
      `: keepalive\n\n` +
      `event: setup\ndata: ${JSON.stringify({ ...FFAI, why })}\n\n` +
      `event: setup\ndata: ${JSON.stringify({ ...FFAI, id: "second", ticker: "ÄBC" })}\n\n`,
  );
  const { origin } = await feedServer(t, async (hit) => {
    openStream(hit.res);
    // Three bytes at a time: every 4-byte emoji and many 2-byte letters are cut.
    for (let i = 0; i < payload.length; i += 3) {
      hit.res.write(payload.subarray(i, i + 3));
      await sleep(1);
    }
  });
  const { feed, setups } = makeFeed(t);
  feed.start(origin, TOKEN);
  await waitFor("both setups", () => setups.length === 2, 5000);
  assert.deepEqual(setups[0], { ...FFAI, why });
  assert.equal(setups[1]?.ticker, "ÄBC");
  assert.equal(feed.status().state, "connected");
});

test("CRLF line ends, one split between its CR and LF, and no space after the colon", async (t) => {
  const { origin } = await feedServer(t, async (hit) => {
    openStream(hit.res);
    hit.res.write("event:hello\r\ndata:{}\r\n\r\n");
    hit.res.write(`event:setup\r\ndata:${JSON.stringify(FFAI)}\r`);
    await sleep(15);
    hit.res.write("\n\r");
    await sleep(15);
    hit.res.write(`\nevent: setup\rdata: ${JSON.stringify({ ...FFAI, id: "cr" })}\r\r`);
  });
  const { feed, setups } = makeFeed(t);
  feed.start(origin, TOKEN);
  await waitFor("both setups", () => setups.length === 2);
  assert.deepEqual(setups[0], FFAI);
  assert.equal(setups[1]?.id, "cr");
  assert.equal(feed.status().state, "connected");
});

test("the parser gives the same events wherever the bytes are cut", () => {
  const text =
    `﻿: comment\r\nevent: hello\r\ndata: {"now":1}\r\n\r\n` +
    `event:setup\ndata:{"why":"über 🚀",\ndata: "n":2}\n\n` +
    `event: setup\rdata: x\r\r` +
    `data\n\n` +
    `event: lonely\n\n` +
    `event: cut\ndata: never ended`;
  const bytes = Buffer.from(text);
  const whole = parseBytes([bytes]);
  assert.deepEqual(whole.events, [
    { event: "hello", data: '{"now":1}' },
    { event: "setup", data: '{"why":"über 🚀",\n"n":2}' },
    { event: "setup", data: "x" },
    // A `data` line with no colon is an empty data field: dispatched with "" as the default event.
    { event: "message", data: "" },
  ]);
  assert.equal(whole.comments, 1);
  for (let cut = 1; cut < bytes.length; cut++) {
    assert.deepEqual(parseBytes([bytes.subarray(0, cut), bytes.subarray(cut)]), whole, `cut at byte ${cut}`);
  }
  for (let cut = 1; cut < bytes.length - 1; cut++) {
    assert.deepEqual(parseBytes([bytes.subarray(0, cut), bytes.subarray(cut, cut + 1), bytes.subarray(cut + 1)]), whole, `one byte alone at ${cut}`);
  }
  assert.deepEqual(parseBytes([...bytes].map((byte) => Buffer.from([byte]))), whole);
});

test("the parser refuses an event that never ends", () => {
  const parser = new SseParser();
  assert.throws(() => parser.push(`data: ${"x".repeat(1024 * 1024)}`), /longer than 1 MiB/);
  const many = new SseParser();
  assert.throws(() => {
    for (let i = 0; i < 2000; i++) many.push(`data: ${"y".repeat(1000)}\n`);
  }, /longer than 1 MiB/);
});

function parseBytes(chunks: Uint8Array[]): { events: SseEvent[]; comments: number } {
  const parser = new SseParser();
  const decoder = new TextDecoder();
  const events: SseEvent[] = [];
  for (const chunk of chunks) events.push(...parser.push(decoder.decode(chunk, { stream: true })));
  events.push(...parser.push(decoder.decode()));
  return { events, comments: parser.comments };
}

// ------------------------------------------------------------------ staying connected

test("keepalive comments hold the connection; silence makes it reconnect", async (t) => {
  let keepalives = 0;
  const { origin, hits } = await feedServer(t, async (hit) => {
    openStream(hit.res);
    hello(hit.res);
    if (hit.n !== 1) return;
    for (let i = 0; i < 12; i++) {
      await sleep(25);
      if (hit.closed) return;
      clock.now += 1000;
      hit.res.write(": keepalive\n\n");
      keepalives++;
    }
    // Then nothing, with the connection left open.
  });
  const clock = { now: NOW };
  const { feed, states } = makeFeed(t, { clock: () => clock.now, idleTimeoutMs: 150 });
  feed.start(origin, TOKEN);
  await waitFor("the keepalives", () => keepalives === 12);
  // 300 ms of keepalives, twice the idle limit: still the first connection.
  assert.equal(hits.length, 1);
  assert.equal(feed.status().state, "connected");
  await waitFor("the last keepalive to arrive", () => feed.status().last_event_at === new Date(NOW + 12_000).toISOString());

  const quietFrom = performance.now();
  await waitFor("the reconnect", () => hits.length === 2);
  assert.ok(performance.now() - quietFrom >= 120, "it waited for the idle limit");
  await waitFor("the silent connection to be dropped", () => hits[0]!.closed);
  await waitFor("connected again", () => feed.status().state === "connected");
  assert.deepEqual(stateNames(states), ["connecting", "connected", "retrying", "connected"]);
  assert.equal(states[2]?.error, "nothing arrived for 150 ms");
  assert.equal(states[2]?.connected_at, null);
});

test("a server that takes the connection and never answers is silence too", async (t) => {
  const { origin, hits } = await feedServer(t, (hit) => {
    if (hit.n === 1) return;
    openStream(hit.res);
    hello(hit.res);
  });
  const { feed, states } = makeFeed(t, { idleTimeoutMs: 60 });
  feed.start(origin, TOKEN);
  await waitFor("connected on the second try", () => feed.status().state === "connected");
  assert.equal(hits.length, 2);
  assert.ok(hits[0]!.closed);
  assert.deepEqual(stateNames(states), ["connecting", "retrying", "connected"]);
  assert.equal(states[1]?.error, "nothing arrived for 60 ms");
});

test("a stream the server ends: retrying, then connected again; the pause doubles up to the most and starts over after a hello", async (t) => {
  const delays: Array<number | null> = [];
  let feedRef: AlertFeed | null = null;
  const { origin, hits } = await feedServer(t, (hit) => {
    delays.push(feedRef!.retryDelayMs);
    openStream(hit.res);
    if (hit.n <= 4) {
      hit.res.end();
    } else if (hit.n === 5) {
      hello(hit.res);
      hit.res.end();
    } else {
      hello(hit.res);
    }
  });
  const { feed, states } = makeFeed(t, { reconnectMinMs: 20, reconnectMaxMs: 80 });
  feedRef = feed;
  feed.start(origin, TOKEN);
  await waitFor("six connections", () => hits.length === 6);
  await waitFor("connected", () => feed.status().state === "connected");

  assert.deepEqual(delays, [null, 20, 40, 80, 80, 20]);
  for (let i = 1; i < hits.length; i++) {
    const gap = hits[i]!.at - hits[i - 1]!.at;
    assert.ok(gap >= (delays[i] as number) - 2, `the pause before connection ${i + 1} was ${gap.toFixed(1)} ms, expected ${delays[i]}`);
  }
  // The same reason again is not a change: one "retrying" per spell of failures.
  assert.deepEqual(stateNames(states), ["connecting", "retrying", "connected", "retrying", "connected"]);
  assert.equal(states[1]?.error, "the server closed the stream");
  assert.equal(states[3]?.error, "the server closed the stream");
  assert.equal(feed.status().error, null);
  assert.equal(feed.counts.connects, 6);
});

test("HTTP 500 and an answer that is not an event stream are retried", async (t) => {
  const { origin, hits } = await feedServer(t, (hit) => {
    if (hit.n === 1) {
      hit.res.writeHead(500, { "content-type": "application/json" });
      hit.res.end('{"error":"boom"}');
    } else if (hit.n === 2) {
      hit.res.writeHead(200, { "content-type": "text/html" });
      hit.res.end("<html>a login page</html>");
    } else {
      openStream(hit.res);
      hello(hit.res);
    }
  });
  const { feed, states } = makeFeed(t);
  feed.start(origin, TOKEN);
  await waitFor("connected", () => feed.status().state === "connected");
  assert.equal(hits.length, 3);
  assert.deepEqual(
    states.map((status) => [status.state, status.error]),
    [
      ["connecting", null],
      ["retrying", "the server answered HTTP 500"],
      ["retrying", "the server did not answer with an event stream (text/html)"],
      ["connected", null],
    ],
  );
});

test("a redirect is not followed: the token is for that server only", async (t) => {
  const other = await feedServer(t, (hit) => {
    openStream(hit.res);
    hello(hit.res);
  });
  const { origin, hits } = await feedServer(t, (hit) => {
    hit.res.writeHead(302, { location: `${other.origin}/api/tv/feed` });
    hit.res.end();
  });
  const { feed } = makeFeed(t, { reconnectMinMs: 1000 });
  feed.start(origin, TOKEN);
  await waitFor("retrying", () => feed.status().state === "retrying");
  assert.equal(feed.status().error, "the server answered HTTP 302");
  assert.equal(hits.length, 1);
  assert.equal(other.hits.length, 0);
});

test("HTTP 401 or 403: unauthorized, and no request after it until start() is called again", async (t) => {
  const { origin, hits } = await feedServer(t, (hit) => {
    if (hit.n === 1) refuse(hit.res, 401);
    else if (hit.n === 2) refuse(hit.res, 403);
    else {
      openStream(hit.res);
      hello(hit.res);
    }
  });
  const { feed, states } = makeFeed(t, { reconnectMinMs: 5, reconnectMaxMs: 5 });
  feed.start(origin, TOKEN);
  await waitFor("unauthorized", () => feed.status().state === "unauthorized");
  assert.deepEqual(feed.status(), {
    state: "unauthorized",
    server: origin,
    connected_at: null,
    last_event_at: null,
    error: "the server refused the feed token (HTTP 401)",
  });
  await sleep(80);
  assert.equal(hits.length, 1);
  assert.equal(feed.counts.connects, 1);

  // A new token: tried at once.
  feed.start(origin, TOKEN2);
  await waitFor("refused again", () => hits.length === 2 && feed.status().state === "unauthorized");
  assert.equal(hits[1]?.auth, `Bearer ${TOKEN2}`);
  assert.equal(feed.status().error, "the server refused the feed token (HTTP 403)");
  await sleep(80);
  assert.equal(hits.length, 2);

  // The same pair again after a refusal is a new try too (pairing again with the same token).
  feed.start(origin, TOKEN2);
  await waitFor("connected", () => feed.status().state === "connected");
  assert.equal(hits.length, 3);
  assert.deepEqual(stateNames(states), ["connecting", "unauthorized", "connecting", "unauthorized", "connecting", "connected"]);
});

// ------------------------------------------------------------------ start() and stop()

test("start() again with the same pair while running is the same connection", async (t) => {
  const { origin, hits } = await feedServer(t, (hit) => {
    openStream(hit.res);
    hello(hit.res);
  });
  const { feed, states } = makeFeed(t);
  feed.start(origin, TOKEN);
  feed.start(origin, TOKEN);
  await waitFor("connected", () => feed.status().state === "connected");
  feed.start(origin, TOKEN);
  await sleep(50);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.closed, false);
  assert.deepEqual(stateNames(states), ["connecting", "connected"]);
});

test("start() with a new token drops the old connection first; a new server starts its replay afresh", async (t) => {
  const A = "2026-11-30T08:59:45.000Z";
  const { origin, hits } = await feedServer(t, (hit) => {
    openStream(hit.res);
    hello(hit.res);
    if (hit.n === 1) sendSetup(hit.res, { ...FFAI, at: A });
  });
  const second = await feedServer(t, (hit) => {
    openStream(hit.res);
    hello(hit.res);
  });
  const { feed, setups, states } = makeFeed(t);
  feed.start(origin, TOKEN);
  await waitFor("the setup", () => setups.length === 1);

  feed.start(origin, TOKEN2);
  assert.equal(feed.status().state, "connecting");
  await waitFor("the new connection", () => hits.length === 2);
  await waitFor("the old one dropped", () => hits[0]!.closed);
  await waitFor("connected", () => feed.status().state === "connected");
  assert.equal(hits[1]?.auth, `Bearer ${TOKEN2}`);
  // The same server: the replay goes on from (a little before) the last setup delivered.
  assert.equal(hits[1]?.since, new Date(Date.parse(A) - SINCE_OVERLAP_MS).toISOString());
  assert.equal(hits[1]?.closed, false);

  feed.start(second.origin, TOKEN2);
  await waitFor("connected to the other server", () => feed.status().state === "connected" && feed.status().server === second.origin);
  await waitFor("the first server's connection dropped", () => hits[1]!.closed);
  assert.equal(second.hits[0]?.since, new Date(NOW - 120_000).toISOString());
  assert.deepEqual(stateNames(states), ["connecting", "connected", "connecting", "connected", "connecting", "connected"]);
  assert.equal(hits.length, 2);
});

test("stop() leaves nothing running: while connected, while waiting to retry, and while the request hangs", async (t) => {
  // Connected.
  const live = await feedServer(t, (hit) => {
    openStream(hit.res);
    hello(hit.res);
  });
  const a = makeFeed(t);
  a.feed.start(live.origin, TOKEN);
  await waitFor("connected", () => a.feed.status().state === "connected");
  a.feed.stop();
  assert.deepEqual(a.feed.status(), { state: "off", server: null, connected_at: null, last_event_at: null, error: null });
  await waitFor("the connection closed", () => live.hits[0]!.closed);
  a.feed.stop();
  assert.deepEqual(stateNames(a.states), ["connecting", "connected", "off"]);

  // Waiting to retry.
  const ending = await feedServer(t, (hit) => {
    openStream(hit.res);
    hit.res.end();
  });
  const b = makeFeed(t, { reconnectMinMs: 30 });
  b.feed.start(ending.origin, TOKEN);
  await waitFor("retrying", () => b.feed.status().state === "retrying");
  b.feed.stop();
  assert.equal(b.feed.status().state, "off");

  // A request the server never answers.
  const hanging = await feedServer(t, () => {});
  const c = makeFeed(t);
  c.feed.start(hanging.origin, TOKEN);
  await waitFor("the request", () => hanging.hits.length === 1);
  c.feed.stop();
  await waitFor("the request dropped", () => hanging.hits[0]!.closed);
  assert.equal(c.feed.status().state, "off");

  // Stopped while refused, too.
  const refusing = await feedServer(t, (hit) => refuse(hit.res, 401));
  const d = makeFeed(t);
  d.feed.start(refusing.origin, TOKEN);
  await waitFor("unauthorized", () => d.feed.status().state === "unauthorized");
  d.feed.stop();
  assert.equal(d.feed.status().state, "off");

  await sleep(100);
  assert.equal(live.hits.length, 1);
  assert.equal(ending.hits.length, 1);
  assert.equal(hanging.hits.length, 1);
  assert.equal(refusing.hits.length, 1);
});

test("an onSetup or onState that calls stop() ends the feed there", async (t) => {
  const { origin, hits } = await feedServer(t, (hit) => {
    openStream(hit.res);
    hello(hit.res);
    sendSetup(hit.res, { ...FFAI, id: "1" });
    sendSetup(hit.res, { ...FFAI, id: "2" });
  });
  let feedRef: AlertFeed | null = null;
  const { feed, setups } = makeFeed(t, { onSetup: () => feedRef!.stop() });
  feedRef = feed;
  feed.start(origin, TOKEN);
  await waitFor("the first setup", () => setups.length === 1);
  await waitFor("dropped", () => hits[0]!.closed);
  await sleep(40);
  assert.equal(setups.length, 1);
  assert.equal(feed.status().state, "off");
  assert.equal(hits.length, 1);

  const ending = await feedServer(t, (hit) => {
    openStream(hit.res);
    hit.res.end();
  });
  let otherRef: AlertFeed | null = null;
  const other = makeFeed(t, { onState: (status) => status.state === "retrying" && otherRef!.stop() });
  otherRef = other.feed;
  other.feed.start(ending.origin, TOKEN);
  await waitFor("off", () => other.feed.status().state === "off");
  await sleep(60);
  assert.equal(ending.hits.length, 1);
});

// ------------------------------------------------------------------ the token

test("the token never reaches the status or an error, also when a failure's own text carries it", async (t) => {
  const failing = makeFeed(t, {
    reconnectMinMs: 1000,
    fetch: (async () => {
      throw new TypeError("fetch failed", { cause: new Error(`connect refused for Bearer ${TOKEN}`) });
    }) as typeof fetch,
  });
  failing.feed.start("http://127.0.0.1:9", TOKEN);
  await waitFor("retrying", () => failing.feed.status().state === "retrying");
  assert.equal(failing.feed.status().error, "cannot reach the server (connect refused for Bearer [redacted])");

  // A port nobody listens on.
  const closed = http.createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const { port } = closed.address() as AddressInfo;
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  const refused = makeFeed(t, { reconnectMinMs: 1000 });
  refused.feed.start(`http://127.0.0.1:${port}`, TOKEN);
  await waitFor("retrying", () => refused.feed.status().state === "retrying");
  assert.match(refused.feed.status().error ?? "", /^cannot reach the server \(.*ECONNREFUSED.*\)$/);

  for (const status of [...failing.states, ...refused.states, failing.feed.status(), refused.feed.status()]) {
    assert.equal(JSON.stringify(status).includes(TOKEN), false);
  }
});
