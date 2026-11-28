import { useState } from 'react';
import { Button, Checkbox, Divider, Input, Popconfirm, Popover, Segmented, Switch, Typography } from 'antd';
import {
  BRIDGE_TONE, bridgeClock, bridgeOrigin, bridgeUsd, tokenLooksRight,
  type AutoAction, type AutoMode, type AutoStatus, type BridgeStatus, type BridgeTone,
} from '../../api/twsBridge';
import type { TwsBridge } from '../../hooks/useTwsBridge';

const { Text } = Typography;

// "5 min", "90 s", "5 min 30 s": a stop entry's wait.
function waitText(sec: number): string {
  if (sec < 60 || !Number.isInteger(sec)) return `${sec} s`;
  const min = Math.floor(sec / 60);
  return sec % 60 === 0 ? `${min} min` : `${min} min ${sec % 60} s`;
}

// "triggers 5% above the alert's price, limit 1% above that, cancelled after 5 min if not reached ·
// take-profit and stop from the trigger" — the stop entry, in the words of the card's button.
function stopEntryText(pct: number, limitPct: number | undefined, validSec: number | undefined): string {
  const parts = [`triggers ${pct}% above the alert's price`];
  if (limitPct != null) parts.push(`limit ${limitPct}% above that`);
  if (validSec != null) parts.push(`cancelled after ${waitText(validSec)} if not reached`);
  return `${parts.join(', ')} · take-profit and stop from the trigger`;
}

// The bridge's own order settings, as /status returns them. Read-only here: they are changed in
// tools/tws-bridge/config.json, then the bridge is restarted.
function orderRows(s: BridgeStatus): Array<[string, string]> {
  const o = s.order;
  const l = s.limits;
  const stop = o.stopPct > 0
    ? `limit − ${o.stopPct}%${o.useAlertStop ? ", or the alert's stop when it has one" : ''} (its own limit ${o.stopLimitOffsetPct}% lower)`
    : 'none';
  // Sized in dollars (order.amountUsd above 0) or in shares.
  const usd = o.amountUsd != null && o.amountUsd > 0 ? o.amountUsd : null;
  const size: [string, string] = usd != null
    ? ['Amount', `${bridgeUsd(usd)} per trade (whole shares at the buy's limit, rounded down)`]
    : ['Shares', `${o.qty}`];
  // Where the buy's limit starts from, and what happens when TWS has no live ask.
  const from = o.priceFrom === 'ask'
    ? `the live ask + ${o.limitOffsetPct}% (${o.askFallback === 'alert' ? `the alert's price + ${o.limitOffsetPct}% when TWS gives no ask` : 'no order when TWS gives no ask'})`
    : `the alert's price + ${o.limitOffsetPct}%`;
  // The chase and sell settings came with a later bridge: an older one sends neither.
  const chase: Array<[string, string]> = o.maxChases == null ? []
    : [['Chase', o.maxChases > 0 ? `up to ${o.maxChases} move${o.maxChases === 1 ? '' : 's'}, never more than ${o.maxChasePct}% past the alert` : 'off']];
  const sell: Array<[string, string]> = o.sellOffsetPct == null ? [] : [['Sell', `the live bid − ${o.sellOffsetPct}%`]];
  // The stop entry (the card's "Buy if ≥" button) came with a later bridge still: an older one
  // sends none of its settings, and the row is left out.
  const stopEntry: Array<[string, string]> = o.entryStopPct == null ? []
    : [['Buy if above', o.entryStopPct > 0 ? stopEntryText(o.entryStopPct, o.entryStopLimitPct, o.entryValidSec) : 'off']];
  return [
    size,
    ['Limit', `${from} · no order over ${o.maxChasePct}% past the alert`],
    ['Take-profit', o.takeProfitPct > 0 ? `limit + ${o.takeProfitPct}%` : 'none'],
    ['Stop', stop],
    ...stopEntry,
    ...chase,
    ...sell,
    ['Max per order', `$${l.maxNotionalUsd.toLocaleString('en-US')} · ${l.maxShares} shares`],
    ['Orders today', `${s.today.orders} of ${l.maxOrdersPerDay} · ${s.today.filled} filled`],
    ['Hours', o.outsideRth ? 'pre-market and after hours too' : 'regular hours only'],
    ['TWS', `port ${s.tws.port} · ${s.tws.accounts.length > 0 ? `account ${s.tws.accounts.join(', ')}` : 'no account reported'} · bridge ${s.version}`],
  ];
}

