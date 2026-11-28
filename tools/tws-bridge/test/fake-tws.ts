import { SecType, isNonFatalError } from "@stoqey/ib";
import type { Contract, ContractDetails, ExecutionFilter, Order } from "@stoqey/ib";
import type { IbApi, IbApiFactory, IbApiOptions } from "../src/ib.js";

export interface Call {
  name: string;
  args: unknown[];
}

export interface PlacedOrder {
  id: number;
  contract: Contract;
  order: Order;
}

/** A quote stream open on a connection: a `reqMktData` that is not a snapshot, not yet cancelled. */
export interface OpenStream {
  reqId: number;
  /** The contract's id as the bridge sent it (null when it sent none). */
  conId: number | null;
  symbol: string | null;
}

export type StreamField = "bid" | "ask" | "last";

/** The tick types TWS sends a stream's real-time bid, ask and last trade under. */
const STREAM_TICK_TYPES: Record<StreamField, number> = { bid: 1, ask: 2, last: 4 };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Listener = (...args: any[]) => void;

/** One fake library object = one connection attempt, exactly like the real `IBApi` is used. */
export class FakeIb implements IbApi {
  readonly calls: Call[] = [];
  readonly options: IbApiOptions;
  private readonly world: FakeTws;
  private readonly listeners = new Map<string, Listener[]>();
  /** Display group → the request id it was subscribed with on this connection. */
  private readonly groupSubscriptions = new Map<number, number>();
  /** Request id → the quote stream open under it on this connection. */
  private readonly openStreams = new Map<number, OpenStream>();

  constructor(options: IbApiOptions, world: FakeTws) {
    this.options = options;
    this.world = world;
  }

