import { IBApi } from "@stoqey/ib";
import type { Contract, ExecutionFilter, Order } from "@stoqey/ib";

export interface IbApiOptions {
  host: string;
  port: number;
  clientId: number;
  maxReqPerSec: number;
}

/**
 * The part of `@stoqey/ib`'s `IBApi` the bridge uses, and nothing else. The real class satisfies
 * it (`npm run typecheck` proves that against the installed typings); tests inject a fake.
 *
 * One object is one connection attempt. The library keeps every call made while its socket is
 * down in a queue and sends the queue when that same object connects again, so an object is
 * thrown away when its connection ends and never reconnected: nothing queued can reach TWS later.
 */
export interface IbApi {
  connect(clientId?: number): unknown;
  disconnect(): unknown;
  reqContractDetails(reqId: number, contract: Contract): unknown;
  reqMktData(
    reqId: number,
    contract: Contract,
    genericTickList: string | null,
    snapshot: boolean,
    regulatorySnapshot: boolean,
  ): unknown;
  cancelMktData(reqId: number): unknown;
  /** Places an order; with the id of an order TWS already has, changes that order. */
  placeOrder(id: number, contract: Contract, order: Order): unknown;
  cancelOrder(orderId: number): unknown;
  /** Starts the stream of the accounts' positions: all of them, `positionEnd`, then every change. */
  reqPositions(): unknown;
  cancelPositions(): unknown;
  queryDisplayGroups(reqId: number): unknown;
  subscribeToGroupEvents(reqId: number, groupId: number): unknown;
  updateDisplayGroup(reqId: number, contractInfo: string): unknown;
  reqOpenOrders(): unknown;
  reqExecutions(reqId: number, filter: ExecutionFilter): unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeAllListeners(): unknown;
}

export type IbApiFactory = (options: IbApiOptions) => IbApi;

/**
 * All four options are always passed. The library falls back to its own configuration for a
 * missing one, and reading that configuration runs `dotenv`, which would load a `.env` file from
 * the working directory into this process.
 */
export const createIbApi: IbApiFactory = (options) => new IBApi(options);