// ---------------------------------------------------------------- the automation (2026-11-28)
// The bridge buys every yellow (not weak) POP of its hour by itself, with a waiting buy, and
// sells by itself. The panel switches it (Off / Watch only / On), says what it would do now, its
// rule, today's counts, whether it hears the server's alerts, and what it decided today.

const MODE_WORD: Record<AutoMode, string> = { off: 'Off', watch: 'Watch only', on: 'On' };
const MODE_OPTIONS = (['off', 'watch', 'on'] as const).map((m) => ({ value: m, label: MODE_WORD[m] }));
const ACTION_WORD: Record<AutoAction, string> = { placed: 'placed', would_place: 'would place', skipped: 'skipped', failed: 'failed' };
// placed green, would place blue, skipped the default gray, failed red
const ACTION_COLOR: Record<AutoAction, string> = { placed: '#95de64', would_place: '#69b1ff', skipped: '#8c8c8c', failed: '#ff4d4f' };
// Reasons for placing nothing that are part of a normal day, not something to fix.
const CALM_BLOCKS = new Set<string>(['outside_hours', 'day_full', 'no_slot']);

// "$400", "$2,000"
function usd(n: number): string {
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

// Its hour on the operator's clock, from today's instants ("14:00", "15:00"); New York's own
// times, so marked, if an instant cannot be read.
function autoHours(a: AutoStatus): { start: string; end: string } {
  return {
    start: bridgeClock(a.window.start_at, false) ?? `${a.window.start} New York`,
    end: bridgeClock(a.window.end_at, false) ?? `${a.window.end} New York`,
  };
}

// The confirm before On, from the rule: what it will do, with what, and that it goes on with
// this page closed.
function autoConfirmText(a: AutoStatus, s: BridgeStatus): string {
  const r = a.rule;
  const h = autoHours(a);
  const account = r.paper_only || s.paper_only || s.tws.paper ? 'the paper account' : 'your LIVE account';
  const floor = minPriceText(r.min_price);
  return `The helper will place orders by itself on ${account}: every ${r.strong_only ? 'yellow ' : ''}POP between ${h.start} and ${h.end}`
    + `${floor != null ? ` priced ${floor} or more` : ''}, `
    + `a waiting buy ${r.entry_stop_pct}% above the alert's price (cancelled after ${waitText(r.entry_valid_sec)} if the price does not get there), `
    + `${usd(r.amount_usd)} each, at most ${r.slots} at a time and ${r.max_trades} trades a day; `
    + `${exitsText(r)}. It runs while the helper runs, also with this page closed.`;
}

// What it would do right now, in one line: the bridge's own reason when it would place nothing.
function autoNowLine(a: AutoStatus, s: BridgeStatus, busy: AutoMode | null): { text: string; tone: BridgeTone } {
  if (busy != null) return { text: `Switching to ${MODE_WORD[busy]}…`, tone: 'muted' };
  if (a.mode === 'off') return { text: a.blocked_text ?? 'Off: the helper places nothing by itself', tone: 'muted' };
  // Why it would place nothing now, beyond the mode itself.
  const why = a.blocked != null && a.blocked !== 'off' && a.blocked !== 'watch' ? a.blocked_text ?? a.blocked : null;
  if (a.mode === 'watch') {
    return { text: `Watch only: it logs what it would do and places nothing${why != null ? ` · ${why}` : ''}`, tone: 'muted' };
  }
  if (why == null) return { text: `On: buying the next ${a.rule.strong_only ? 'yellow ' : ''}POP`, tone: s.tws.paper ? 'ok' : 'danger' };
  return { text: why, tone: CALM_BLOCKS.has(a.blocked ?? '') ? 'muted' : 'warn' };
}

// The price floor as text ("$0.50"), or null when there is none (0, or a bridge from before it).
function minPriceText(min: number | undefined): string | null {
  return typeof min === 'number' && min > 0 ? `$${min.toFixed(2)}` : null;
}

// The exits in words, from the rule: "take-profit +20% on half, the rest trails 20% under the
// high · stop −10%, to the entry at +10%". A bridge from before the rule: "take-profit +20% · stop −10%".
function exitsText(r: AutoStatus['rule']): string {
  const part = typeof r.take_profit_portion === 'number' && r.take_profit_portion < 1 ? r.take_profit_portion : null;
  const share = part == null ? '' : part === 0.5 ? ' on half' : ` on ${Math.round(part * 100)}%`;
  const trail = part != null && typeof r.trail_pct === 'number' && r.trail_pct > 0 ? `, the rest trails ${r.trail_pct}% under the high` : '';
  const even = typeof r.stop_to_entry_at_pct === 'number' && r.stop_to_entry_at_pct > 0 ? `, to the entry at +${r.stop_to_entry_at_pct}%` : '';
  return `take-profit +${r.take_profit_pct}%${share}${trail} · stop −${r.stop_pct}%${even}`;
}

// "$400 × 5 = $2,000 · buy if ≥ +5% (5 min) · take-profit +20% · stop −10% · 14:00–15:00 · $0.50 and over"
function autoRuleLine(a: AutoStatus): string {
  const r = a.rule;
  const h = autoHours(a);
  const floor = minPriceText(r.min_price);
  return `${usd(r.amount_usd)} × ${r.slots} = ${usd(r.budget_usd)} · buy if ≥ +${r.entry_stop_pct}% (${waitText(r.entry_valid_sec)}) · `
    + `${exitsText(r)} · ${h.start}–${h.end}${floor != null ? ` · ${floor} and over` : ''}`;
}

// "Today: 2 of 5 trades · 1 waiting · 1 held · 12 yellow and 30 gray POPs seen"
function autoTodayLine(a: AutoStatus): string {
  const t = a.today;
  const n = t.strong_pops + t.weak_pops;
  const pops = `${t.strong_pops} yellow${t.weak_pops > 0 ? ` and ${t.weak_pops} gray` : ''} POP${n === 1 ? '' : 's'} seen`;
  return `Today: ${t.trades} of ${a.rule.max_trades} trades · ${t.waiting} waiting · ${t.held} held · ${pops}`;
}

// Whether the helper hears the server's alerts.
function autoFeedLine(a: AutoStatus): { text: string; tone: BridgeTone } {
  const f = a.feed;
  if (!f.paired) {
    return a.mode === 'off'
      ? { text: 'Alerts: not connected to the server (it connects when you pick Watch only or On)', tone: 'muted' }
      : { text: 'Alerts: not connected to the server yet', tone: 'warn' };
  }
  switch (f.state) {
    case 'connected': {
      const last = bridgeClock(f.last_event_at) ?? bridgeClock(f.connected_at);
      return { text: `Alerts: connected${last != null ? ` · last heard ${last}` : ''}`, tone: 'ok' };
    }
    case 'connecting':
      return { text: 'Alerts: connecting…', tone: 'muted' };
    case 'retrying':
      return { text: `Alerts: not connected: ${f.error ?? 'no answer from the server'} · trying again`, tone: 'warn' };
    case 'unauthorized':
      return { text: `Alerts: not connected: ${f.error ?? 'the server refused the helper'}${a.mode !== 'off' ? ' · asking the server again' : ''}`, tone: 'warn' };
    case 'off':
      return { text: a.mode === 'off' ? 'Alerts: not listening while it is off' : 'Alerts: not connected', tone: a.mode === 'off' ? 'muted' : 'warn' };
    default:
      return { text: `Alerts: ${String(f.state)}`, tone: 'muted' };
  }
}

function AutomationBlock({ bridge, status }: { bridge: TwsBridge; status: BridgeStatus }) {
  const { auto, autoMissing, autoFailure, autoBusy, autoError, linkError } = bridge;
  // The confirm before On: opened by picking On, closed by its buttons or a click elsewhere.
  const [confirmOn, setConfirmOn] = useState(false);
  const head = <span style={{ fontWeight: 600 }}>Automation</span>;
  const line = (text: string, tone: BridgeTone) => <div style={{ fontSize: 11, color: BRIDGE_TONE[tone] }}>{text}</div>;

  // An older bridge: one line, nothing else.
  if (autoMissing) return <div>{head}{line('This helper version has no automation: restart it from the updated folder', 'warn')}</div>;
  if (auto == null) {
    return <div>{head}{autoFailure != null ? line(`No answer from the helper about it: ${autoFailure}`, 'warn') : line('checking…', 'muted')}</div>;
  }

  const choose = (m: AutoMode) => {
    if (m === auto.mode) return;
    if (m === 'on') { setConfirmOn(true); return; }
    setConfirmOn(false);
    bridge.setAutoMode(m);
  };
  const now = autoNowLine(auto, status, autoBusy);
  const feed = autoFeedLine(auto);
  const live = !(auto.rule.paper_only || status.paper_only || status.tws.paper);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {head}
        <Popconfirm
          open={confirmOn}
          onOpenChange={(o) => { if (!o) setConfirmOn(false); }}
          placement="bottomRight"
          title="Turn the automation on?"
          description={<div style={{ maxWidth: 290, fontSize: 12 }}>{autoConfirmText(auto, status)}</div>}
          okText="Turn on"
          okButtonProps={{ danger: live }}
          cancelText="Cancel"
          onConfirm={() => { setConfirmOn(false); bridge.setAutoMode('on'); }}
          onCancel={() => setConfirmOn(false)}
        >
          <span style={{ display: 'inline-block', marginLeft: 'auto' }}>
            <Segmented<AutoMode> size="small" options={MODE_OPTIONS} value={auto.mode} disabled={autoBusy != null} onChange={choose} />
          </span>
        </Popconfirm>
      </div>
      <div style={{ fontSize: 12, fontWeight: 600, color: BRIDGE_TONE[now.tone] }}>{now.text}</div>
      <div style={{ fontSize: 11 }}>{autoRuleLine(auto)}</div>
      <div style={{ fontSize: 11 }}>{autoTodayLine(auto)}</div>
      {line(feed.text, feed.tone)}
      {linkError != null && auto.feed.state !== 'connected' && line(linkError, 'warn')}
      {autoError != null && line(`The switch did not take: ${autoError}`, 'danger')}
      {autoFailure != null && line(`No fresh answer from the helper: ${autoFailure}`, 'warn')}
      {/* Today's decisions, newest first: about 8 rows, then it scrolls. */}
      <div style={{ maxHeight: 150, overflowY: 'auto', border: '1px solid #303030', borderRadius: 4, padding: '3px 6px', marginTop: 2 }}>
        {auto.decisions.length === 0
          ? <div style={{ fontSize: 11, color: '#8c8c8c' }}>Nothing decided yet today</div>
          : auto.decisions.map((d, i) => (
            <div key={`${d.at}|${d.alert_id}|${i}`} style={{ fontSize: 11, lineHeight: '16px', padding: '1px 0' }}>
              <span style={{ color: '#8c8c8c' }}>{bridgeClock(d.at) ?? '—'}</span>{' '}
              <span style={{ fontWeight: 600 }}>{d.ticker}</span>{' '}
              <span style={{ color: ACTION_COLOR[d.action], fontWeight: 600 }}>{ACTION_WORD[d.action]}</span>{' '}
              <span style={{ color: '#bfbfbf' }}>{d.text}</span>
            </div>
          ))}
      </div>
    </div>
  );
}

