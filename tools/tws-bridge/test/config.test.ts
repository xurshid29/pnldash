import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  AUTO_DEFAULTS,
  autoSlots,
  ConfigError,
  defaultConfig,
  loadOrCreateConfig,
  minutesOfDay,
  persistHalted,
  validateConfig,
} from "../src/config.js";
import type { AutoConfig, Config } from "../src/config.js";

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
    maxChases: 5,
    sellOffsetPct: 2,
    amountUsd: 0,
    askFallback: "alert",
    entryStopPct: 3,
    entryStopLimitPct: 1,
    entryValidSec: 300,
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

// ------------------------------------------ settings newer than the file

/** The settings added after the first config.json files were written, with their defaults. */
const NEWER = {
  maxChases: 5,
  sellOffsetPct: 2,
  amountUsd: 0,
  askFallback: "alert",
  entryStopPct: 3,
  entryStopLimitPct: 1,
  entryValidSec: 300,
} as const;

test("a config.json written before the newer settings existed still loads, each of them at its default", (t) => {
  const old = withChange((c) => {
    for (const key of Object.keys(NEWER)) delete c.order[key];
  }) as Record<string, any>;
  assert.deepEqual(Object.keys(old["order"]), [
    "qty",
    "priceFrom",
    "limitOffsetPct",
    "maxChasePct",
    "takeProfitPct",
    "stopPct",
    "stopLimitOffsetPct",
    "useAlertStop",
    "outsideRth",
  ]);
  assert.deepEqual(problemsOf(old), []);
  assert.deepEqual(validateConfig(old), defaultConfig(TOKEN));
  assert.deepEqual(
    Object.fromEntries(Object.keys(NEWER).map((key) => [key, (validateConfig(old).order as unknown as Record<string, unknown>)[key]])),
    NEWER,
  );

  // From the file on disk, as the running installation has it: it loads, and is not rewritten.
  const file = path.join(tempDir(t), "config.json");
  fs.writeFileSync(file, `${JSON.stringify(old, null, 2)}\n`, { mode: 0o600 });
  const before = fs.readFileSync(file, "utf8");
  const loaded = loadOrCreateConfig(file);
  assert.equal(loaded.created, false);
  assert.deepEqual(loaded.config, defaultConfig(TOKEN));
  assert.equal(fs.readFileSync(file, "utf8"), before);

  // Saving the halt switch leaves it loadable, and still does not write the newer settings in.
  persistHalted(file, true);
  assert.equal(loadOrCreateConfig(file).config.halted, true);
  assert.deepEqual(Object.keys((JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, any>)["order"]), Object.keys(old["order"]));

  // Any one of them may be there without the others.
  for (const [key, value] of [["maxChases", 3], ["sellOffsetPct", 1.5], ["amountUsd", 400], ["askFallback", "none"]] as const) {
    const some = JSON.parse(JSON.stringify(old)) as Record<string, any>;
    some["order"][key] = value;
    assert.deepEqual(validateConfig(some).order, { ...defaultConfig(TOKEN).order, [key]: value });
  }
});

test("only the newer settings may be missing: the others are still required, and a typo is still refused", () => {
  assertRefused(withChange((c) => delete c.order.stopPct), /order\.stopPct is missing/);
  assertRefused(withChange((c) => delete c.order.qty), /order\.qty is missing/);
  assertRefused(withChange((c) => delete c.limits.maxShares), /limits\.maxShares is missing/);
  assertRefused(withChange((c) => (c.order.maxChase = 3)), /order\.maxChase is not a known setting/);
  assertRefused(withChange((c) => (c.order.sellOffset = 2)), /order\.sellOffset is not a known setting/);
  assertRefused(withChange((c) => (c.order.amountUSD = 400)), /order\.amountUSD is not a known setting/);
  // They are settings of `order`, nowhere else.
  assertRefused(withChange((c) => (c.maxChases = 3)), /^maxChases is not a known setting$/);
  assertRefused(withChange((c) => (c.limits.amountUsd = 400)), /limits\.amountUsd is not a known setting/);
});

