import { EventName, isNonFatalError } from "@stoqey/ib";
import type { Contract, ContractDetails, Execution, Order } from "@stoqey/ib";
import type { IbApi, IbApiFactory } from "./ib.js";

/**
 * TWS reports an error against "an id", and request ids share that number space with order ids.
 * The bridge's own request ids start here, far above any order id, so an error about a lookup can
 * never be read as an error about an order.
 */
export const REQUEST_ID_BASE = 900_000_000;

/** TWS tick type of the real-time ask. Delayed asks (type 67) are never used as a price. */
const TICK_ASK = 2;

/**
 * TWS lost / got back its own connection to IB's servers (the socket to TWS stays up): 1100 when
 * it drops, 2110 when the bridge connects while it is down, 1101 / 1102 when it is back.
 */
const CODE_SERVER_LINK_LOST = [1100, 2110];
const CODE_SERVER_LINK_BACK = [1101, 1102];

/** "Market data farm connection is OK" and the like: said on every connect, not worth a log line. */
const QUIET_INFO_CODES = new Set([2104, 2106, 2107, 2108, 2158]);

export class NotConnectedError extends Error {
  constructor(message = "TWS is not connected") {
    super(message);
    this.name = "NotConnectedError";
  }
}

/** TWS answered a request with an error. */
export class TwsRequestError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "TwsRequestError";
    this.code = code;
  }
}

export class TwsTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TwsTimeoutError";
  }
}

export interface OrderStatusEvent {
  orderId: number;
  status: string;
  filled: number;
  remaining: number;
  avgFillPrice: number;
}

export interface ExecutionEvent {
  orderId: number;
  execId: string;
  shares: number;
  price: number;
  cumQty: number | null;
  avgPrice: number | null;
  time: string | null;
}

export interface OrderMessageEvent {
  orderId: number;
  code: number;
  message: string;
  /** True for TWS warnings and notices that do not stop the order. */
  nonFatal: boolean;
}

export interface LinkHandlers {
  onUp?(info: { accounts: string[]; nextValidId: number }): void;
  onAccounts?(accounts: string[]): void;
  onDown?(reason: string): void;
  onOrderStatus?(event: OrderStatusEvent): void;
  onExecution?(event: ExecutionEvent): void;
  onOrderMessage?(event: OrderMessageEvent): void;
  /** TWS listed its display groups: once per connection, if it answers at all. */
  onDisplayGroups?(groups: number[]): void;
  /** A display group said what it shows: `"<conid>@<exchange>"`, `"none"` or `"combo"`. */
  onDisplayGroupShows?(group: number, contractInfo: string, detail: DisplayGroupEvent): void;
  /** Things worth a log line: TWS notices, display-group answers, lookup errors that came late. */
  onNote?(kind: string, fields: Record<string, unknown>): void;
}

export interface LinkOptions {
  factory: IbApiFactory;
  host: string;
  port: number;
  clientId: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  handshakeTimeoutMs?: number;
  maxReqPerSec?: number;
  /** The gap between two messages the bridge sends for itself rather than for a click. */
  backgroundGapMs?: number;
}

export interface DisplayGroupContent {
  id: number;
  /** What TWS last said the group shows, or null when it has not said. */
  contractInfo: string | null;
}

/** The rest of a `displayGroupUpdated` event, for the log. */
export interface DisplayGroupEvent {
  /** The contract-info string exactly as TWS sent it. */
  raw: string;
  /** The request id of the group's subscription the event came under. */
  requestId: number;
}

/** What a `/focus` put on the wire. */
export interface FocusSent {
  /** The request id of the group's subscription: `updateDisplayGroup` goes out under it. */
  requestId: number;
  /** The string sent to TWS: `"<conid>@SMART"`. */
  contractInfo: string;
}

type Pending =
  | {
      kind: "contract";
      items: ContractDetails[];
      resolve: (items: ContractDetails[]) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
    }
  | {
      kind: "snapshot";
      resolve: (ask: number | null) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
    };

