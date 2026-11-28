import type { Response } from 'express';

// The read-only 📐 setup feed (GET /api/tv/feed, 2026-11-28) for the operator's own program on
// their Mac (tools/tws-bridge), which acts on the setups with no browser open. Every setup that
// poller.deliverTvSetup handles is published here, announced or not ('notify' / 'quiet' / 'log'),
// with the gate's reason, so the program can make its own choice. The dashboard's stream
// (services/sse.ts) is a separate thing: it carries the whole cycle payload and needs a login.
// The last 10 minutes are kept in memory, so a program that reconnects gets what it missed; a
// restart of the API loses them (the rows stay in tier_events).

export interface FeedSetup {
  id: string;        // the alert's id as deliverTvSetup builds it (OpportunityAlert.id)
  ticker: string;
  at: string;        // the alert's `at` (ISO)
  stage: string;
  price: number | null;
  mode: 'notify' | 'quiet' | 'log';
  why: 'muted' | 'capped' | 'offlist' | 'weak' | null;
  setup: Record<string, unknown>;   // the alert's `setup` object
}

export const FEED = {
  keep_ms: 10 * 60_000,       // how far back a replay can reach
  max_kept: 500,              // a flood can't grow the buffer past this (the oldest go first)
  default_since_ms: 120_000,  // a client that names no `since` gets the last 2 minutes
  max_clients: 10,            // the route answers the 11th with a 503
  keepalive_ms: 15_000,       // under nginx's 60 s read timeout on /api/ (deploy/nginx.conf)
} as const;

const atMs = (s: FeedSetup) => Date.parse(s.at);

// The buffer once `setup` is added at `nowMs`: in the order published (oldest first), nothing
// older than FEED.keep_ms, at most FEED.max_kept. Pure, so the check script can set the clock.
export function feedBufferAdd(buf: readonly FeedSetup[], setup: FeedSetup, nowMs: number): FeedSetup[] {
  const cutoff = nowMs - FEED.keep_ms;
  return [...buf, setup].filter((s) => atMs(s) >= cutoff).slice(-FEED.max_kept);
}

// What a client that connects at `nowMs` is replayed: the kept setups whose `at` is after
// `sinceMs`, oldest first. No `since` = the last FEED.default_since_ms; one further back than
// FEED.keep_ms counts as FEED.keep_ms ago (the buffer is trimmed only on a publish, so it can
// hold older ones in a quiet spell).
export function feedReplay(buf: readonly FeedSetup[], sinceMs: number | null, nowMs: number): FeedSetup[] {
  const from = Math.max(sinceMs ?? nowMs - FEED.default_since_ms, nowMs - FEED.keep_ms);
  return buf.filter((s) => atMs(s) > from);
}

// One SSE message. JSON.stringify escapes newlines, so the data is always one line.
export function sseText(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

type FeedClient = { res: Response };
const clients = new Set<FeedClient>();
let buffer: FeedSetup[] = [];

// A write that throws removes the client (the route's close handler may not have run yet).
function send(client: FeedClient, text: string): boolean {
  try {
    client.res.write(text);
    return true;
  } catch {
    clients.delete(client);
    return false;
  }
}

export function publishFeedSetup(setup: FeedSetup): void {
  buffer = feedBufferAdd(buffer, setup, Date.now());
  const text = sseText('setup', setup);
  for (const c of clients) send(c, text);
}

// The headers are the dashboard stream's (services/sse.ts); X-Accel-Buffering keeps nginx from
// holding events back. The hello and the replay are written before anything else can be
// published (all of it runs in one go), so a setup is neither missed nor sent twice.
export function addFeedClient(res: Response, sinceMs: number | null): () => void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const client: FeedClient = { res };
  clients.add(client);
  const now = Date.now();
  const replay = feedReplay(buffer, sinceMs, now);
  if (send(client, sseText('hello', { now: new Date(now).toISOString(), replayed: replay.length }))) {
    for (const s of replay) if (!send(client, sseText('setup', s))) break;
  }
  return () => {
    clients.delete(client);
  };
}

export function feedClientCount(): number {
  return clients.size;
}

// A comment line to every client, so a quiet feed isn't closed as idle. Exported for the checks.
export function feedKeepalive(): void {
  for (const c of clients) send(c, ': keepalive\n\n');
}

setInterval(feedKeepalive, FEED.keepalive_ms).unref();
