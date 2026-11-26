import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { ConfigError, defaultConfig, loadOrCreateConfig, persistHalted, validateConfig } from "../src/config.js";
import type { Config } from "../src/config.js";

const TOKEN = "0123456789abcdef".repeat(4);

function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tws-bridge-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The defaults with one thing changed, as loose JSON. */
function withChange(change: (config: Record<string, any>) => void): unknown {
  const config = JSON.parse(JSON.stringify(defaultConfig(TOKEN))) as Record<string, any>;
  change(config);
  return config;
}

function problemsOf(raw: unknown): string[] {
  try {
    validateConfig(raw);
  } catch (err) {
    assert.ok(err instanceof ConfigError, String(err));
    return err.problems;
  }
  return [];
}

function assertRefused(raw: unknown, problem: RegExp): void {
  const problems = problemsOf(raw);
  assert.ok(
    problems.some((p) => problem.test(p)),
    `expected a problem matching ${problem}, got ${JSON.stringify(problems)}`,
  );
}

test("the defaults are a valid config with the documented values", () => {
  const config = validateConfig(JSON.parse(JSON.stringify(defaultConfig(TOKEN))));
  assert.deepEqual(config, defaultConfig(TOKEN));
  assert.deepEqual(config.tws, { host: "127.0.0.1", port: 7497, clientId: 77 });
  assert.deepEqual(config.http, { port: 8765 });
  assert.deepEqual(config.allowedOrigins, ["https://pnldash.uz", "http://localhost:5173"]);
  assert.equal(config.displayGroup, 1);
  assert.equal(config.paperOnly, true);
  assert.equal(config.enabled, true);
  assert.equal(config.halted, false);
  assert.deepEqual(config.order, {
    qty: 100,
    priceFrom: "alert",
    limitOffsetPct: 1,
    maxChasePct: 3,
    takeProfitPct: 10,
    stopPct: 5,
    stopLimitOffsetPct: 1,
    useAlertStop: true,
    outsideRth: true,
  });
  assert.deepEqual(config.limits, { maxShares: 500, maxNotionalUsd: 1000, maxOrdersPerDay: 20, duplicateWindowSec: 10 });
});

test("config.example.json is the defaults, and is refused as it stands (it has no token)", () => {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "config.example.json");
  const example = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  assert.equal(example["token"], "");
  assertRefused(example, /token is missing/);
  assert.deepEqual(validateConfig({ ...example, token: TOKEN }), defaultConfig(TOKEN));
});

test("nonsense is refused, each with its own line", () => {
  assertRefused(withChange((c) => (c.order.qty = -100)), /order\.qty must be at least 1/);
  assertRefused(withChange((c) => (c.order.qty = 1.5)), /order\.qty must be a whole number/);
  assertRefused(withChange((c) => (c.order.limitOffsetPct = -1)), /order\.limitOffsetPct must be at least 0/);
  assertRefused(withChange((c) => (c.order.takeProfitPct = -10)), /order\.takeProfitPct must be at least 0/);
  assertRefused(withChange((c) => (c.order.stopPct = -5)), /order\.stopPct must be at least 0/);
  assertRefused(withChange((c) => (c.order.stopPct = 100)), /order\.stopPct must be below 100/);
  assertRefused(withChange((c) => (c.order.stopLimitOffsetPct = -1)), /order\.stopLimitOffsetPct must be at least 0/);
  assertRefused(withChange((c) => (c.order.maxChasePct = -3)), /order\.maxChasePct must be at least 0/);
  assertRefused(withChange((c) => (c.order.priceFrom = "bid")), /order\.priceFrom must be "alert" or "ask"/);
  assertRefused(withChange((c) => (c.order.outsideRth = "yes")), /order\.outsideRth must be true or false/);
  assertRefused(withChange((c) => (c.limits.maxShares = 0)), /limits\.maxShares must be at least 1/);
  assertRefused(withChange((c) => (c.limits.maxNotionalUsd = -1000)), /limits\.maxNotionalUsd must be above 0/);
  assertRefused(withChange((c) => (c.limits.maxOrdersPerDay = -1)), /limits\.maxOrdersPerDay must be at least 0/);
  assertRefused(withChange((c) => (c.limits.duplicateWindowSec = -10)), /limits\.duplicateWindowSec must be at least 0/);
  assertRefused(withChange((c) => (c.limits.maxNotionalUsd = "1000")), /limits\.maxNotionalUsd must be a number/);
  assertRefused(withChange((c) => (c.tws.port = 0)), /tws\.port must be at least 1/);
  assertRefused(withChange((c) => (c.tws.port = 70000)), /tws\.port must be at most 65535/);
  assertRefused(withChange((c) => (c.tws.host = "")), /tws\.host/);
  assertRefused(withChange((c) => (c.displayGroup = 0)), /displayGroup must be at least 1/);
  assertRefused(withChange((c) => (c.paperOnly = "false")), /paperOnly must be true or false/);
  assertRefused(withChange((c) => (c.halted = 0)), /halted must be true or false/);
  assertRefused([], /must be an object/);
  assertRefused(null, /must be an object/);
});

test("a missing or malformed token is refused", () => {
  assertRefused(withChange((c) => delete c.token), /token is missing/);
  assertRefused(withChange((c) => (c.token = "")), /token is missing or not 64 hex characters/);
  assertRefused(withChange((c) => (c.token = "short")), /token is missing or not 64 hex characters/);
  assertRefused(withChange((c) => (c.token = 12345)), /token is missing or not 64 hex characters/);
});