  /** What TWS would send to this connection. */
  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }

  callsOf(name: string): Call[] {
    return this.calls.filter((call) => call.name === name);
  }

  /** The new orders sent on this connection. A change to an order is not one: see {@link modified}. */
  placed(): PlacedOrder[] {
    return this.callsOf("placeOrder").map((call) => ({
      id: call.args[0] as number,
      contract: call.args[1] as Contract,
      order: call.args[2] as Order,
    }));
  }

  /**
   * The changes sent on this connection: on the wire each is a `placeOrder` for an id TWS already
   * has, and it is kept apart here (as `modifyOrder`) so "nothing new was placed" stays easy to say.
   */
  modified(): PlacedOrder[] {
    return this.callsOf("modifyOrder").map((call) => ({
      id: call.args[0] as number,
      contract: call.args[1] as Contract,
      order: call.args[2] as Order,
    }));
  }

  /** The order with this id as it was last sent (placed or changed) on this connection. */
  lastSent(id: number): PlacedOrder | undefined {
    return [...this.placed(), ...this.modified()].filter((sent) => sent.id === id).pop();
  }

  /**
   * TWS reports an order as it has it now (`openOrder`): by default exactly as it was last sent
   * on this connection, with `overrides` for what TWS has differently (a price dragged by hand).
   */
  reports(id: number, overrides: Partial<Order> = {}): void {
    const sent = this.lastSent(id);
    const order = { ...(sent?.order ?? {}), clientId: this.options.clientId, ...overrides } as Order;
    this.emit("openOrder", id, sent?.contract ?? {}, order, { status: "Submitted" });
  }

  on(event: string, listener: Listener): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  removeAllListeners(): this {
    this.calls.push({ name: "removeAllListeners", args: [] });
    this.listeners.clear();
    return this;
  }

  connect(clientId?: number): this {
    this.calls.push({ name: "connect", args: [clientId] });
    setImmediate(() => {
      if (this.world.mode === "refuse") {
        this.emit("error", new Error(`connect ECONNREFUSED 127.0.0.1:${this.options.port}`), 502, -1);
        this.emit("disconnected");
      } else if (this.world.mode === "accept") {
        this.emit("connected");
        if (this.world.accounts !== null) this.emit("managedAccounts", this.world.accounts);
        this.emit("nextValidId", this.world.nextValidId);
      }
      // "hang": the socket opens and TWS never says anything.
    });
    return this;
  }

  disconnect(): this {
    this.calls.push({ name: "disconnect", args: [] });
    // TWS ends a connection's quote streams with its socket.
    this.openStreams.clear();
    return this;
  }

  reqContractDetails(reqId: number, contract: Contract): this {
    this.calls.push({ name: "reqContractDetails", args: [reqId, contract] });
    if (this.world.silentLookups) return this;
    const answer = (): void => {
      // By symbol, or (with no symbol given) by contract id alone.
      const found =
        contract.symbol !== undefined
          ? this.world.contracts.get(contract.symbol)
          : [...this.world.contracts.values()]
              .map((listings) => listings.filter((details) => details.contract.conId === contract.conId))
              .find((listings) => listings.length > 0);
      if (found === undefined) {
        this.emit("error", new Error("No security definition has been found for the request"), 200, reqId);
        return;
      }
      for (const details of found) this.emit("contractDetails", reqId, details);
      this.emit("contractDetailsEnd", reqId);
    };
    // A slow TWS: the answer waits until the test lets it go (FakeTws.answerLookups).
    if (this.world.holdLookups) this.world.heldLookups.push(answer);
    else queueMicrotask(answer);
    return this;
  }

  reqMktData(
    reqId: number,
    contract: Contract,
    genericTickList: string | null,
    snapshot: boolean,
    regulatorySnapshot: boolean,
  ): this {
    this.calls.push({ name: "reqMktData", args: [reqId, contract, genericTickList, snapshot, regulatorySnapshot] });
    if (!snapshot) {
      this.openStream(reqId, contract);
      return this;
    }
    // What happens in TWS between the bridge asking for a quote and getting it (a fill, say).
    this.world.onMktData?.(this, reqId);
    const symbol = contract.symbol ?? "";
    const ask = this.world.asks.get(symbol);
    // A bid of its own, or one cent under the ask when only the ask is set.
    const bid = this.world.bids.get(symbol) ?? (ask === undefined ? undefined : ask - 0.01);
    if (ask === undefined && bid === undefined) return this;
    queueMicrotask(() => {
      if (bid !== undefined) this.emit("tickPrice", reqId, 1, bid);
      if (ask !== undefined) this.emit("tickPrice", reqId, 2, ask);
      this.emit("tickSnapshotEnd", reqId);
    });
    return this;
  }

  cancelMktData(reqId: number): this {
    this.calls.push({ name: "cancelMktData", args: [reqId] });
    this.openStreams.delete(reqId);
    return this;
  }

  /**
   * A stream opens silent: a real TWS sends the current quote at once, here a test sends it with
   * {@link tick}. A contract in `world.refusedStreams` is answered with that error instead (a
   * warning code still opens the stream, as in TWS).
   */
  private openStream(reqId: number, contract: Contract): void {
    const conId = contract.conId ?? null;
    const stream: OpenStream = { reqId, conId, symbol: contract.symbol ?? null };
    const refusal = conId === null ? undefined : this.world.refusedStreams.get(conId);
    if (refusal === undefined) {
      this.openStreams.set(reqId, stream);
      return;
    }
    const err = new Error(refusal.message);
    if (isNonFatalError(refusal.code, err)) this.openStreams.set(reqId, stream);
    queueMicrotask(() => this.emit("error", err, refusal.code, reqId));
  }

  /** The quote streams open on this connection, oldest first. */
  streams(): OpenStream[] {
    return [...this.openStreams.values()];
  }

  /**
   * The quote moves: the real-time tick (bid 1, ask 2, last 4) is sent on every open stream of
   * this contract on this connection. Returns how many streams it reached.
   */
  tick(conid: number, field: StreamField, price: number): number {
    const reached = this.streams().filter((stream) => stream.conId === conid);
    for (const stream of reached) this.emit("tickPrice", stream.reqId, STREAM_TICK_TYPES[field], price);
    return reached.length;
  }

  /** Any `tickPrice` under any request id: a delayed tick (66 / 67 / 68), -1, NaN, a dead id. */
  rawTick(reqId: number, tickType: number, value: number): void {
    this.emit("tickPrice", reqId, tickType, value);
  }

  /**
   * TWS reports an error against a stream's request id, at once. An error ends the stream (in TWS
   * too); a warning (a code the library counts as non-fatal) leaves it open.
   */
  streamError(reqId: number, code: number, message = `TWS error ${code}`): void {
    const err = new Error(message);
    if (!isNonFatalError(code, err)) this.openStreams.delete(reqId);
    this.emit("error", err, code, reqId);
  }

  /**
   * As TWS does: an id it does not have is a new order, an id it has is a change to that order.
   * The two are logged under different names (`placeOrder` / `modifyOrder`).
   */
  placeOrder(id: number, contract: Contract, order: Order): this {
    const change = this.world.orderIds.has(id);
    this.world.orderIds.add(id);
    this.calls.push({ name: change ? "modifyOrder" : "placeOrder", args: [id, contract, order] });
    if (!change && this.world.failPlaceOrderAt === this.callsOf("placeOrder").length) throw new Error("encoder blew up");
    if (change && this.world.failModifyAt === this.callsOf("modifyOrder").length) throw new Error("encoder blew up");
    this.world.onOrder?.(this, id, order, change);
    return this;
  }

  cancelOrder(orderId: number): this {
    this.calls.push({ name: "cancelOrder", args: [orderId] });
    this.world.onCancel?.(this, orderId);
    return this;
  }

  /** As TWS does: every position line, then the end marker (and then changes, which the fake has none of). */
  reqPositions(): this {
    this.calls.push({ name: "reqPositions", args: [] });
    if (this.world.silentPositions) return this;
    queueMicrotask(() => {
      const account = (this.world.accounts ?? "").split(",")[0] ?? "";
      for (const [conId, shares] of this.world.positions) this.emit("position", account, { conId }, shares, 0);
      for (const row of this.world.otherPositions) this.emit("position", row.account, { conId: row.conId }, row.shares, 0);
      this.emit("positionEnd");
    });
    return this;
  }

  cancelPositions(): this {
    this.calls.push({ name: "cancelPositions", args: [] });
    return this;
  }

  queryDisplayGroups(reqId: number): this {
    this.calls.push({ name: "queryDisplayGroups", args: [reqId] });
    const groups = this.world.groups;
    if (groups !== null) queueMicrotask(() => this.emit("displayGroupList", reqId, groups));
    return this;
  }

  /** As TWS does: a subscription is answered once with what the group shows now. */
  subscribeToGroupEvents(reqId: number, groupId: number): this {
    this.calls.push({ name: "subscribeToGroupEvents", args: [reqId, groupId] });
    this.groupSubscriptions.set(groupId, reqId);
    if (!this.world.silentGroups.has(groupId)) {
      queueMicrotask(() => this.emit("displayGroupUpdated", reqId, this.world.groupShows.get(groupId) ?? "none"));
    }
    return this;
  }

  /** As TWS does: the group changes, and its subscribers are told. */
  updateDisplayGroup(reqId: number, contractInfo: string): this {
    this.calls.push({ name: "updateDisplayGroup", args: [reqId, contractInfo] });
    for (const [groupId, subscriptionId] of this.groupSubscriptions) {
      if (subscriptionId !== reqId) continue;
      if (this.world.ignoreGroupUpdates) continue;
      this.world.groupShows.set(groupId, contractInfo);
      queueMicrotask(() => this.emit("displayGroupUpdated", reqId, contractInfo));
    }
    return this;
  }

  /** The request id a display group was subscribed with on this connection. */
  subscriptionOf(groupId: number): number | undefined {
    return this.groupSubscriptions.get(groupId);
  }

  /** The operator picks something else in a TWS window linked to this group. */
  operatorShows(groupId: number, contractInfo: string): void {
    this.world.groupShows.set(groupId, contractInfo);
    const reqId = this.groupSubscriptions.get(groupId);
    if (reqId !== undefined) this.emit("displayGroupUpdated", reqId, contractInfo);
  }

  reqOpenOrders(): this {
    this.calls.push({ name: "reqOpenOrders", args: [] });
    return this;
  }

  reqExecutions(reqId: number, filter: ExecutionFilter): this {
    this.calls.push({ name: "reqExecutions", args: [reqId, filter] });
    return this;
  }
}