/**
 * The connection to TWS: connects, reconnects with backoff, hands out order ids and matches
 * answers to requests.
 *
 * What it never does is send anything on its own after a reconnect. Each connection gets a new
 * library object and the old one is discarded with whatever it had queued, and `placeOrder`
 * throws unless the connection is up at that very moment.
 */
export class TwsLink {
  handlers: LinkHandlers = {};

  private readonly factory: IbApiFactory;
  private readonly host: string;
  private readonly port: number;
  private readonly clientId: number;
  private readonly reconnectMinMs: number;
  private readonly reconnectMaxMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly maxReqPerSec: number;
  private readonly backgroundGapMs: number;

  private api: IbApi | null = null;
  private ready = false;
  private stopped = true;
  private accounts: string[] = [];
  private serverLinkLost = false;
  private displayGroups: number[] | null = null;
  /** Display group → the request id of its subscription on this connection. */
  private readonly groupSubscriptions = new Map<number, number>();
  /** Display group → what TWS last said it shows. */
  private readonly groupShows = new Map<number, string>();
  private readonly pending = new Map<number, Pending>();
  /** What the bridge sends for itself, waiting its turn: see {@link inBackground}. */
  private backgroundQueue: Array<() => void> = [];
  private backgroundTimer: NodeJS.Timeout | null = null;

  private nextRequestId = REQUEST_ID_BASE;
  /** Only ever grows within one run of the bridge, so an order id is never used twice. */
  private nextOrderId = 0;

  private backoffMs: number;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private handshakeTimer: NodeJS.Timeout | null = null;
  private lastError: string | null = null;
  private announcedDownReason: string | null = null;

  constructor(options: LinkOptions) {
    this.factory = options.factory;
    this.host = options.host;
    this.port = options.port;
    this.clientId = options.clientId;
    this.reconnectMinMs = options.reconnectMinMs ?? 1000;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 30000;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 15000;
    this.maxReqPerSec = options.maxReqPerSec ?? 40;
    this.backgroundGapMs = options.backgroundGapMs ?? 150;
    this.backoffMs = this.reconnectMinMs;
  }

  /** Up means: socket connected and TWS has sent the next valid order id. */
  isReady(): boolean {
    return this.ready;
  }

  getAccounts(): string[] {
    return [...this.accounts];
  }

  /** True while TWS says it has lost IB's servers: an order sent now would sit in TWS and go out later. */
  isServerLinkLost(): boolean {
    return this.serverLinkLost;
  }

  /** The display groups TWS listed for this connection, or null when it has not answered. */
  getDisplayGroups(): number[] | null {
    return this.displayGroups === null ? null : [...this.displayGroups];
  }

  /**
   * What each display group shows, by group number: the groups TWS listed, and any other the
   * bridge has subscribed to for `/focus`. Empty while not connected.
   */
  getDisplayGroupContents(): DisplayGroupContent[] {
    const ids = new Set<number>([...(this.displayGroups ?? []), ...this.groupSubscriptions.keys()]);
    return [...ids]
      .sort((a, b) => a - b)
      .map((id) => ({ id, contractInfo: this.groupShows.get(id) ?? null }));
  }

  /**
   * Queues something the bridge does for itself (learning what the display groups show). Such
   * tasks run one at a time with a gap between them and after them, and never at once: the
   * library sends at most 4 messages per 100 ms and queues the rest, so paced like this they
   * cannot hold up the messages of a click. They are dropped with the connection. Returns false
   * when there is no connection to queue for.
   */
  inBackground(task: () => void): boolean {
    if (this.api === null || !this.ready) return false;
    this.backgroundQueue.push(task);
    this.scheduleBackground();
    return true;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.drop("the bridge is stopping");
  }

  /** Ids below this were used earlier today (known from the log): they are never handed out again. */
  raiseOrderIdFloor(nextId: number): void {
    if (Number.isInteger(nextId)) this.nextOrderId = Math.max(this.nextOrderId, nextId);
  }

