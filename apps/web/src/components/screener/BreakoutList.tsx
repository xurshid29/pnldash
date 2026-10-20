import { useEffect, useMemo, useState } from 'react';
import { Typography } from 'antd';
import type { BoStage, CyclePayload, TvBreakout } from '../../api/types';
import { useBreakouts } from '../../hooks/useBreakouts';
import { useHiddenTickers } from '../../hooks/useHiddenTickers';
import { useSelection } from '../../context/SelectionContext';
import { TickerLink } from '../common/TickerLink';
import { TickerLinks } from '../common/TickerLinks';
import { isHot, weakWhy } from './breakoutContext';

const { Text } = Typography;

// How long each stage stays on the list. A TOUCH matters until its minute
// closes; a BREAKOUT until its trigger candle ends (the next minute, then a few
// seconds for the 30s bar's alert); a TRIGGERED while the trade is young.
// 10-19: a BREAKOUT stays 5 min (marked "no trigger" once its trigger candle
// passed), so a glance a few minutes late still finds it.
const LIVE_SEC: Record<BoStage, number> = { touch: 120, breakout: 300, triggered: 900 };
// 10-20 (operator: "its hard to find new row, when I hear the alert sound"): the
// newest signal is always on top, and lit for this long.
const FRESH_SEC = 20;
const TRIGGER_WINDOW_SEC = 80;
const STAGE: Record<BoStage, { label: string; color: string; bg: string }> = {
  touch: { label: 'TOUCH', color: '#d9d9d9', bg: '#303030' },
  breakout: { label: 'BREAKOUT', color: '#fff', bg: '#9e1068' },
  triggered: { label: 'TRIGGERED', color: '#fff', bg: '#237804' },
};
function px(p: number | null): string {
  return p == null ? '—' : `$${p < 1 ? p.toFixed(4) : p.toFixed(2)}`;
}
function signed(p: number | null, digits = 1): string {
  return p == null ? '—' : `${p >= 0 ? '+' : ''}${p.toFixed(digits)}%`;
}
// "touch 16:01:30 → BO 16:02:02 → ▲ 16:02:30" (operator's clock): the signals that
// led to a row's current stage, so a BO stays visible after it triggers (10-19).
const TRAIL_LABEL: Record<BoStage, string> = { touch: 'touch', breakout: 'BO', triggered: '▲' };
function trailOf(all: TvBreakout[], b: TvBreakout): string | null {
  const at = Date.parse(b.at);
  const steps = all
    .filter((x) => x.ticker === b.ticker && Date.parse(x.at) <= at && at - Date.parse(x.at) <= 150_000)
    .sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
  if (steps.length < 2) return null;
  return steps.map((x) => `${TRAIL_LABEL[x.stage]} ${new Date(x.at).toLocaleTimeString('en-GB', { timeZone: 'Asia/Tashkent', hour12: false })}`).join(' → ');
}
function ageText(sec: number): string {
  return sec < 90 ? `${Math.max(0, Math.round(sec))}s` : `${Math.round(sec / 60)}m`;
}

