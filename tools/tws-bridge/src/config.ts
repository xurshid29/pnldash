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
}

export interface LimitsConfig {
  maxShares: number;
  maxNotionalUsd: number;
  maxOrdersPerDay: number;
  duplicateWindowSec: number;
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
    },
    limits: { maxShares: 500, maxNotionalUsd: 1000, maxOrdersPerDay: 20, duplicateWindowSec: 10 },
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

  /** An object with exactly these keys: an unknown key is a typo, a missing key is never defaulted. */
  section(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
    if (!isPlainObject(value)) {
      this.problems.push(`${path || "the file"} must be an object`);
      return {};
    }
    const prefix = path ? `${path}.` : "";
    for (const key of Object.keys(value)) {
      if (!keys.includes(key)) this.problems.push(`${prefix}${key} is not a known setting`);
    }
    for (const key of keys) {
      if (!(key in value)) this.problems.push(`${prefix}${key} is missing`);
    }
    return value;
  }

  number(section: Record<string, unknown>, path: string, key: string, rule: NumberRule): number {
    if (!(key in section)) return Number.NaN;
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
  const root = c.section(raw, "", [
    "tws",
    "http",
    "token",
    "allowedOrigins",
    "displayGroup",
    "paperOnly",
    "enabled",
    "halted",
    "order",
    "limits",
  ]);

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
      ? c.section(root["order"], "order", [
          "qty",
          "priceFrom",
          "limitOffsetPct",
          "maxChasePct",
          "takeProfitPct",
          "stopPct",
          "stopLimitOffsetPct",
          "useAlertStop",
          "outsideRth",
        ])
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

  if (c.problems.length > 0) throw new ConfigError(c.problems);

  return {
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