export function listing(symbol: string, conId: number, primaryExch: string, currency = "USD"): ContractDetails {
  return { contract: { conId, symbol, secType: SecType.STK, exchange: "SMART", primaryExch, currency } };
}

/** The TWS on the other end: what it knows and how it behaves. No sockets, no network. */
export class FakeTws {
  readonly instances: FakeIb[] = [];
  mode: "accept" | "refuse" | "hang" = "accept";
  /** The managed-accounts list TWS sends on connect; null = it sends none. */
  accounts: string | null = "DU1234567";
  nextValidId = 1000;
  readonly contracts = new Map<string, ContractDetails[]>([
    ["ABCD", [listing("ABCD", 111, "NASDAQ")]],
    ["WXYZ", [listing("WXYZ", 222, "NYSE")]],
    ["QQQQ", [listing("QQQQ", 333, "ARCA")]],
    ["PENY", [listing("PENY", 444, "NASDAQ")]],
    ["BRK B", [listing("BRK B", 555, "NYSE")]],
  ]);
  readonly asks = new Map<string, number>();
  /** The live bid per symbol. A symbol with an ask and no bid here bids one cent under its ask. */
  readonly bids = new Map<string, number>();
  /** The (first) account's position per contract id. A contract not in here has no position line. */
  readonly positions = new Map<number, number>();
  /** Position lines of other accounts, or lines TWS garbles (`shares` not a number). */
  otherPositions: Array<{ account: string; conId: number; shares: number | undefined }> = [];
  /** TWS never answers the positions request. */
  silentPositions = false;
  /** Every order id TWS has been sent, on any connection: a `placeOrder` for one of them is a change. */
  readonly orderIds = new Set<number>();
  /** Make the Nth change to an order on a connection throw (1 = the first). */
  failModifyAt = 0;
  /**
   * TWS's side of the story, told at the moment the bridge acts. Each is called inside the
   * bridge's own call; to answer as TWS does (afterwards), emit from a `queueMicrotask`.
   */
  onOrder: ((ib: FakeIb, id: number, order: Order, change: boolean) => void) | null = null;
  onCancel: ((ib: FakeIb, id: number) => void) | null = null;
  /** Called for a snapshot only: a quote stream's start is not "asking for a price" here. */
  onMktData: ((ib: FakeIb, reqId: number) => void) | null = null;
  /** Contract id → the error TWS answers a quote stream for it with (354 "not subscribed", say). */
  readonly refusedStreams = new Map<number, { code: number; message: string }>();
  /** The display groups TWS lists, most used first ("4|1|2|5"); null = it never answers the question. */
  groups: string | null = null;
  /** What a display group shows: "<conid>@<exchange>", "none" or "combo". A group not in here shows "none". */
  readonly groupShows = new Map<number, string>();
  /** Groups that do not say what they show when subscribed to. */
  readonly silentGroups = new Set<number>();
  /** TWS takes an `updateDisplayGroup` and nothing happens: no window moves, no event comes back. */
  ignoreGroupUpdates = false;
  /** TWS never answers a contract lookup. */
  silentLookups = false;
  /** TWS answers a contract lookup only when the test says so ({@link answerLookups}): a slow lookup. */
  holdLookups = false;
  /** The answers to lookups held back, oldest first. */
  readonly heldLookups: Array<() => void> = [];
  /** Make the Nth placeOrder call on a connection throw (1 = the first). */
  failPlaceOrderAt = 0;

