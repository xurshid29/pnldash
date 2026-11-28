import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { defaultState, isFeedServer, isFeedToken, loadState, saveState } from "../src/state.js";
import type { BridgeState } from "../src/state.js";

const FEED_TOKEN = "feed-token-9f8e7d6c5b4a3210";

function stateFile(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tws-bridge-state-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "state.json");
}

/** Writes `value` as the file and loads it back. */
function loadRaw(file: string, value: unknown): ReturnType<typeof loadState> {
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return loadState(file);
}

const PAIRED: BridgeState = { auto: { mode: "watch" }, feed: { server: "https://pnldash.uz", token: FEED_TOKEN } };

test("the defaults: automatic mode off, no feed", () => {
  assert.deepEqual(defaultState(), { auto: { mode: "off" }, feed: null });
  // A fresh object each time: changing one does not change the next.
  const one = defaultState();
  one.auto.mode = "on";
  assert.equal(defaultState().auto.mode, "off");
});

test("a missing file is the defaults, with no problem, and is not created", (t) => {
  const file = stateFile(t);
  assert.deepEqual(loadState(file), { state: defaultState(), problem: null });
  assert.equal(fs.existsSync(file), false);
});

test("what is saved loads back, owner-only, with no temp file left", (t) => {
  const file = stateFile(t);
  saveState(file, PAIRED);
  assert.deepEqual(loadState(file), { state: PAIRED, problem: null });
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(`${file}.tmp`), false);

  // Saving again replaces the file, and a temp file left by a crash does not get in the way.
  fs.writeFileSync(`${file}.tmp`, "torn");
  saveState(file, { auto: { mode: "on" }, feed: null });
  assert.deepEqual(loadState(file), { state: { auto: { mode: "on" }, feed: null }, problem: null });
  assert.equal(fs.existsSync(`${file}.tmp`), false);

  for (const mode of ["off", "watch", "on"] as const) {
    saveState(file, { auto: { mode }, feed: PAIRED.feed });
    assert.equal(loadState(file).state.auto.mode, mode);
  }
});

test("a state that would not load back is refused by saveState, and the file is kept", (t) => {
  const file = stateFile(t);
  saveState(file, PAIRED);
  const before = fs.readFileSync(file, "utf8");
  const bad = [
    { auto: { mode: "yes" }, feed: null },
    { auto: { mode: "on" }, feed: { server: "https://pnldash.uz/api", token: FEED_TOKEN } },
    { auto: { mode: "on" }, feed: { server: "https://pnldash.uz", token: "" } },
  ];
  for (const state of bad) {
    assert.throws(
      () => saveState(file, state as unknown as BridgeState),
      (err: unknown) => err instanceof Error && /was not saved/.test(err.message) && !err.message.includes(FEED_TOKEN),
    );
  }
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("saveState writes only the known parts", (t) => {
  const file = stateFile(t);
  saveState(file, { ...PAIRED, extra: 1, feed: { ...PAIRED.feed!, more: 2 } } as unknown as BridgeState);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), PAIRED);
});

test("saveState throws when the file cannot be written", (t) => {
  const file = stateFile(t);
  assert.throws(() => saveState(path.join(file, "no-such-dir", "state.json"), PAIRED));
});

test("a file that is not JSON gives the defaults and a problem, and is left as it is", (t) => {
  const file = stateFile(t);
  const text = `{ "feed": { "server": "https://pnldash.uz", "token": "${FEED_TOKEN}" `;
  const { state, problem } = loadRaw(file, text);
  assert.deepEqual(state, defaultState());
  assert.equal(problem, "state.json is not valid JSON");
  assert.equal(fs.readFileSync(file, "utf8"), text);
});

test("a file that cannot be read gives the defaults and a problem", (t) => {
  const file = stateFile(t);
  fs.mkdirSync(file);
  const { state, problem } = loadState(file);
  assert.deepEqual(state, defaultState());
  assert.match(problem ?? "", /^state\.json cannot be read \(EISDIR\)$/);
});

test("a file that is not an object gives the defaults and a problem", (t) => {
  const file = stateFile(t);
  for (const value of ["[]", "null", "42", '"on"']) {
    const { state, problem } = loadRaw(file, value);
    assert.deepEqual(state, defaultState(), value);
    assert.equal(problem, "state.json: it does not hold a JSON object", value);
  }
});

