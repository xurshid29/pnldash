import { useState } from 'react';
import { Button, Checkbox, Divider, Input, Popover, Switch, Typography } from 'antd';
import { BRIDGE_TONE, bridgeOrigin, bridgeUsd, tokenLooksRight, type BridgeStatus } from '../../api/twsBridge';
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

// The panel behind the "TWS" button: the status, this browser's settings, the bridge's own order
// settings (read-only), the halt switch and where the token is.
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
  return (
    <div style={{ width: 330, fontSize: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
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