test("the HTTP port may not clash with TWS's API ports", () => {
  assertRefused(withChange((c) => (c.http.port = 7497)), /http\.port \(7497\) clashes with tws\.port/);
  assertRefused(
    withChange((c) => {
      c.tws.port = 4002;
      c.http.port = 4002;
    }),
    /clashes with tws\.port/,
  );
  // The live TWS port while the bridge is pointed at paper: still not a place to listen.
  assertRefused(withChange((c) => (c.http.port = 7496)), /http\.port \(7496\) is one of the TWS/);
  assertRefused(withChange((c) => (c.http.port = 80)), /http\.port must be at least 1024/);
});

test("client id 0 (TWS's master id) is refused", () => {
  assertRefused(withChange((c) => (c.tws.clientId = 0)), /tws\.clientId must be at least 1/);
});

test("unknown and missing settings are refused, not guessed", () => {
  assertRefused(withChange((c) => (c.papperOnly = false)), /papperOnly is not a known setting/);
  assertRefused(withChange((c) => (c.limits.maxNotional = 500)), /limits\.maxNotional is not a known setting/);
  assertRefused(withChange((c) => delete c.paperOnly), /paperOnly is missing/);
  assertRefused(withChange((c) => delete c.limits.maxOrdersPerDay), /limits\.maxOrdersPerDay is missing/);
  assertRefused(withChange((c) => delete c.order), /order is missing/);
});

test("origins must be exact origins", () => {
  assertRefused(withChange((c) => (c.allowedOrigins = ["*"])), /is not an origin/);
  assertRefused(withChange((c) => (c.allowedOrigins = ["https://pnldash.uz/"])), /is not an origin/);
  assertRefused(withChange((c) => (c.allowedOrigins = ["pnldash.uz"])), /is not an origin/);
  assertRefused(withChange((c) => (c.allowedOrigins = "https://pnldash.uz")), /allowedOrigins must be a list/);
  assert.deepEqual(problemsOf(withChange((c) => (c.allowedOrigins = []))), []);
});

test("settings that would refuse every order are refused at the start", () => {
  assertRefused(withChange((c) => (c.order.limitOffsetPct = 4)), /limitOffsetPct \(4\) is above order\.maxChasePct \(3\)/);
  assertRefused(withChange((c) => (c.order.qty = 600)), /order\.qty \(600\) is above limits\.maxShares \(500\)/);
  // With priceFrom "ask" the offset is measured from the ask, so it may exceed maxChasePct.
  assert.deepEqual(
    problemsOf(
      withChange((c) => {
        c.order.priceFrom = "ask";
        c.order.limitOffsetPct = 4;
      }),
    ),
    [],
  );
});

test("every problem is reported in one go", () => {
  const problems = problemsOf(
    withChange((c) => {
      c.order.qty = -1;
      c.http.port = 7497;
      c.token = "";
    }),
  );
  assert.equal(problems.length, 3);
});

test("first start: config.json is created with a random token, owner-only", (t) => {
  const file = path.join(tempDir(t), "config.json");
  const first = loadOrCreateConfig(file);
  assert.equal(first.created, true);
  assert.match(first.config.token, /^[0-9a-f]{64}$/);
  assert.deepEqual({ ...first.config, token: TOKEN }, defaultConfig(TOKEN));
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  // The second start reads the same file back and does not touch it.
  const before = fs.readFileSync(file, "utf8");
  const second = loadOrCreateConfig(file);
  assert.equal(second.created, false);
  assert.equal(second.config.token, first.config.token);
  assert.equal(fs.readFileSync(file, "utf8"), before);

  // Another first start gets another token.
  const other = loadOrCreateConfig(path.join(tempDir(t), "config.json"));
  assert.notEqual(other.config.token, first.config.token);
});

test("a config.json that is broken is refused, never replaced", (t) => {
  const file = path.join(tempDir(t), "config.json");
  fs.writeFileSync(file, "{ not json");
  assert.throws(() => loadOrCreateConfig(file), (err: unknown) => err instanceof ConfigError && /not valid JSON/.test(err.message));
  assert.equal(fs.readFileSync(file, "utf8"), "{ not json");

  fs.writeFileSync(file, JSON.stringify(withChange((c) => (c.limits.maxShares = -5))));
  assert.throws(() => loadOrCreateConfig(file), ConfigError);
});

test("saving the halt switch changes only `halted` in the file on disk", (t) => {
  const file = path.join(tempDir(t), "config.json");
  const { config } = loadOrCreateConfig(file);

  // The owner edits the file by hand while the bridge runs.
  const edited = JSON.parse(fs.readFileSync(file, "utf8")) as Config;
  edited.limits.maxNotionalUsd = 250;
  fs.writeFileSync(file, JSON.stringify(edited, null, 2));

  persistHalted(file, true);
  const afterHalt = loadOrCreateConfig(file).config;
  assert.equal(afterHalt.halted, true);
  assert.equal(afterHalt.limits.maxNotionalUsd, 250);
  assert.equal(afterHalt.token, config.token);
  assert.equal(afterHalt.paperOnly, true);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(`${file}.tmp`), false);

  persistHalted(file, false);
  assert.equal(loadOrCreateConfig(file).config.halted, false);
});
