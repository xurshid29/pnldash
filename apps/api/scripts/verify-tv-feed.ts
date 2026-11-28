// Regression for the read-only 📐 setup feed (services/tv-feed.ts, GET /api/tv/feed) and its
// token (services/auth.ts generateFeedToken / verifyFeedToken).
// Run:  npx tsx scripts/verify-tv-feed.ts
// The feed is for the operator's own program on their Mac (2026-11-28): every setup the webhook
// delivers, announced or not, with a replay of the last minutes for a program that reconnects. Its
// token carries a scope and no user, so a login check refuses it, and the feed refuses a login.
// Needs no database and no network.

import jwt, { type JwtPayload } from 'jsonwebtoken';
import type { Response } from 'express';
import type { FeedSetup } from '../src/services/tv-feed.js';

// A throwaway secret, set before the auth service is loaded (it reads the variable when it signs).
const SECRET = 'verify-tv-feed-throwaway-secret';
process.env.JWT_SECRET = SECRET;
const { authService } = await import('../src/services/auth.js');
const {
  addFeedClient, FEED, feedBufferAdd, feedClientCount, feedKeepalive, feedReplay, publishFeedSetup, sseText,
} = await import('../src/services/tv-feed.js');

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail = ''): void {
  checks++;
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const throws = (f: () => unknown) => {
  try { f(); return false; } catch { return true; }
};

console.log('The feed token');
{
  const t0 = Date.now();
  const { token, expires_at } = authService.generateFeedToken();
  check('round trip: verifyFeedToken accepts a fresh one', !throws(() => authService.verifyFeedToken(token)));
  const p = jwt.decode(token) as JwtPayload;
  check('the payload is the scope alone (with iat / exp), no user id, no username',
    JSON.stringify(Object.keys(p).sort()) === JSON.stringify(['exp', 'iat', 'scope']) && p.scope === 'tv_feed', JSON.stringify(p));
  const days = (Date.parse(expires_at) - t0) / 86_400_000;
  check('expires in 30 days, and expires_at is the token\'s own exp', Math.abs(days - 30) < 0.01 && Date.parse(expires_at) === (p.exp ?? 0) * 1000,
    `${expires_at} (${days.toFixed(4)} days)`);
  check('a feed token is refused by verifyToken (no login with it, on any route)', throws(() => authService.verifyToken(token)));

  const login = authService.generateToken({ userId: '00000000-0000-0000-0000-000000000001', username: 'op' });
  const user = authService.verifyToken(login);
  check('a login token still passes verifyToken', user.userId === '00000000-0000-0000-0000-000000000001' && user.username === 'op', JSON.stringify(user));
  check('a login token is refused by verifyFeedToken', throws(() => authService.verifyFeedToken(login)));

  const expired = jwt.sign({ scope: 'tv_feed', exp: Math.floor(Date.now() / 1000) - 10 }, SECRET);
  check('an expired feed token is refused', throws(() => authService.verifyFeedToken(expired)));
  const otherKey = jwt.sign({ scope: 'tv_feed' }, 'some-other-secret', { expiresIn: '30d' });
  check('a feed token signed with another secret is refused', throws(() => authService.verifyFeedToken(otherKey)));
  // the payload swapped for one with a later exp, the signature kept
  const [h, , sig] = token.split('.');
  const body = Buffer.from(JSON.stringify({ scope: 'tv_feed', iat: p.iat, exp: (p.exp ?? 0) + 365 * 86_400 })).toString('base64url');
  check('a tampered payload is refused', throws(() => authService.verifyFeedToken(`${h}.${body}.${sig}`)));
  const flipped = token.slice(0, -2) + (token.at(-2) === 'A' ? 'B' : 'A') + token.at(-1);
  check('a tampered signature is refused', throws(() => authService.verifyFeedToken(flipped)));
  const otherScope = jwt.sign({ scope: 'admin' }, SECRET, { expiresIn: '1h' });
  check('a token of another scope is refused by both checks',
    throws(() => authService.verifyFeedToken(otherScope)) && throws(() => authService.verifyToken(otherScope)));
  const scopedLogin = jwt.sign({ userId: 'x', username: 'y', scope: 'tv_feed' }, SECRET, { expiresIn: '1h' });
  check('a scope next to a user id is still not a login', throws(() => authService.verifyToken(scopedLogin)));
  check('garbage is refused by both', throws(() => authService.verifyFeedToken('not.a.token')) && throws(() => authService.verifyToken('not.a.token')));
}

// A setup at `ms`, numbered for the order checks.
const T = Date.parse('2026-11-27T13:31:34.000Z');
const mk = (ms: number, n = 0): FeedSetup => ({
  id: `T${n}:${Math.floor(ms / 1000)}:tv_setup:pop:1`, ticker: `T${n}`, at: new Date(ms).toISOString(), stage: 'pop',
  price: 1, mode: 'notify', why: null, setup: { stage: 'pop' },
});
const ids = (xs: readonly FeedSetup[]) => xs.map((s) => s.ticker).join(',');

console.log('The buffer');
{
  let b: FeedSetup[] = [];
  b = feedBufferAdd(b, mk(T - 3000, 1), T - 3000);
  b = feedBufferAdd(b, mk(T - 2000, 2), T - 2000);
  b = feedBufferAdd(b, mk(T - 1000, 3), T - 1000);
  check('keeps the order published', ids(b) === 'T1,T2,T3', ids(b));
  const before = b;
  feedBufferAdd(b, mk(T, 4), T);
  check('returns a new buffer, the old one unchanged', before.length === 3);

  let old: FeedSetup[] = [];
  old = feedBufferAdd(old, mk(T - 601_000, 1), T - 601_000);   // 10 min 1 s before T
  old = feedBufferAdd(old, mk(T - 599_000, 2), T - 599_000);   // 9 min 59 s before T
  old = feedBufferAdd(old, mk(T, 3), T);
  check('drops what is older than 10 minutes, keeps what is younger', ids(old) === 'T2,T3', ids(old));
  check('…10 minutes to the millisecond is still kept', ids(feedBufferAdd([mk(T - FEED.keep_ms, 1)], mk(T, 2), T)) === 'T1,T2');

  let big: FeedSetup[] = [];
  for (let i = 0; i < 600; i++) big = feedBufferAdd(big, mk(T - 60_000 + i * 100, i), T - 60_000 + i * 100);
  check('caps at 500, the oldest go first', big.length === 500 && big[0].ticker === 'T100' && big[499].ticker === 'T599',
    `${big.length} ${big[0]?.ticker} … ${big.at(-1)?.ticker}`);
}

console.log('The replay');
{
  // built by hand, with one entry past the window that no publish has trimmed yet
  const buf = [mk(T - 660_000, 1), mk(T - 540_000, 2), mk(T - 300_000, 3), mk(T - 90_000, 4), mk(T - 30_000, 5), mk(T - 1000, 6)];
  check('since null = the last 2 minutes', ids(feedReplay(buf, null, T)) === 'T4,T5,T6', ids(feedReplay(buf, null, T)));
  check('a recent since: only what came after it', ids(feedReplay(buf, T - 60_000, T)) === 'T5,T6', ids(feedReplay(buf, T - 60_000, T)));
  check('since an hour ago counts as 10 minutes ago (the stale entry stays out)',
    ids(feedReplay(buf, T - 3_600_000, T)) === 'T2,T3,T4,T5,T6', ids(feedReplay(buf, T - 3_600_000, T)));
  check('a since after everything: nothing', feedReplay(buf, T + 1000, T).length === 0 && feedReplay(buf, T - 1000, T).length === 0);
  check('after means after: a setup at exactly `since` is not replayed', ids(feedReplay(buf, T - 30_000, T)) === 'T6');
  check('an empty buffer: nothing', feedReplay([], null, T).length === 0);
}

console.log('The SSE text');
check('one message: event line, one data line, a blank line', sseText('x', { a: 'b\nc' }) === 'event: x\ndata: {"a":"b\\nc"}\n\n');

// A stand-in for the Express response: what the feed sets and writes.
function fakeRes(opts: { throwOn?: (text: string) => boolean } = {}) {
  const headers: Record<string, string> = {};
  const out: string[] = [];
  const f = {
    headers, out, flushed: false, broken: false,
    setHeader(k: string, v: string) { headers[k] = v; },
    flushHeaders() { f.flushed = true; },
    write(text: string) {
      if (f.broken || opts.throwOn?.(text)) throw new Error('socket gone');
      out.push(text);
      return true;
    },
  };
  return f;
}
const asRes = (f: ReturnType<typeof fakeRes>) => f as unknown as Response;

console.log('A client');
{
  const realNow = Date.now;
  let now = T;
  Date.now = () => now;
  try {
    const pop: FeedSetup = {
      id: 'FFAI:1795786264:tv_setup:pop:1', ticker: 'FFAI', at: '2026-11-27T13:31:04.000Z', stage: 'pop', price: 1.23,
      mode: 'notify', why: null,
      setup: { stage: 'pop', weak: false, vol_x: 34.5, tv_rv1: 48210, tv_rv5: 11975, ran_pct: 12.1, pop_n: 1, on_screen: false, notified: true, tf: '1' },
    };
    now = T - 30_000;
    publishFeedSetup(pop);
    now = T;
    const base = feedClientCount();
    const a = fakeRes();
    const removeA = addFeedClient(asRes(a), null);
    check('the dashboard stream\'s SSE headers, flushed', a.headers['Content-Type'] === 'text/event-stream' && a.headers['Cache-Control'] === 'no-cache'
      && a.headers['Connection'] === 'keep-alive' && a.headers['X-Accel-Buffering'] === 'no' && a.flushed, JSON.stringify(a.headers));
    check('hello first, exactly', a.out[0] === 'event: hello\ndata: {"now":"2026-11-27T13:31:34.000Z","replayed":1}\n\n', JSON.stringify(a.out[0]));
    check('then the replayed setup, exactly',
      a.out[1] === 'event: setup\ndata: {"id":"FFAI:1795786264:tv_setup:pop:1","ticker":"FFAI","at":"2026-11-27T13:31:04.000Z","stage":"pop","price":1.23,'
        + '"mode":"notify","why":null,"setup":{"stage":"pop","weak":false,"vol_x":34.5,"tv_rv1":48210,"tv_rv5":11975,"ran_pct":12.1,"pop_n":1,'
        + '"on_screen":false,"notified":true,"tf":"1"}}\n\n' && a.out.length === 2,
      JSON.stringify(a.out));
    check('…and it counts', feedClientCount() === base + 1);

    const late = fakeRes();
    const removeLate = addFeedClient(asRes(late), T - 10_000);
    check('a since after the buffered one: hello with replayed 0, nothing else',
      late.out.length === 1 && late.out[0] === 'event: hello\ndata: {"now":"2026-11-27T13:31:34.000Z","replayed":0}\n\n', JSON.stringify(late.out));

    now = T + 5000;
    const quiet: FeedSetup = { ...pop, id: 'FFAI:1795786269:tv_setup:back:1', at: '2026-11-27T13:31:39.000Z', stage: 'back', mode: 'quiet', why: 'weak' };
    publishFeedSetup(quiet);
    check('a live one reaches every client', a.out.at(-1) === sseText('setup', quiet) && late.out.at(-1) === sseText('setup', quiet));
    feedKeepalive();
    check('the keepalive is a comment line', a.out.at(-1) === ': keepalive\n\n' && late.out.at(-1) === ': keepalive\n\n');

    const dead = fakeRes({ throwOn: () => true });
    addFeedClient(asRes(dead), null);
    check('a client whose first write throws is not kept', feedClientCount() === base + 2, String(feedClientCount()));
    const mid = fakeRes({ throwOn: (t) => t.startsWith('event: setup') });
    addFeedClient(asRes(mid), null);
    check('…nor one whose replay write throws', feedClientCount() === base + 2 && mid.out.length === 1, `${feedClientCount()} ${mid.out.length}`);

    late.broken = true;
    publishFeedSetup({ ...quiet, id: 'X:1:tv_setup:pop:1', ticker: 'X' });
    check('a write that throws later removes that client, the others still get it',
      feedClientCount() === base + 1 && a.out.at(-1)?.includes('"ticker":"X"') === true, String(feedClientCount()));
    late.broken = false;
    feedKeepalive();
    check('…and it gets nothing more', late.out.at(-1) === ': keepalive\n\n' && !late.out.some((t) => t.includes('"ticker":"X"')));
    removeLate();

    removeA();
    removeA();
    check('the remover takes the client out (twice is harmless)', feedClientCount() === base);
    const n = a.out.length;
    publishFeedSetup({ ...quiet, id: 'Y:1:tv_setup:pop:1', ticker: 'Y' });
    check('…and it gets nothing more', a.out.length === n);

    now = T + 5000 + FEED.keep_ms + 1000;
    const gone = fakeRes();
    const removeGone = addFeedClient(asRes(gone), T - 3_600_000);
    check('10 minutes and a second after the last setup, an old since replays nothing', gone.out[0]?.endsWith('"replayed":0}\n\n') === true, JSON.stringify(gone.out));
    removeGone();
  } finally {
    Date.now = realNow;
  }
}

if (failures > 0) {
  console.error(`\n${failures} of ${checks} check(s) failed`);
  process.exit(1);
}
console.log(`\nAll ${checks} tv-feed checks passed`);