test("the newer settings are checked like the others", () => {
  assertRefused(withChange((c) => (c.order.maxChases = -1)), /order\.maxChases must be at least 0/);
  assertRefused(withChange((c) => (c.order.maxChases = 21)), /order\.maxChases must be at most 20/);
  assertRefused(withChange((c) => (c.order.maxChases = 2.5)), /order\.maxChases must be a whole number/);
  assertRefused(withChange((c) => (c.order.maxChases = "5")), /order\.maxChases must be a number/);
  assertRefused(withChange((c) => (c.order.maxChases = null)), /order\.maxChases must be a number/);
  assertRefused(withChange((c) => (c.order.sellOffsetPct = 0)), /order\.sellOffsetPct must be at least 0\.1/);
  assertRefused(withChange((c) => (c.order.sellOffsetPct = 0.05)), /order\.sellOffsetPct must be at least 0\.1/);
  assertRefused(withChange((c) => (c.order.sellOffsetPct = 20.5)), /order\.sellOffsetPct must be at most 20/);
  assertRefused(withChange((c) => (c.order.amountUsd = -400)), /order\.amountUsd must be at least 0/);
  assertRefused(withChange((c) => (c.order.amountUsd = "400")), /order\.amountUsd must be a number/);
  assertRefused(withChange((c) => (c.order.askFallback = "bid")), /order\.askFallback must be "alert" or "none"/);
  assertRefused(withChange((c) => (c.order.askFallback = true)), /order\.askFallback must be "alert" or "none"/);
  assertRefused(withChange((c) => (c.order.askFallback = null)), /order\.askFallback must be "alert" or "none"/);

  // The edges are allowed: 0 switches chasing (or dollar sizing) off.
  for (const [key, value] of [["maxChases", 0], ["maxChases", 20], ["sellOffsetPct", 0.1], ["sellOffsetPct", 20], ["amountUsd", 0], ["askFallback", "none"]] as const) {
    assert.deepEqual(problemsOf(withChange((c) => (c.order[key] = value))), [], `${key} = ${value}`);
  }
});

test("order.amountUsd may not be above limits.maxNotionalUsd", () => {
  assertRefused(
    withChange((c) => (c.order.amountUsd = 1500)),
    /^order\.amountUsd \(1500\) is above limits\.maxNotionalUsd \(1000\): an order may not cost more than that$/,
  );
  assert.deepEqual(problemsOf(withChange((c) => (c.order.amountUsd = 1000))), []);
  assert.deepEqual(
    problemsOf(
      withChange((c) => {
        c.order.amountUsd = 400;
        c.limits.maxNotionalUsd = 400;
      }),
    ),
    [],
  );
  assert.equal(validateConfig(withChange((c) => (c.order.amountUsd = 400))).order.amountUsd, 400);
});

// ------------------------------------------------------------ the automation

/** The operator's rule (2026-11-28), as the defaults hold it. */
const AUTO_RULE: AutoConfig = {
  windowStart: "04:00",
  windowEnd: "05:00",
  amountUsd: 400,
  budgetUsd: 2000,
  maxTrades: 5,
  maxOrdersPerDay: 30,
  entryStopPct: 5,
  entryStopLimitPct: 1,
  entryValidSec: 300,
  takeProfitPct: 20,
  stopPct: 10,
  stopLimitOffsetPct: 3,
  maxAlertAgeSec: 60,
  paperOnly: true,
  tpGraceMs: 1500,
  stopGraceMs: 1000,
  resellMs: 2000,
};

