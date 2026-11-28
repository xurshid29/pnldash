import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AutoTrader } from "./auto.js";
import { Bridge } from "./bridge.js";
import { autoSlots, ConfigError, loadOrCreateConfig, persistHalted } from "./config.js";
import type { Config } from "./config.js";
import { errorMessage } from "./errors.js";
import { AlertFeed } from "./feed.js";
import { createIbApi } from "./ib.js";
import { FileJournal } from "./journal.js";
import { TwsLink } from "./link.js";
import { formatUsd } from "./order.js";
import { createBridgeServer, listenOnLoopback } from "./server.js";
import { loadState, saveState } from "./state.js";
import { systemClock } from "./time.js";
import { ExitWatch } from "./watch.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configFile = path.join(root, "config.json");
/** What the bridge was told at run time: the automation's switch, and where its alerts come from. Written by the bridge alone. */
const stateFile = path.join(root, "state.json");
const logsDir = path.join(root, "logs");

function say(message: string): void {
  console.log(`${new Date().toTimeString().slice(0, 8)}  ${message}`);
}

function readVersion(): string {
  try {
    const pkg: unknown = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    if (typeof pkg === "object" && pkg !== null && "version" in pkg && typeof pkg.version === "string") return pkg.version;
  } catch {
    // Fall through.
  }
  return "0.0.0";
}

function loadConfig(): Config | null {
  try {
    const { config, created } = loadOrCreateConfig(configFile);
    if (created) {
      console.log(`Created ${configFile} from the defaults (readable by you only).`);
      console.log('The dashboard needs the value of its "token" field; it is not printed here.');
    } else if (process.platform !== "win32" && (fs.statSync(configFile).mode & 0o077) !== 0) {
      console.log(`Note: ${configFile} is readable by other users of this Mac; \`chmod 600\` it (it holds the token).`);
    }
    return config;
  } catch (err) {
    console.error(err instanceof ConfigError ? err.message : `Cannot read ${configFile}: ${errorMessage(err)}`);
    console.error("The bridge did not start.");
    return null;
  }
}

async function main(): Promise<void> {
  const version = readVersion();
  const config = loadConfig();
  if (config === null) {
    process.exitCode = 1;
    return;
  }

  const { state, problem: stateProblem } = loadState(stateFile);
  if (stateProblem !== null) {
    console.log(`Note: ${stateProblem}. What could not be read starts from its default (the automation off, no alert stream).`);
  }

  const journal = new FileJournal(logsDir, systemClock, [config.token]);
  // The alert stream's token is a secret too: the log replaces it wherever it would turn up.
  if (state.feed !== null) journal.addSecret(state.feed.token);
  const link = new TwsLink({
    factory: createIbApi,
    host: config.tws.host,
    port: config.tws.port,
    clientId: config.tws.clientId,
  });
  const bridge = new Bridge({
    config,
    link,
    journal,
    version,
    saveHalted: (halted) => persistHalted(configFile, halted),
    say,
  });
  // The automation's two halves: the watch sells what it bought, the trader decides what it buys.
  const watch = new ExitWatch({ auto: config.auto, bridge, link, journal, say });
  const auto = new AutoTrader({
    config,
    bridge,
    journal,
    state,
    saveState: (next) => saveState(stateFile, next),
    feed: (onSetup) => new AlertFeed({ onSetup }),
    say,
  });
  const server = createBridgeServer({
    bridge,
    auto,
    token: config.token,
    allowedOrigins: config.allowedOrigins,
    journal,
  });

  try {
    await listenOnLoopback(server, config.http.port);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    console.error(
      code === "EADDRINUSE"
        ? `Port ${config.http.port} is taken: is the bridge already running? (http.port in config.json)`
        : `Cannot listen on 127.0.0.1:${config.http.port}: ${errorMessage(err)}`,
    );
    process.exitCode = 1;
    return;
  }

  const portKind = config.tws.port === 7497 ? " (TWS paper)" : config.tws.port === 7496 ? " (TWS LIVE)" : "";
  console.log(`tws-bridge ${version}`);
  console.log(`  config   ${configFile}`);
  console.log(`  log      ${logsDir}${path.sep}`);
  console.log(`  http     http://127.0.0.1:${config.http.port}   origins: ${config.allowedOrigins.join(", ") || "none"}`);
  console.log(`  TWS      ${config.tws.host}:${config.tws.port}${portKind}, client id ${config.tws.clientId}, display group ${config.displayGroup}`);
  console.log(
    `  orders   ${config.paperOnly ? "paper accounts only" : "LIVE ACCOUNTS ALLOWED (paperOnly is off)"}` +
      `${config.enabled ? "" : ", DISABLED"}${config.halted ? ", HALTED" : ""}`,
  );
  const a = config.auto;
  const autoMode =
    auto.mode === "on" ? "ON: it places orders by itself" : auto.mode === "watch" ? "WATCH ONLY: it places nothing" : "off";
  console.log(
    `  auto     ${autoMode}. Yellow POPs ${a.windowStart}-${a.windowEnd} New York, buy if >= +${a.entryStopPct}%, ` +
      `${formatUsd(a.amountUsd)} x ${autoSlots(a)}, at most ${a.maxTrades} trades a day, ` +
      `take-profit +${a.takeProfitPct}%${a.takeProfitPortion < 1 ? ` on ${Math.round(a.takeProfitPortion * 100)}% of the shares` : ""}, ` +
      `stop -${a.stopPct}%` +
      `${a.stopToEntryAtPct > 0 ? `, to the entry at +${a.stopToEntryAtPct}%` : ""}` +
      `${a.takeProfitPortion < 1 && a.trailPct > 0 ? `, then trailing ${a.trailPct}%` : ""}` +
      `${a.minPrice > 0 ? `, alerts from ${formatUsd(a.minPrice)}` : ""}` +
      `${a.paperOnly ? ", paper accounts only" : ", LIVE ACCOUNTS ALLOWED (auto.paperOnly is off)"}` +
      `${state.feed === null ? "; no alert stream yet (the dashboard sets it)" : ""}`,
  );
  journal.write("start", {
    version,
    http_port: config.http.port,
    tws_port: config.tws.port,
    paper_only: config.paperOnly,
    enabled: config.enabled,
    halted: config.halted,
    order: config.order,
    limits: config.limits,
    auto: config.auto,
    auto_mode: auto.mode,
    alert_stream: state.feed?.server ?? null,
  });

  link.start();

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    say(`${signal}: stopping. Orders already in TWS stay in TWS.`);
    journal.write("stop", { signal });
    auto.close();
    watch.close();
    bridge.close();
    link.stop();
    server.close(() => process.exit(0));
    server.closeAllConnections();
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

void main();
