import { SecType } from "@stoqey/ib";
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

  placed(): PlacedOrder[] {
    return this.callsOf("placeOrder").map((call) => ({
      id: call.args[0] as number,
      contract: call.args[1] as Contract,
      order: call.args[2] as Order,
    }));
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
    return this;
  }

  reqContractDetails(reqId: number, contract: Contract): this {
    this.calls.push({ name: "reqContractDetails", args: [reqId, contract] });
    if (this.world.silentLookups) return this;
    queueMicrotask(() => {
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
    });
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
    const ask = this.world.asks.get(contract.symbol ?? "");
    if (ask === undefined) return this;
    queueMicrotask(() => {
      this.emit("tickPrice", reqId, 1, ask - 0.01);
      this.emit("tickPrice", reqId, 2, ask);
      this.emit("tickSnapshotEnd", reqId);
    });
    return this;
  }

  cancelMktData(reqId: number): this {
    this.calls.push({ name: "cancelMktData", args: [reqId] });
    return this;
  }

  placeOrder(id: number, contract: Contract, order: Order): this {
    this.calls.push({ name: "placeOrder", args: [id, contract, order] });
    if (this.world.failPlaceOrderAt === this.callsOf("placeOrder").length) throw new Error("encoder blew up");
    return this;
  }

  cancelOrder(orderId: number): this {
    this.calls.push({ name: "cancelOrder", args: [orderId] });
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

  /** The socket drops. */
  drop(): void {
    this.current.emit("disconnected");
  }

  /** Every order sent on any connection, in order. */
  allPlaced(): PlacedOrder[] {
    return this.instances.flatMap((ib) => ib.placed());
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