test("auto: the defaults are the operator's rule, and a config.json without an auto section runs on them", (t) => {
  assert.deepEqual(AUTO_DEFAULTS, AUTO_RULE);
  assert.deepEqual(defaultConfig(TOKEN).auto, AUTO_RULE);
  const old = withChange((c) => delete c.auto) as Record<string, unknown>;
  assert.equal("auto" in old, false);
  assert.deepEqual(problemsOf(old), []);
  assert.deepEqual(validateConfig(old).auto, AUTO_RULE);
  assert.deepEqual(validateConfig(old), defaultConfig(TOKEN));
  // An empty section is the same.
  assert.deepEqual(validateConfig({ ...old, auto: {} }).auto, AUTO_RULE);

  // From a file on disk, as the running installation has it: it loads and is not rewritten.
  const file = path.join(tempDir(t), "config.json");
  fs.writeFileSync(file, `${JSON.stringify(old, null, 2)}\n`, { mode: 0o600 });
  const before = fs.readFileSync(file, "utf8");
  assert.deepEqual(loadOrCreateConfig(file).config.auto, AUTO_RULE);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("auto: each of its keys may be there without the others", () => {
  const values: Partial<AutoConfig> = {
    windowStart: "04:15",
    windowEnd: "06:30",
    amountUsd: 250,
    budgetUsd: 1000,
    maxTrades: 3,
    maxOrdersPerDay: 12,
    entryStopPct: 4,
    entryStopLimitPct: 0.5,
    entryValidSec: 120,
    takeProfitPct: 15,
    stopPct: 8,
    stopLimitOffsetPct: 2,
    maxAlertAgeSec: 30,
    paperOnly: false,
    tpGraceMs: 500,
    stopGraceMs: 0,
    resellMs: 1000,
  };
  assert.deepEqual(Object.keys(values).sort(), Object.keys(AUTO_RULE).sort());
  for (const [key, value] of Object.entries(values)) {
    const config = validateConfig(withChange((c) => (c.auto = { [key]: value })));
    assert.deepEqual(config.auto, { ...AUTO_RULE, [key]: value }, key);
  }
  // All of them at once.
  assert.deepEqual(validateConfig(withChange((c) => (c.auto = values))).auto, values);
});

test("auto: an unknown key is a typo and refused; the section must be an object", () => {
  assertRefused(withChange((c) => (c.auto = { windowStrat: "04:00" })), /^auto\.windowStrat is not a known setting$/);
  assertRefused(withChange((c) => (c.auto = { mode: "on" })), /^auto\.mode is not a known setting$/);
  assertRefused(withChange((c) => (c.auto = { ...AUTO_RULE, amountUSD: 400 })), /^auto\.amountUSD is not a known setting$/);
  assertRefused(withChange((c) => (c.auto = "on")), /^auto must be an object$/);
  assertRefused(withChange((c) => (c.auto = null)), /^auto must be an object$/);
  assertRefused(withChange((c) => (c.auto = [])), /^auto must be an object$/);
  // Its keys belong in it, not at the top or in `order`.
  assertRefused(withChange((c) => (c.windowStart = "04:00")), /^windowStart is not a known setting$/);
  assertRefused(withChange((c) => (c.order.budgetUsd = 2000)), /^order\.budgetUsd is not a known setting$/);
});

test("auto: its numbers, times and switch are checked", () => {
  const refused: Array<[Partial<Record<keyof AutoConfig, unknown>>, RegExp]> = [
    [{ windowStart: "4:00" }, /^auto\.windowStart must be a New York time of day as "HH:MM"$/],
    [{ windowStart: "24:00" }, /^auto\.windowStart must be a New York time/],
    [{ windowEnd: "05:60" }, /^auto\.windowEnd must be a New York time/],
    [{ windowEnd: 5 }, /^auto\.windowEnd must be a New York time/],
    [{ amountUsd: 0 }, /^auto\.amountUsd must be above 0$/],
    [{ amountUsd: "400" }, /^auto\.amountUsd must be a number$/],
    [{ budgetUsd: 0 }, /^auto\.budgetUsd must be above 0$/],
    [{ maxTrades: 0 }, /^auto\.maxTrades must be at least 1$/],
    [{ maxTrades: 51 }, /^auto\.maxTrades must be at most 50$/],
    [{ maxTrades: 2.5 }, /^auto\.maxTrades must be a whole number$/],
    [{ maxOrdersPerDay: 0 }, /^auto\.maxOrdersPerDay must be at least 1$/],
    [{ maxOrdersPerDay: 201 }, /^auto\.maxOrdersPerDay must be at most 200$/],
    [{ entryStopPct: 0 }, /^auto\.entryStopPct must be above 0$/],
    [{ entryStopPct: 50.5 }, /^auto\.entryStopPct must be at most 50$/],
    [{ entryStopLimitPct: 0.05 }, /^auto\.entryStopLimitPct must be at least 0\.1$/],
    [{ entryStopLimitPct: 21 }, /^auto\.entryStopLimitPct must be at most 20$/],
    [{ entryValidSec: 9 }, /^auto\.entryValidSec must be at least 10$/],
    [{ entryValidSec: 3601 }, /^auto\.entryValidSec must be at most 3600$/],
    [{ entryValidSec: 30.5 }, /^auto\.entryValidSec must be a whole number$/],
    [{ takeProfitPct: 0 }, /^auto\.takeProfitPct must be above 0$/],
    [{ stopPct: 0 }, /^auto\.stopPct must be above 0$/],
    [{ stopPct: 100 }, /^auto\.stopPct must be below 100$/],
    [{ stopLimitOffsetPct: -1 }, /^auto\.stopLimitOffsetPct must be at least 0$/],
    [{ stopLimitOffsetPct: 100 }, /^auto\.stopLimitOffsetPct must be below 100$/],
    [{ maxAlertAgeSec: 4 }, /^auto\.maxAlertAgeSec must be at least 5$/],
    [{ maxAlertAgeSec: 601 }, /^auto\.maxAlertAgeSec must be at most 600$/],
    [{ paperOnly: "false" }, /^auto\.paperOnly must be true or false$/],
    [{ paperOnly: 0 }, /^auto\.paperOnly must be true or false$/],
    [{ tpGraceMs: -1 }, /^auto\.tpGraceMs must be at least 0$/],
    [{ tpGraceMs: 60_001 }, /^auto\.tpGraceMs must be at most 60000$/],
    [{ stopGraceMs: 1.5 }, /^auto\.stopGraceMs must be a whole number$/],
    [{ resellMs: 999 }, /^auto\.resellMs must be at least 1000$/],
    [{ resellMs: 60_001 }, /^auto\.resellMs must be at most 60000$/],
  ];
  for (const [change, problem] of refused) assertRefused(withChange((c) => (c.auto = change)), problem);

  // The edges are allowed.
  const allowed: Array<Partial<AutoConfig>> = [
    { windowStart: "00:00", windowEnd: "23:59" },
    { maxTrades: 1 },
    { maxTrades: 50 },
    { maxOrdersPerDay: 1 },
    { maxOrdersPerDay: 200 },
    { entryStopPct: 50 },
    { entryStopLimitPct: 0.1 },
    { entryStopLimitPct: 20 },
    { entryValidSec: 10 },
    { entryValidSec: 3600 },
    { stopLimitOffsetPct: 0 },
    { maxAlertAgeSec: 5 },
    { maxAlertAgeSec: 600 },
    { tpGraceMs: 0, stopGraceMs: 0 },
    { tpGraceMs: 60_000, stopGraceMs: 60_000 },
    { resellMs: 1000 },
    { resellMs: 60_000 },
  ];
  for (const change of allowed) assert.deepEqual(problemsOf(withChange((c) => (c.auto = change))), [], JSON.stringify(change));
});

test("auto: its hour must open before it closes, on one New York day", () => {
  assertRefused(
    withChange((c) => (c.auto = { windowStart: "05:00", windowEnd: "04:00" })),
    /^auto\.windowStart \(05:00\) must be before auto\.windowEnd \(04:00\)/,
  );
  assertRefused(withChange((c) => (c.auto = { windowStart: "04:00", windowEnd: "04:00" })), /^auto\.windowStart \(04:00\) must be before auto\.windowEnd \(04:00\)/);
  // An hour across midnight is not one day's.
  assertRefused(withChange((c) => (c.auto = { windowStart: "23:30", windowEnd: "00:30" })), /must be before auto\.windowEnd/);
  // Only the start set: against the default end.
  assertRefused(withChange((c) => (c.auto = { windowStart: "06:00" })), /^auto\.windowStart \(06:00\) must be before auto\.windowEnd \(05:00\)/);
  assert.deepEqual(problemsOf(withChange((c) => (c.auto = { windowStart: "04:59" }))), []);
  assert.deepEqual(problemsOf(withChange((c) => (c.auto = { windowStart: "09:30", windowEnd: "16:00" }))), []);
});

test("auto: the budget must pay for at least one buy", () => {
  assertRefused(withChange((c) => (c.auto = { budgetUsd: 399 })), /^auto\.budgetUsd \(399\) is under auto\.amountUsd \(400\)/);
  assertRefused(withChange((c) => (c.auto = { amountUsd: 2500 })), /^auto\.budgetUsd \(2000\) is under auto\.amountUsd \(2500\)/);
  assert.deepEqual(problemsOf(withChange((c) => (c.auto = { budgetUsd: 400 }))), []);
});

test("auto: auto.amountUsd above limits.maxNotionalUsd is not a config error (the buy is refused when tried)", () => {
  const config = validateConfig(
    withChange((c) => {
      c.auto = { amountUsd: 1500, budgetUsd: 3000 };
      c.limits.maxNotionalUsd = 1000;
    }),
  );
  assert.deepEqual([config.auto.amountUsd, config.limits.maxNotionalUsd], [1500, 1000]);
  // Unlike order.amountUsd, which is.
  assertRefused(withChange((c) => (c.order.amountUsd = 1500)), /order\.amountUsd \(1500\) is above limits\.maxNotionalUsd/);
});

test("autoSlots: how many buys the budget pays for, waiting or held at once", () => {
  const slots = (budgetUsd: number, amountUsd: number): number => autoSlots({ ...AUTO_RULE, budgetUsd, amountUsd });
  assert.equal(autoSlots(AUTO_RULE), 5);
  assert.equal(slots(2000, 400), 5);
  assert.equal(slots(1999, 400), 4);
  assert.equal(slots(400, 400), 1);
  assert.equal(slots(1000, 300), 3);
  assert.equal(slots(0.3, 0.1), 3); // 0.3 / 0.1 is 2.9999999999999996
  assert.equal(slots(1200, 400), 3);
});

test("minutesOfDay: HH:MM as minutes after midnight, else null", () => {
  assert.equal(minutesOfDay("00:00"), 0);
  assert.equal(minutesOfDay("04:00"), 240);
  assert.equal(minutesOfDay("05:00"), 300);
  assert.equal(minutesOfDay("23:59"), 1439);
  for (const text of ["4:00", "24:00", "04:60", "04:00:00", " 04:00", "0400", "", "ab:cd"]) assert.equal(minutesOfDay(text), null, text);
});