  /** Reserves `count` consecutive order ids and returns the first. */
  allocateOrderIds(count: number): number {
    this.requireApi();
    const first = this.nextOrderId;
    if (!Number.isInteger(first) || first < 1 || first + count >= REQUEST_ID_BASE) {
      throw new Error(`TWS gave an unusable next order id (${first})`);
    }
    this.nextOrderId = first + count;
    return first;
  }

  /** Sends one order now. Throws when the connection is not up; nothing is ever queued for later. */
  placeOrder(orderId: number, contract: Contract, order: Order): void {
    this.requireApi().placeOrder(orderId, contract, order);
  }

  cancelOrder(orderId: number): void {
    this.requireApi().cancelOrder(orderId);
  }

  /** Asks TWS again for this client's open orders and today's fills. Reads only. */
  syncOrders(): void {
    const api = this.requireApi();
    api.reqOpenOrders();
    api.reqExecutions(this.takeRequestId(), { clientId: String(this.clientId) });
  }

  /** All contracts TWS knows for this description; rejects on a TWS error or after `timeoutMs`. */
  contractDetails(contract: Contract, timeoutMs: number): Promise<ContractDetails[]> {
    const api = this.requireApi();
    const reqId = this.takeRequestId();
    return new Promise<ContractDetails[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new TwsTimeoutError(`TWS did not answer the contract lookup within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(reqId, { kind: "contract", items: [], resolve, reject, timer });
      api.reqContractDetails(reqId, contract);
    });
  }

  /**
   * One market-data snapshot; resolves with the real-time ask, or null when none came in time.
   * `snapshot` is true and `regulatorySnapshot` is always false: the regulatory one costs money
   * per request.
   */
  askSnapshot(contract: Contract, timeoutMs: number): Promise<number | null> {
    const api = this.requireApi();
    const reqId = this.takeRequestId();
    return new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        if (this.api === api) api.cancelMktData(reqId);
        resolve(null);
      }, timeoutMs);
      this.pending.set(reqId, { kind: "snapshot", resolve, reject, timer });
      api.reqMktData(reqId, contract, "", true, false);
    });
  }

  /**
   * Makes the TWS windows linked to `group` show a contract. The group is subscribed to once per
   * connection; every later call only sends the update.
   */
  focus(group: number, conid: number): FocusSent {
    const api = this.requireApi();
    const requestId = this.subscribeToGroup(group);
    const contractInfo = `${conid}@SMART`;
    api.updateDisplayGroup(requestId, contractInfo);
    return { requestId, contractInfo };
  }

  /** Subscribes to a display group unless this connection already has, and returns its request id. */
  private subscribeToGroup(group: number): number {
    const api = this.requireApi();
    let reqId = this.groupSubscriptions.get(group);
    if (reqId === undefined) {
      reqId = this.takeRequestId();
      this.groupSubscriptions.set(group, reqId);
      api.subscribeToGroupEvents(reqId, group);
    }
    return reqId;
  }

  private scheduleBackground(): void {
    if (this.backgroundTimer !== null) return;
    this.backgroundTimer = setTimeout(() => {
      this.backgroundTimer = null;
      const task = this.backgroundQueue.shift();
      if (task === undefined || this.api === null || !this.ready) {
        this.backgroundQueue = [];
        return;
      }
      try {
        task();
      } catch (err) {
        this.reportFailure("background task", err);
      }
      // The gap is kept after the last task as well, so the next one queued still waits.
      this.scheduleBackground();
    }, this.backgroundGapMs);
  }

  /** A failure in the bridge's own handling of an event: said, never thrown into the socket. */
  private reportFailure(where: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    try {
      this.handlers.onNote?.("internal_error", { where, message });
    } catch {
      // The log itself failed: the console line below is all that is left.
    }
    console.error(`tws-bridge: error while handling ${where}:`, err);
  }

  private requireApi(): IbApi {
    if (this.api === null || !this.ready) throw new NotConnectedError();
    return this.api;
  }

  private takeRequestId(): number {
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return id;
  }

  private open(): void {
    if (this.stopped || this.api !== null) return;
    const api = this.factory({
      host: this.host,
      port: this.port,
      clientId: this.clientId,
      maxReqPerSec: this.maxReqPerSec,
    });
    this.api = api;
    this.ready = false;
    this.lastError = null;
    this.attach(api);
    this.handshakeTimer = setTimeout(() => {
      if (this.api === api && !this.ready) {
        this.lastError ??= `TWS did not finish the API handshake within ${this.handshakeTimeoutMs} ms`;
        this.drop("handshake timeout");
      }
    }, this.handshakeTimeoutMs);
    api.connect(this.clientId);
  }

  private attach(api: IbApi): void {
    // Events of an object that is no longer the current connection are dropped. A listener that
    // throws is reported and goes no further: the library calls listeners from its socket
    // handler, where an exception would lose the other events of that read and end the process.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const on = (event: string, listener: (...args: any[]) => void): void => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      api.on(event, (...args: any[]) => {
        if (this.api !== api) return;
        try {
          listener(...args);
        } catch (err) {
          this.reportFailure(`the ${event} event`, err);
        }
      });
    };

    on(EventName.nextValidId, (orderId: number) => {
      if (!Number.isInteger(orderId) || orderId < 1) return;
      this.nextOrderId = Math.max(this.nextOrderId, orderId);
      if (this.ready) return;
      this.ready = true;
      this.backoffMs = this.reconnectMinMs;
      this.announcedDownReason = null;
      if (this.handshakeTimer !== null) {
        clearTimeout(this.handshakeTimer);
        this.handshakeTimer = null;
      }
      api.queryDisplayGroups(this.takeRequestId());
      this.handlers.onUp?.({ accounts: this.getAccounts(), nextValidId: this.nextOrderId });
    });

    on(EventName.managedAccounts, (list: string) => {
      this.accounts = String(list)
        .split(",")
        .map((account) => account.trim())
        .filter((account) => account !== "");
      this.handlers.onAccounts?.(this.getAccounts());
    });

    on(EventName.disconnected, () => {
      this.drop("TWS closed the connection");
    });

    on(EventName.error, (err: Error, code: number, reqId: number) => {
      this.onError(err, code, reqId);
    });

    on(EventName.info, (message: string, code: number) => {
      if (CODE_SERVER_LINK_LOST.includes(code)) this.serverLinkLost = true;
      else if (CODE_SERVER_LINK_BACK.includes(code)) this.serverLinkLost = false;
      if (!QUIET_INFO_CODES.has(code)) this.handlers.onNote?.("tws_notice", { code, message });
    });

    on(EventName.contractDetails, (reqId: number, details: ContractDetails) => {
      const pending = this.pending.get(reqId);
      if (pending?.kind === "contract") pending.items.push(details);
    });

    on(EventName.contractDetailsEnd, (reqId: number) => {
      const pending = this.pending.get(reqId);
      if (pending?.kind !== "contract") return;
      this.settle(reqId);
      pending.resolve(pending.items);
    });

    on(EventName.tickPrice, (reqId: number, field: number, value: number) => {
      const pending = this.pending.get(reqId);
      if (pending?.kind !== "snapshot" || field !== TICK_ASK) return;
      if (!Number.isFinite(value) || value <= 0) return;
      this.settle(reqId);
      pending.resolve(value);
    });

    on(EventName.tickSnapshotEnd, (reqId: number) => {
      const pending = this.pending.get(reqId);
      if (pending?.kind !== "snapshot") return;
      this.settle(reqId);
      pending.resolve(null);
    });

    on(
      EventName.orderStatus,
      (orderId: number, status: string, filled: number, remaining: number, avgFillPrice: number) => {
        this.handlers.onOrderStatus?.({ orderId, status: String(status), filled, remaining, avgFillPrice });
      },
    );

    on(EventName.execDetails, (_reqId: number, _contract: Contract, execution: Execution) => {
      const { orderId, execId, shares, price } = execution;
      if (orderId === undefined || !execId || shares === undefined || price === undefined) return;
      this.handlers.onExecution?.({
        orderId,
        execId,
        shares,
        price,
        cumQty: execution.cumQty ?? null,
        avgPrice: execution.avgPrice ?? null,
        time: execution.time ?? null,
      });
    });

    on(EventName.displayGroupList, (_reqId: number, groups: string) => {
      const listed = [
        ...new Set(
          String(groups)
            .split("|")
            .map((group) => Number(group))
            .filter((group) => Number.isInteger(group) && group > 0),
        ),
      ];
      this.displayGroups = listed;
      this.handlers.onNote?.("display_groups", { groups: listed });
      // Subscribing to a group is how TWS tells what the group shows, now and on every change.
      // One group at a time, in the background; the one `/focus` uses may be subscribed already.
      for (const group of listed) {
        this.inBackground(() => {
          this.subscribeToGroup(group);
        });
      }
      this.handlers.onDisplayGroups?.([...listed]);
    });

    on(EventName.displayGroupUpdated, (reqId: number, contractInfo: string) => {
      for (const [group, subscriptionId] of this.groupSubscriptions) {
        if (subscriptionId !== reqId) continue;
        const raw = String(contractInfo);
        const shows = raw.trim().slice(0, 64);
        this.groupShows.set(group, shows);
        this.handlers.onDisplayGroupShows?.(group, shows, { raw, requestId: reqId });
        return;
      }
      // Under an id that is no subscription of this connection: said, so the log can show it.
      this.handlers.onNote?.("display_group_unknown", { request_id: reqId, contract_info: String(contractInfo).slice(0, 256) });
    });
  }

  private onError(err: Error, code: number, reqId: number): void {
    const message = err instanceof Error ? err.message : String(err);

    if (reqId === undefined || reqId === null || reqId < 0) {
      // About the connection itself (refused, client id in use, ...). `disconnected` follows.
      this.lastError = `${message} (code ${code})`;
      return;
    }

    if (reqId >= REQUEST_ID_BASE) {
      const nonFatal = isNonFatalError(code, err);
      const pending = this.pending.get(reqId);
      if (pending !== undefined) {
        if (nonFatal) return;
        this.settle(reqId);
        pending.reject(new TwsRequestError(code, message));
        return;
      }
      for (const [group, subscriptionId] of this.groupSubscriptions) {
        if (subscriptionId === reqId) {
          this.handlers.onNote?.("display_group_error", { group, code, message });
          return;
        }
      }
      // An answer to a request that already timed out or finished: nothing waits for it.
      return;
    }

    this.handlers.onOrderMessage?.({ orderId: reqId, code, message, nonFatal: isNonFatalError(code, err) });
  }

  private settle(reqId: number): void {
    const pending = this.pending.get(reqId);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.pending.delete(reqId);
  }

  /** Ends the current connection for good and, unless stopping, schedules a new one. */
  private drop(fallbackReason: string): void {
    const api = this.api;
    if (this.handshakeTimer !== null) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
    if (api !== null) {
      this.api = null;
      api.removeAllListeners();
      try {
        api.disconnect();
      } catch {
        // Already closed.
      }
    }

    const wasReady = this.ready;
    this.ready = false;
    this.accounts = [];
    this.serverLinkLost = false;
    this.displayGroups = null;
    this.groupSubscriptions.clear();
    this.groupShows.clear();
    this.backgroundQueue = [];
    if (this.backgroundTimer !== null) {
      clearTimeout(this.backgroundTimer);
      this.backgroundTimer = null;
    }

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new NotConnectedError("the TWS connection dropped"));
    }
    this.pending.clear();

    const reason = this.lastError ?? fallbackReason;
    this.lastError = null;
    if (api === null) return;

    // A TWS that stays closed fails the same way every few seconds: say it once.
    if (!this.stopped && (wasReady || reason !== this.announcedDownReason)) {
      this.announcedDownReason = reason;
      this.handlers.onDown?.(reason);
    }

    if (this.stopped) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.reconnectMaxMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }
}