// The panel behind the "TWS" button: the status, this browser's settings, the bridge's own order
// settings (read-only), the halt switch, the automation (2026-11-28) and where the token is.
export function TwsBridgePanel({ bridge }: { bridge: TwsBridge }) {
  const { settings, status, view } = bridge;
  // Drafts: the address and the token are saved when the field is left (or Enter), so a half-typed
  // one is never called. A pasted token of the right form is saved at once.
  const [url, setUrl] = useState(settings.url);
  const [token, setToken] = useState(settings.token);
  const [haltBusy, setHaltBusy] = useState(false);
  const [haltError, setHaltError] = useState<string | null>(null);

  const saveUrl = () => bridge.update({ url });
  const saveToken = (v: string) => bridge.update({ token: v });
  const onToken = (v: string) => {
    setToken(v);
    const t = v.trim();
    if (t === '' || tokenLooksRight(t)) saveToken(t);
  };
  const flipHalt = async () => {
    if (status == null || haltBusy) return;
    setHaltBusy(true);
    setHaltError(await bridge.halt(!status.halted));
    setHaltBusy(false);
  };

  const tokenText = token.trim();
  const label = { fontSize: 11, color: '#8c8c8c', display: 'block', marginBottom: 2 } as const;
  // With the automation's block the panel can be taller than the screen: it scrolls then.
  return (
    <div style={{ width: 330, fontSize: 12, display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 'calc(100vh - 120px)', overflowY: 'auto' }}>
      <div style={{ color: settings.enabled ? BRIDGE_TONE[view.tone] : '#8c8c8c', fontWeight: 600 }}>
        {settings.enabled ? view.text : 'Off in this browser.'}
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
        <Switch size="small" checked={settings.enabled} onChange={(v) => bridge.update({ enabled: v })} />
        <span>Use the TWS bridge in this browser</span>
      </label>
      <div>
        <span style={label}>Token</span>
        <Input.Password
          size="small" value={token} autoComplete="off" spellCheck={false} placeholder="64 characters, from config.json"
          onChange={(e) => onToken(e.target.value)} onBlur={() => saveToken(tokenText)} onPressEnter={() => saveToken(tokenText)}
        />
        {tokenText !== '' && !tokenLooksRight(tokenText) && (
          <span style={{ fontSize: 11, color: BRIDGE_TONE.warn }}>
            The bridge's token is 64 characters (0-9, a-f); this one has {tokenText.length}.
          </span>
        )}
      </div>
      <div>
        <span style={label}>Bridge address</span>
        <Input
          size="small" value={url} autoComplete="off" spellCheck={false}
          onChange={(e) => setUrl(e.target.value)} onBlur={saveUrl} onPressEnter={saveUrl}
        />
        {bridgeOrigin(url) == null && (
          <span style={{ fontSize: 11, color: BRIDGE_TONE.warn }}>
            It must be http://127.0.0.1:&lt;port&gt;: the bridge runs on this computer, and the token is sent nowhere else.
          </span>
        )}
      </div>
      <Checkbox checked={settings.buy} onChange={(e) => bridge.update({ buy: e.target.checked })}>
        <span style={{ fontSize: 12 }}>Show the Buy buttons on alerts up to 10 minutes old</span>
      </Checkbox>
      {settings.enabled && status != null && (
        <>
          <Divider style={{ margin: '2px 0' }} />
          <div>
            <span style={{ fontWeight: 600 }}>The bridge's order settings</span>
            <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>
              read from the bridge · change them in its config.json, then restart it
            </Text>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 10px', fontSize: 11 }}>
            {orderRows(status).map(([name, value]) => (
              <div key={name} style={{ display: 'contents' }}>
                <span style={{ color: '#8c8c8c', whiteSpace: 'nowrap' }}>{name}</span>
                <span>{value}</span>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Button size="small" danger={!status.halted} loading={haltBusy} onClick={() => { void flipHalt(); }}>
              {status.halted ? 'Resume orders' : 'Halt orders'}
            </Button>
            <Text type="secondary" style={{ fontSize: 11 }}>
              {status.halted
                ? 'Halted: no new order and no Chase until you resume. Sell and Cancel still work; orders already in TWS stay there.'
                : 'Halt = no new order and no Chase until you resume. Sell and Cancel still work.'}
            </Text>
          </div>
          {haltError && <span style={{ fontSize: 11, color: BRIDGE_TONE.danger }}>{haltError}</span>}
          <Divider style={{ margin: '2px 0' }} />
          <AutomationBlock bridge={bridge} status={status} />
        </>
      )}
      <Divider style={{ margin: '2px 0' }} />
      <div style={{ fontSize: 11, color: '#8c8c8c', lineHeight: 1.5 }}>
        <div>The token is in <code>tools/tws-bridge/config.json</code> on this computer; the file appears after the first <code>npm start</code> in that folder.</div>
        <div>The browser asks once for permission to reach a program on this computer (Chrome's local network access prompt): allow it. Safari may block the call.</div>
      </div>
    </div>
  );
}

// The sidebar header's "TWS" button: one small button for everybody, and all there is of the
// feature until it is switched on in this browser. It opens the bridge's panel (a click, no hover).
export function TwsBridgeButton({ bridge }: { bridge: TwsBridge }) {
  return (
    <Popover trigger="click" placement="bottomLeft" title="TWS bridge" content={<TwsBridgePanel bridge={bridge} />}>
      <Button size="small" type="text" style={{ marginLeft: 'auto', padding: '0 6px', fontSize: 11, color: '#8c8c8c' }}>TWS</Button>
    </Popover>
  );
}

// The status line under the header, only while the feature is on: "TWS: paper · ready",
// "TWS bridge not running (or the browser blocked the call)", "TWS: LIVE account · ready" in red.
export function TwsBridgeLine({ bridge }: { bridge: TwsBridge }) {
  const { settings, view } = bridge;
  if (!settings.enabled) return null;
  return (
    <div style={{ padding: '2px 8px', borderBottom: '1px solid #262626', fontSize: 11, color: BRIDGE_TONE[view.tone], fontWeight: view.live ? 700 : 400 }}>
      {view.text}
      {view.canOrder && !settings.buy && <span style={{ color: '#8c8c8c', fontWeight: 400 }}> · Buy buttons off</span>}
    </div>
  );
}