// 📐 BB breakouts (script v17, operator 2026-10-18: "store and grade only, and
// display them in our dashboard"; TOUCH so they can get ready before the
// BREAKOUT). One row per ticker, its latest signal while it is live: TOUCH →
// BREAKOUT (buy stop over the candle high, stop its low) → TRIGGERED. Never a
// sound or toast. 🔥 marks the ones the study rated (A+ or 10–50% over sVWAP
// on Momentum, and strong). Weak ones (v19) are dimmed and say why. Newest first
// (10-20; it used to sort 🔥 and strong first, so a new gray BO landed mid-list),
// and a row whose signal is under 20 s old is lit amber.
export function BreakoutList({ payload }: { payload: CyclePayload | null }) {
  const { breakouts } = useBreakouts();
  const { hidden } = useHiddenTickers();
  const { selected, setSelected } = useSelection();
  const [now, setNow] = useState(() => Date.now());
  const [show, setShow] = useState(() => {
    try { return localStorage.getItem('tvSidebar.breakouts') !== '0'; } catch { return true; }
  });
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, []);
  const rowByTicker = useMemo(() => new Map((payload?.rows ?? []).map((r) => [r.ticker, r])), [payload]);

  const visible = breakouts.filter((b) => !hidden.has(b.ticker));
  const latest = new Map<string, TvBreakout>();
  for (const b of visible) if (!latest.has(b.ticker)) latest.set(b.ticker, b);   // newest first
  const live = [...latest.values()]
    .filter((b) => (now - Date.parse(b.at)) / 1000 <= LIVE_SEC[b.stage])
    .sort((x, y) => Date.parse(y.at) - Date.parse(x.at));
  const nBreakouts = visible.filter((b) => b.stage === 'breakout').length;
  const nTriggered = visible.filter((b) => b.stage === 'triggered').length;

  const toggle = () => setShow((v) => {
    try { localStorage.setItem('tvSidebar.breakouts', v ? '0' : '1'); } catch { /* private mode */ }
    return !v;
  });

  return (
    <>
      <div
        onClick={toggle}
        style={{ padding: '4px 8px', fontSize: 10, color: '#8c8c8c', letterSpacing: 0.5, background: '#141414', cursor: 'pointer' }}
      >
        {show ? '▾' : '▸'} ⚡ BB BREAKOUTS · {live.length} live · {nBreakouts} today, {nTriggered} triggered · alarm in ⚙
      </div>
      {show && live.length === 0 && (
        <div style={{ padding: '6px 8px', fontSize: 11, color: '#595959' }}>
          Nothing at the band right now. TOUCH comes at the half-minute, BREAKOUT at the 1m close (30s alert, script v17).
        </div>
      )}
      {show && live.map((b) => {
        const weak = weakWhy(b);
        const expired = b.stage === 'breakout' && (now - Date.parse(b.at)) / 1000 > TRIGGER_WINDOW_SEC;
        const st = weak ? { ...STAGE[b.stage], bg: '#434343', color: '#bfbfbf' } : STAGE[b.stage];
        const r = rowByTicker.get(b.ticker);
        const nowPx = r?.price != null ? Number(r.price) : null;
        const since = nowPx != null && b.trigger != null && b.trigger > 0 ? (nowPx / b.trigger - 1) * 100 : null;
        const risk = b.trigger != null && b.stop != null && b.trigger > 0 ? (b.stop / b.trigger - 1) * 100 : null;
        const trail = trailOf(visible, b);
        const fresh = (now - Date.parse(b.at)) / 1000 < FRESH_SEC;
        return (
          <div
            key={b.id}
            onClick={() => setSelected(b.ticker)}
            style={{
              padding: '5px 8px', borderBottom: '1px solid #262626', cursor: 'pointer',
              borderLeft: `3px solid ${fresh ? '#faad14' : 'transparent'}`,
              background: fresh ? 'rgba(250, 173, 20, 0.12)' : b.ticker === selected ? '#111d2c' : undefined,
              opacity: fresh ? 1 : weak || expired ? 0.5 : r ? 1 : 0.7,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <TickerLinks ticker={b.ticker} />
              <TickerLink ticker={b.ticker} onSelect={setSelected} stopPropagation style={{ color: '#fff', fontWeight: 600 }} />
              {r && <span style={{ color: '#fadb14', fontSize: 11 }}>⭐</span>}
              <span style={{ fontSize: 10, fontWeight: 700, color: st.color, background: st.bg, padding: '0 5px', borderRadius: 3 }}>{st.label}</span>
              {b.early != null && <span style={{ fontSize: 10, fontWeight: 700, color: '#fa8c16', whiteSpace: 'nowrap' }}>early +{b.early}%</span>}
              {isHot(b) && <span style={{ fontSize: 10, color: '#ff7a45' }}>🔥 {b.grade === 'A+' ? 'A+' : `${signed(b.spx_pct, 0)} vs sVWAP`}</span>}
              {weak && <span style={{ fontSize: 10, color: '#8c8c8c', whiteSpace: 'nowrap' }}>weak: {weak}</span>}
              <Text type="secondary" style={{ fontSize: 10, marginLeft: 'auto', whiteSpace: 'nowrap' }}>{ageText((now - Date.parse(b.at)) / 1000)}</Text>
            </div>
            <div style={{ fontSize: 11, color: '#8c8c8c', paddingLeft: 40, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {b.stage === 'touch' && <>at the band {px(b.upper)} · {px(b.price)} ({signed(b.upper_pct)})</>}
              {b.stage === 'breakout' && (
                expired
                  ? <>✗ no trigger (buy &gt; {px(b.trigger)} never traded)</>
                  : <><span style={{ color: '#ffadd2' }}>buy &gt; {px(b.trigger)}</span> · stop {px(b.stop)}{risk != null && ` (${signed(risk)})`}</>
              )}
              {b.stage === 'triggered' && (
                <>in {px(b.trigger)} · stop {px(b.stop)}{since != null && (
                  <> · <span style={{ color: since >= 0 ? '#52c41a' : '#ff4d4f' }}>now {signed(since)}</span></>
                )}</>
              )}
              {b.run30 != null && <> · run30 +{Math.round(b.run30)}%</>}
            </div>
            {trail && <div style={{ fontSize: 10, color: '#595959', paddingLeft: 40, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{trail}</div>}
          </div>
        );
      })}
    </>
  );
}
