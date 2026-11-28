import { randomBytes } from "node:crypto";
import fs from "node:fs";

export interface TwsConfig {
  host: string;
  /** 7497 = TWS paper, 7496 = TWS live. */
  port: number;
  clientId: number;
}

export interface OrderConfig {
  qty: number;
  /** Where the buy limit starts from: the alert's price, or TWS's ask at the click. */
  priceFrom: "alert" | "ask";
  limitOffsetPct: number;
  maxChasePct: number;
  takeProfitPct: number;
  stopPct: number;
  stopLimitOffsetPct: number;
  useAlertStop: boolean;
  outsideRth: boolean;
  /**
   * Most `/chase` clicks on one buy, and most re-prices of one `/sell`. 0 switches `/chase` off.
   * Optional in config.json (see {@link OPTIONAL_ORDER_DEFAULTS}).
   */
  maxChases: number;
  /** A `/sell` limit sits this many percent under the bid. Optional in config.json. */
  sellOffsetPct: number;
  /**
   * Dollars per buy: above 0, a click that names no quantity buys as many whole shares as this
   * pays for at the buy's limit, and `qty` is not used. 0 = off. Optional in config.json.
   */
  amountUsd: number;
  /**
   * With `priceFrom: "ask"`, what a buy does when TWS gives no live ask at the click: "alert"
   * prices it from the alert instead, "none" refuses. Optional in config.json.
   */
  askFallback: "alert" | "none";
  /**
   * A stop entry (`entry: "stop"`) is a buy that waits above the alert: it triggers this many
   * percent above the alert's price. 0 = no stop entries. Optional in config.json.
   */
  entryStopPct: number;
  /** A stop entry's limit sits this many percent above its trigger. Optional in config.json. */
  entryStopLimitPct: number;
  /** How many seconds a stop entry waits before IB cancels it (GTD). Optional in config.json. */
  entryValidSec: number;
}

/**
 * Settings added after the first config.json files were written. A file without them still
 * loads: each takes the value here. Every other setting must be in the file.
 */
export const OPTIONAL_ORDER_DEFAULTS = {
  maxChases: 5,
  sellOffsetPct: 2.0,
  amountUsd: 0,
  askFallback: "alert",
  entryStopPct: 3.0,
  entryStopLimitPct: 1.0,
  entryValidSec: 300,
} as const;

export interface LimitsConfig {
  maxShares: number;
  maxNotionalUsd: number;
  maxOrdersPerDay: number;
  duplicateWindowSec: number;
}

/**
 * The automation (`src/auto.ts`): which alerts it buys, with what, and how its exits are watched.
 * The whole section is optional in config.json, and so is every key in it: what is not in the
 * file takes its value from {@link AUTO_DEFAULTS}. Whether the automation runs at all is not a
 * setting here: it is switched from the dashboard (off / watch only / on) and kept in state.json.
 */
export interface AutoConfig {
  /**
   * The hour it buys in, New York time, "HH:MM": an alert from `windowStart` up to (not
   * including) `windowEnd`. No buy waits past `windowEnd`; exits keep working after it.
   */
  windowStart: string;
  windowEnd: string;
  /** Dollars per buy. */
  amountUsd: number;
  /** The most that may be out at once: `budgetUsd / amountUsd` buys waiting or held (the slots). */
  budgetUsd: number;
  /** The most buys that may fill in one New York day. */
  maxTrades: number;
  /** The most buys it may place in one New York day, filled or not. */
  maxOrdersPerDay: number;
  /** The waiting buy triggers this many percent above the alert's price. */
  entryStopPct: number;
  /** Its limit sits this many percent above the trigger. */
  entryStopLimitPct: number;
  /** It waits this many seconds, and never past `windowEnd`; then IB cancels it. */
  entryValidSec: number;
  /** The exits, measured from the trigger. */
  takeProfitPct: number;
  stopPct: number;
  stopLimitOffsetPct: number;
  /** An alert older than this when it reaches the bridge is not bought. */
  maxAlertAgeSec: number;
  /** The automation's own lock: it places nothing on an account that is not a paper one. By hand only. */
  paperOnly: boolean;
  /** The take-profit's price has traded and the take-profit has not filled this long after: sell at the bid. */
  tpGraceMs: number;
  /** The stop is due and has not sold everything this long after: sell at the bid. */
  stopGraceMs: number;
  /** While such a sell has not sold everything, it is moved down to the bid again this often. */
  resellMs: number;
}

