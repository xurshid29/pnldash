import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { Bridge } from "../src/bridge.js";
import { defaultConfig } from "../src/config.js";
import type { Config } from "../src/config.js";
import { BridgeError } from "../src/errors.js";
import { MemoryJournal } from "../src/journal.js";
import type { Journal } from "../src/journal.js";
import { TwsLink } from "../src/link.js";
import { FakeTws, until } from "./fake-tws.js";

export const TOKEN = "ab".repeat(32);

/** 2026-11-25 10:00 in New York (EST, UTC-5): a Wednesday morning. */
export const T0 = Date.parse("2026-11-25T15:00:00Z");

export interface RigOptions {
  config?: (config: Config) => void;
  world?: (world: FakeTws) => void;
  /** Wait for the fake TWS connection before returning (default true). */
  connect?: boolean;
  journal?: Journal;
  ackWaitMs?: number;
  contractTimeoutMs?: number;
  /** The gap between the bridge's own background messages (default here: 1 ms). */
  backgroundGapMs?: number;
  /** How long the display-group report waits for the groups to answer (default here: 1 s). */
  groupReportMs?: number;
  /** How long a display group's ticker lookup may take (default here: 1 s). */
  groupLookupTimeoutMs?: number;
  now?: number;
  saveHalted?: (halted: boolean) => void;
}

export interface Rig {
  world: FakeTws;
  config: Config;
  clock: { now: number };
  journal: MemoryJournal;
  link: TwsLink;
  bridge: Bridge;
  /** Every value the bridge asked to have saved as `halted`. */
  saved: boolean[];
  /** Every line the bridge printed on its console. */
  said: string[];
}

/** A bridge wired to a fake TWS, a movable clock and an in-memory log. */
export async function rig(t: TestContext, options: RigOptions = {}): Promise<Rig> {
  const world = new FakeTws();
  options.world?.(world);
  const config = defaultConfig(TOKEN);
  options.config?.(config);
  const clock = { now: options.now ?? T0 };
  const memory = new MemoryJournal();
  const saved: boolean[] = [];
  const said: string[] = [];
  const link = new TwsLink({
    factory: world.factory,
    host: config.tws.host,
    port: config.tws.port,
    clientId: config.tws.clientId,
    reconnectMinMs: 5,
    reconnectMaxMs: 20,
    handshakeTimeoutMs: 1000,
    backgroundGapMs: options.backgroundGapMs ?? 1,
  });
  const bridge = new Bridge({
    config,
    link,
    journal: options.journal ?? memory,
    version: "0.0.0-test",
    saveHalted: options.saveHalted ?? ((halted) => saved.push(halted)),
    clock: () => clock.now,
    say: (message) => said.push(message),
    ackWaitMs: options.ackWaitMs ?? 0,
    contractTimeoutMs: options.contractTimeoutMs ?? 1000,
    askTimeoutMs: 40,
    groupReportMs: options.groupReportMs ?? 1000,
    groupLookupTimeoutMs: options.groupLookupTimeoutMs ?? 1000,
  });
  t.after(() => {
    bridge.close();
    link.stop();
  });
  link.start();
  if (options.connect ?? true) await until(() => link.isReady(), "the fake TWS connection");
  return { world, config, clock, journal: memory, link, bridge, saved, said };
}

function isRefusal(status: number, code: string, message?: RegExp): (err: unknown) => boolean {
  return (err) => {
    assert.ok(err instanceof BridgeError, `expected a BridgeError, got ${String(err)}`);
    assert.equal(err.code, code, `code (message: ${err.message})`);
    assert.equal(err.status, status, `status (message: ${err.message})`);
    if (message !== undefined) assert.match(err.message, message);
    return true;
  };
}

/** The promise must reject with this HTTP status and rail code. */
export async function refuses(promise: Promise<unknown>, status: number, code: string, message?: RegExp): Promise<void> {
  await assert.rejects(promise, isRefusal(status, code, message));
}

/** The call must throw with this HTTP status and rail code. */
export function refusesNow(call: () => unknown, status: number, code: string, message?: RegExp): void {
  assert.throws(call, isRefusal(status, code, message));
}

/** A valid `/order` body for the default test ticker. */
export function buy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ticker: "ABCD", alert_price: 2.5, ...overrides };
}