  readonly factory: IbApiFactory = (options) => {
    const ib = new FakeIb(options, this);
    this.instances.push(ib);
    return ib;
  };

  /** The connection in use: the newest library object. */
  get current(): FakeIb {
    const ib = this.instances[this.instances.length - 1];
    if (ib === undefined) throw new Error("no connection was ever opened");
    return ib;
  }

  /** TWS answers every contract lookup it held back, in the order they were asked. */
  answerLookups(): void {
    for (const answer of this.heldLookups.splice(0)) answer();
  }

  /** The socket drops. */
  drop(): void {
    this.current.emit("disconnected");
  }

  /** The quote streams open on the connection in use. */
  streams(): OpenStream[] {
    return this.current.streams();
  }

  /** The quote moves, on the connection in use: see {@link FakeIb.tick}. */
  tick(conid: number, field: StreamField, price: number): number {
    return this.current.tick(conid, field, price);
  }

  /** Every new order sent on any connection, in order. */
  allPlaced(): PlacedOrder[] {
    return this.instances.flatMap((ib) => ib.placed());
  }

  /** Every change to an order sent on any connection, in order. */
  allModified(): PlacedOrder[] {
    return this.instances.flatMap((ib) => ib.modified());
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function until(condition: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await sleep(2);
  }
}