export const AUTO_DEFAULTS: AutoConfig = {
  windowStart: "04:00",
  windowEnd: "05:00",
  amountUsd: 400,
  budgetUsd: 2000,
  maxTrades: 5,
  maxOrdersPerDay: 30,
  entryStopPct: 5.0,
  entryStopLimitPct: 1.0,
  entryValidSec: 300,
  takeProfitPct: 20.0,
  stopPct: 10.0,
  stopLimitOffsetPct: 3.0,
  maxAlertAgeSec: 60,
  paperOnly: true,
  tpGraceMs: 1500,
  stopGraceMs: 1000,
  resellMs: 2000,
};

/** How many buys may be waiting or held at once: what the budget pays for. */
export function autoSlots(auto: AutoConfig): number {
  return Math.floor(auto.budgetUsd / auto.amountUsd + 1e-9);
}

/** "HH:MM" as minutes after midnight, or null when it is not a time of day. */
export function minutesOfDay(text: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text);
  return match === null ? null : Number(match[1]) * 60 + Number(match[2]);
}

export interface Config {
  tws: TwsConfig;
  http: { port: number };
  token: string;
  allowedOrigins: string[];
  displayGroup: number;
  paperOnly: boolean;
  enabled: boolean;
  halted: boolean;
  order: OrderConfig;
  limits: LimitsConfig;
  auto: AutoConfig;
}

/** The socket ports TWS and IB Gateway listen on by default; the HTTP side must stay off them. */
export const IB_API_PORTS: readonly number[] = [7496, 7497, 4001, 4002];

const TOKEN_FORMAT = /^[0-9a-f]{64}$/;