test("a wrong automatic mode is off, with a problem; the feed beside it is kept", (t) => {
  const file = stateFile(t);
  for (const auto of [{ mode: "yes" }, { mode: "ON" }, { mode: true }, {}, "on", null, []]) {
    const { state, problem } = loadRaw(file, { auto, feed: PAIRED.feed });
    assert.deepEqual(state, { auto: { mode: "off" }, feed: PAIRED.feed }, JSON.stringify(auto));
    assert.ok(problem !== null && /^state\.json: auto(\.mode)? must be/.test(problem), `${JSON.stringify(auto)}: ${problem}`);
  }
});

test("a wrong feed is null, with a problem that never quotes the token; the mode beside it is kept", (t) => {
  const file = stateFile(t);
  const cases: Array<[unknown, RegExp]> = [
    [{ server: "https://pnldash.uz/", token: FEED_TOKEN }, /feed\.server is not an http\(s\) origin/],
    [{ server: "https://pnldash.uz/api/tv/feed", token: FEED_TOKEN }, /feed\.server is not an http\(s\) origin/],
    [{ server: "ftp://pnldash.uz", token: FEED_TOKEN }, /feed\.server is not an http\(s\) origin/],
    [{ server: "pnldash.uz", token: FEED_TOKEN }, /feed\.server is not an http\(s\) origin/],
    [{ server: "https://user:pass@pnldash.uz", token: FEED_TOKEN }, /feed\.server is not an http\(s\) origin/],
    [{ server: FEED_TOKEN, token: FEED_TOKEN }, /feed\.server is not an http\(s\) origin/],
    [{ token: FEED_TOKEN }, /feed\.server/],
    [{ server: "https://pnldash.uz", token: "" }, /feed\.token is not a string of 1 to 2048 characters/],
    [{ server: "https://pnldash.uz", token: "x".repeat(2049) }, /feed\.token/],
    [{ server: "https://pnldash.uz", token: 12345678 }, /feed\.token/],
    [{ server: "https://pnldash.uz" }, /feed\.token/],
    [FEED_TOKEN, /feed must be an object or null/],
    [[], /feed must be an object or null/],
  ];
  for (const [feed, expected] of cases) {
    const { state, problem } = loadRaw(file, { auto: { mode: "watch" }, feed });
    assert.deepEqual(state, { auto: { mode: "watch" }, feed: null }, JSON.stringify(feed));
    assert.ok(problem !== null && expected.test(problem), `${JSON.stringify(feed)}: ${problem}`);
    assert.equal(problem.includes(FEED_TOKEN), false);
  }

  // Both parts wrong: both are named, in one line.
  const both = loadRaw(file, { auto: { mode: "always" }, feed: { server: "x", token: "" } });
  assert.deepEqual(both.state, defaultState());
  assert.equal(
    both.problem,
    'state.json: auto.mode must be "off", "watch" or "on"; feed.server is not an http(s) origin (scheme://host[:port], no path); feed.token is not a string of 1 to 2048 characters',
  );
});

test("origins with a port, http, and a 2048-character token are taken", (t) => {
  const file = stateFile(t);
  const feed = { server: "http://127.0.0.1:3000", token: "t".repeat(2048) };
  assert.deepEqual(loadRaw(file, { auto: { mode: "on" }, feed }), { state: { auto: { mode: "on" }, feed }, problem: null });
  assert.equal(isFeedServer("https://pnldash.uz:8443"), true);
  assert.equal(isFeedServer("https://PNLDASH.uz"), false);
  assert.equal(isFeedServer("https://pnldash.uz:443"), false);
  assert.equal(isFeedToken("a"), true);
  assert.equal(isFeedToken(null), false);
});

test("missing parts take their default quietly, unknown keys are ignored, and feed may be null", (t) => {
  const file = stateFile(t);
  assert.deepEqual(loadRaw(file, {}), { state: defaultState(), problem: null });
  assert.deepEqual(loadRaw(file, { auto: { mode: "on" } }), { state: { auto: { mode: "on" }, feed: null }, problem: null });
  assert.deepEqual(loadRaw(file, { feed: PAIRED.feed }), { state: { auto: { mode: "off" }, feed: PAIRED.feed }, problem: null });
  assert.deepEqual(loadRaw(file, { auto: { mode: "watch" }, feed: null }), { state: { auto: { mode: "watch" }, feed: null }, problem: null });
  assert.deepEqual(
    loadRaw(file, { version: 3, auto: { mode: "on", since: "x" }, feed: { ...PAIRED.feed, paired_at: "2026-11-28" }, later: [] }),
    { state: { auto: { mode: "on" }, feed: PAIRED.feed }, problem: null },
  );
});