export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`config.json is not usable:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

export function defaultConfig(token: string): Config {
  return {
    tws: { host: "127.0.0.1", port: 7497, clientId: 77 },
    http: { port: 8765 },
    token,
    allowedOrigins: ["https://pnldash.uz", "http://localhost:5173"],
    displayGroup: 1,
    paperOnly: true,
    enabled: true,
    halted: false,
    order: {
      qty: 100,
      priceFrom: "alert",
      limitOffsetPct: 1.0,
      maxChasePct: 3.0,
      takeProfitPct: 10.0,
      stopPct: 5.0,
      stopLimitOffsetPct: 1.0,
      useAlertStop: true,
      outsideRth: true,
      maxChases: OPTIONAL_ORDER_DEFAULTS.maxChases,
      sellOffsetPct: OPTIONAL_ORDER_DEFAULTS.sellOffsetPct,
      amountUsd: OPTIONAL_ORDER_DEFAULTS.amountUsd,
      askFallback: OPTIONAL_ORDER_DEFAULTS.askFallback,
      entryStopPct: OPTIONAL_ORDER_DEFAULTS.entryStopPct,
      entryStopLimitPct: OPTIONAL_ORDER_DEFAULTS.entryStopLimitPct,
      entryValidSec: OPTIONAL_ORDER_DEFAULTS.entryValidSec,
    },
    limits: { maxShares: 500, maxNotionalUsd: 1000, maxOrdersPerDay: 20, duplicateWindowSec: 10 },
    auto: { ...AUTO_DEFAULTS },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface NumberRule {
  integer?: boolean;
  min?: number;
  /** The value must be strictly above this. */
  above?: number;
  max?: number;
  /** The value must be strictly below this. */
  below?: number;
}

/** Collects every problem instead of stopping at the first, so one start shows the whole list. */
class Checker {
  readonly problems: string[] = [];

  /**
   * An object with these keys and no others: an unknown key is a typo, and a missing key is
   * never defaulted, except the `optional` ones (settings newer than the config files already in
   * use), which take their default when the file does not have them.
   */
  section(value: unknown, path: string, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
    if (!isPlainObject(value)) {
      this.problems.push(`${path || "the file"} must be an object`);
      return {};
    }
    const prefix = path ? `${path}.` : "";
    for (const key of Object.keys(value)) {
      if (!keys.includes(key) && !optional.includes(key)) this.problems.push(`${prefix}${key} is not a known setting`);
    }
    for (const key of keys) {
      if (!(key in value)) this.problems.push(`${prefix}${key} is missing`);
    }
    return value;
  }

  /** `whenMissing` is what an optional setting is when the file does not have it. */
  number(section: Record<string, unknown>, path: string, key: string, rule: NumberRule, whenMissing = Number.NaN): number {
    if (!(key in section)) return whenMissing;
    const value = section[key];
    const name = path ? `${path}.${key}` : key;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      this.problems.push(`${name} must be a number`);
      return Number.NaN;
    }
    if (rule.integer && !Number.isInteger(value)) this.problems.push(`${name} must be a whole number`);
    if (rule.min !== undefined && value < rule.min) this.problems.push(`${name} must be at least ${rule.min}`);
    if (rule.above !== undefined && value <= rule.above) this.problems.push(`${name} must be above ${rule.above}`);
    if (rule.max !== undefined && value > rule.max) this.problems.push(`${name} must be at most ${rule.max}`);
    if (rule.below !== undefined && value >= rule.below) this.problems.push(`${name} must be below ${rule.below}`);
    return value;
  }

  boolean(section: Record<string, unknown>, path: string, key: string): boolean {
    if (!(key in section)) return false;
    const value = section[key];
    if (typeof value !== "boolean") {
      this.problems.push(`${path ? `${path}.${key}` : key} must be true or false`);
      return false;
    }
    return value;
  }
}

function checkOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin === value ? value : null;
  } catch {
    return null;
  }
}

/** Checks a parsed config.json. Throws a {@link ConfigError} that lists every problem found. */
export function validateConfig(raw: unknown): Config {
  const c = new Checker();
  const root = c.section(
    raw,
    "",
    ["tws", "http", "token", "allowedOrigins", "displayGroup", "paperOnly", "enabled", "halted", "order", "limits"],
    // Newer than the config files already in use: a file without it runs on AUTO_DEFAULTS.
    ["auto"],
  );

  const tws = "tws" in root ? c.section(root["tws"], "tws", ["host", "port", "clientId"]) : {};
  const host = tws["host"];
  if ("host" in tws && (typeof host !== "string" || host.trim() === "" || /\s/.test(host))) {
    c.problems.push("tws.host must be a host name or address");
  }
  const twsPort = c.number(tws, "tws", "port", { integer: true, min: 1, max: 65535 });
  // Client id 0 is TWS's "master" id: it adopts the orders typed into TWS by hand. Stay off it.
  const clientId = c.number(tws, "tws", "clientId", { integer: true, min: 1, max: 2147483647 });

  const http = "http" in root ? c.section(root["http"], "http", ["port"]) : {};
  const httpPort = c.number(http, "http", "port", { integer: true, min: 1024, max: 65535 });
  if (Number.isInteger(httpPort) && Number.isInteger(twsPort)) {
    if (httpPort === twsPort) {
      c.problems.push(`http.port (${httpPort}) clashes with tws.port: the bridge cannot listen on the port TWS uses`);
    } else if (IB_API_PORTS.includes(httpPort)) {
      c.problems.push(`http.port (${httpPort}) is one of the TWS / IB Gateway API ports (${IB_API_PORTS.join(", ")})`);
    }
  }

  const token = root["token"];
  if ("token" in root && (typeof token !== "string" || !TOKEN_FORMAT.test(token))) {
    c.problems.push(
      "token is missing or not 64 hex characters: delete config.json to get a new one on the next start, " +
        "or put the output of `openssl rand -hex 32` there",
    );
  }

  const allowedOrigins: string[] = [];
  if ("allowedOrigins" in root) {
    const list = root["allowedOrigins"];
    if (!Array.isArray(list)) {
      c.problems.push("allowedOrigins must be a list");
    } else {
      for (const item of list) {
        const origin = checkOrigin(item);
        if (origin === null) {
          c.problems.push(
            `allowedOrigins: ${JSON.stringify(item)} is not an origin (scheme://host[:port], no path, no "*")`,
          );
        } else {
          allowedOrigins.push(origin);
        }
      }
    }
  }

  const displayGroup = c.number(root, "", "displayGroup", { integer: true, min: 1, max: 99 });
  const paperOnly = c.boolean(root, "", "paperOnly");
  const enabled = c.boolean(root, "", "enabled");
  const halted = c.boolean(root, "", "halted");

  const order =
    "order" in root
      ? c.section(
          root["order"],
          "order",
          [
            "qty",
            "priceFrom",
            "limitOffsetPct",
            "maxChasePct",
            "takeProfitPct",
            "stopPct",
            "stopLimitOffsetPct",
            "useAlertStop",
            "outsideRth",
          ],
          Object.keys(OPTIONAL_ORDER_DEFAULTS),
        )
      : {};
  const qty = c.number(order, "order", "qty", { integer: true, min: 1 });
  const priceFrom = order["priceFrom"];
  if ("priceFrom" in order && priceFrom !== "alert" && priceFrom !== "ask") {
    c.problems.push('order.priceFrom must be "alert" or "ask"');
  }
  const limitOffsetPct = c.number(order, "order", "limitOffsetPct", { min: 0 });
  const maxChasePct = c.number(order, "order", "maxChasePct", { min: 0 });
  const takeProfitPct = c.number(order, "order", "takeProfitPct", { min: 0 });
  const stopPct = c.number(order, "order", "stopPct", { min: 0, below: 100 });
  const stopLimitOffsetPct = c.number(order, "order", "stopLimitOffsetPct", { min: 0, below: 100 });
  const useAlertStop = c.boolean(order, "order", "useAlertStop");
  const outsideRth = c.boolean(order, "order", "outsideRth");
  const maxChases = c.number(order, "order", "maxChases", { integer: true, min: 0, max: 20 }, OPTIONAL_ORDER_DEFAULTS.maxChases);
  const sellOffsetPct = c.number(order, "order", "sellOffsetPct", { min: 0.1, max: 20 }, OPTIONAL_ORDER_DEFAULTS.sellOffsetPct);
  const amountUsd = c.number(order, "order", "amountUsd", { min: 0 }, OPTIONAL_ORDER_DEFAULTS.amountUsd);
  const askFallback = "askFallback" in order ? order["askFallback"] : OPTIONAL_ORDER_DEFAULTS.askFallback;
  if (askFallback !== "alert" && askFallback !== "none") {
    c.problems.push('order.askFallback must be "alert" or "none"');
  }
  const entryStopPct = c.number(order, "order", "entryStopPct", { min: 0, max: 50 }, OPTIONAL_ORDER_DEFAULTS.entryStopPct);
  const entryStopLimitPct = c.number(
    order,
    "order",
    "entryStopLimitPct",
    { min: 0.1, max: 20 },
    OPTIONAL_ORDER_DEFAULTS.entryStopLimitPct,
  );
  // Whole seconds: the time IB is given to cancel the order at has no fractions.
  const entryValidSec = c.number(
    order,
    "order",
    "entryValidSec",
    { integer: true, min: 10, max: 3600 },
    OPTIONAL_ORDER_DEFAULTS.entryValidSec,
  );
  if (priceFrom === "alert" && limitOffsetPct > maxChasePct) {
    c.problems.push(
      `order.limitOffsetPct (${limitOffsetPct}) is above order.maxChasePct (${maxChasePct}): ` +
        'with priceFrom "alert" every order would be refused as chasing',
    );
  }

  const limits =
    "limits" in root
      ? c.section(root["limits"], "limits", ["maxShares", "maxNotionalUsd", "maxOrdersPerDay", "duplicateWindowSec"])
      : {};
  const maxShares = c.number(limits, "limits", "maxShares", { integer: true, min: 1 });
  const maxNotionalUsd = c.number(limits, "limits", "maxNotionalUsd", { above: 0 });
  const maxOrdersPerDay = c.number(limits, "limits", "maxOrdersPerDay", { integer: true, min: 0 });
  const duplicateWindowSec = c.number(limits, "limits", "duplicateWindowSec", { min: 0 });
  if (qty > maxShares) {
    c.problems.push(`order.qty (${qty}) is above limits.maxShares (${maxShares}): the default order would be refused`);
  }
  if (amountUsd > maxNotionalUsd) {
    c.problems.push(
      `order.amountUsd (${amountUsd}) is above limits.maxNotionalUsd (${maxNotionalUsd}): ` +
        "an order may not cost more than that",
    );
  }

  // The automation. Every key is optional; an unknown one is still a typo.
  const autoKeys = Object.keys(AUTO_DEFAULTS);
  const auto = "auto" in root ? c.section(root["auto"], "auto", [], autoKeys) : {};
  const D = AUTO_DEFAULTS;
  const time = (key: "windowStart" | "windowEnd"): string => {
    const value = key in auto ? auto[key] : D[key];
    if (typeof value !== "string" || minutesOfDay(value) === null) {
      c.problems.push(`auto.${key} must be a New York time of day as "HH:MM"`);
      return D[key];
    }
    return value;
  };
  const windowStart = time("windowStart");
  const windowEnd = time("windowEnd");
  if ((minutesOfDay(windowStart) ?? 0) >= (minutesOfDay(windowEnd) ?? 0)) {
    c.problems.push(`auto.windowStart (${windowStart}) must be before auto.windowEnd (${windowEnd}), both on the same New York day`);
  }
  const autoAmountUsd = c.number(auto, "auto", "amountUsd", { above: 0 }, D.amountUsd);
  const autoBudgetUsd = c.number(auto, "auto", "budgetUsd", { above: 0 }, D.budgetUsd);
  const autoMaxTrades = c.number(auto, "auto", "maxTrades", { integer: true, min: 1, max: 50 }, D.maxTrades);
  const autoMaxOrders = c.number(auto, "auto", "maxOrdersPerDay", { integer: true, min: 1, max: 200 }, D.maxOrdersPerDay);
  // A waiting buy needs a trigger above the alert: 0 is not "off" here, the dashboard's switch is.
  const autoEntryStopPct = c.number(auto, "auto", "entryStopPct", { above: 0, max: 50 }, D.entryStopPct);
  const autoEntryStopLimitPct = c.number(auto, "auto", "entryStopLimitPct", { min: 0.1, max: 20 }, D.entryStopLimitPct);
  const autoEntryValidSec = c.number(auto, "auto", "entryValidSec", { integer: true, min: 10, max: 3600 }, D.entryValidSec);
  // The automation never places a buy without both exits.
  const autoTakeProfitPct = c.number(auto, "auto", "takeProfitPct", { above: 0 }, D.takeProfitPct);
  const autoStopPct = c.number(auto, "auto", "stopPct", { above: 0, below: 100 }, D.stopPct);
  const autoStopLimitOffsetPct = c.number(auto, "auto", "stopLimitOffsetPct", { min: 0, below: 100 }, D.stopLimitOffsetPct);
  const autoMaxAlertAgeSec = c.number(auto, "auto", "maxAlertAgeSec", { integer: true, min: 5, max: 600 }, D.maxAlertAgeSec);
  const autoPaperOnly = "paperOnly" in auto ? c.boolean(auto, "auto", "paperOnly") : D.paperOnly;
  const tpGraceMs = c.number(auto, "auto", "tpGraceMs", { integer: true, min: 0, max: 60000 }, D.tpGraceMs);
  const stopGraceMs = c.number(auto, "auto", "stopGraceMs", { integer: true, min: 0, max: 60000 }, D.stopGraceMs);
  // Not under a second: every move of a sell is a message to TWS.
  const resellMs = c.number(auto, "auto", "resellMs", { integer: true, min: 1000, max: 60000 }, D.resellMs);
  // auto.amountUsd above limits.maxNotionalUsd is not refused here, unlike order.amountUsd: an
  // owner who lowers the limit for their clicks must not find the bridge unable to start over an
  // automation that is switched off. Such a buy is refused when it is tried, and says why.
  if (autoBudgetUsd < autoAmountUsd) {
    c.problems.push(`auto.budgetUsd (${autoBudgetUsd}) is under auto.amountUsd (${autoAmountUsd}): it pays for no buy at all`);
  }

  if (c.problems.length > 0) throw new ConfigError(c.problems);

  return {
    auto: {
      windowStart,
      windowEnd,
      amountUsd: autoAmountUsd,
      budgetUsd: autoBudgetUsd,
      maxTrades: autoMaxTrades,
      maxOrdersPerDay: autoMaxOrders,
      entryStopPct: autoEntryStopPct,
      entryStopLimitPct: autoEntryStopLimitPct,
      entryValidSec: autoEntryValidSec,
      takeProfitPct: autoTakeProfitPct,
      stopPct: autoStopPct,
      stopLimitOffsetPct: autoStopLimitOffsetPct,
      maxAlertAgeSec: autoMaxAlertAgeSec,
      paperOnly: autoPaperOnly,
      tpGraceMs,
      stopGraceMs,
      resellMs,
    },
    tws: { host: host as string, port: twsPort, clientId },
    http: { port: httpPort },
    token: token as string,
    allowedOrigins,
    displayGroup,
    paperOnly,
    enabled,
    halted,
    order: {
      qty,
      priceFrom: priceFrom as "alert" | "ask",
      limitOffsetPct,
      maxChasePct,
      takeProfitPct,
      stopPct,
      stopLimitOffsetPct,
      useAlertStop,
      outsideRth,
      maxChases,
      sellOffsetPct,
      amountUsd,
      askFallback: askFallback as "alert" | "none",
      entryStopPct,
      entryStopLimitPct,
      entryValidSec,
    },
    limits: { maxShares, maxNotionalUsd, maxOrdersPerDay, duplicateWindowSec },
  };
}

/** Writes through a temp file so a crash never leaves half a config; the file is owner-only. */
function writeJsonFile(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Reads and checks config.json. A missing file is created from the defaults with a fresh random
 * token; a file that exists is never rewritten here, only refused when it is wrong.
 */
export function loadOrCreateConfig(file: string): { config: Config; created: boolean } {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    const config = defaultConfig(generateToken());
    writeJsonFile(file, config);
    return { config, created: true };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError([`it is not valid JSON (${err instanceof Error ? err.message : String(err)})`]);
  }
  return { config: validateConfig(raw), created: false };
}

/**
 * Saves the halt switch. Only `halted` is changed in the file as it is on disk, so settings the
 * owner edited by hand since the start are kept (they take effect at the next start).
 */
export function persistHalted(file: string, halted: boolean): void {
  const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!isPlainObject(raw)) throw new Error("config.json does not hold a JSON object");
  raw["halted"] = halted;
  writeJsonFile(file, raw);
}
