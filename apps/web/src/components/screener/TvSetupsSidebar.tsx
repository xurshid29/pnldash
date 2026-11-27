import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { App, Button, Checkbox, Dropdown, Modal, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { CaretDownOutlined, CaretRightOutlined, EllipsisOutlined } from '@ant-design/icons';
import { stageSwitch, type CyclePayload, type OpportunityAlert, type TvSetupInfo, type TvStage } from '../../api/types';
import { tvApi, type TvWatchlist } from '../../api/tv';
import { useAlertLog } from '../../hooks/useAlertLog';
import { useTvAlertStages } from '../../hooks/useTvAlertStages';
import { useHiddenTickers } from '../../hooks/useHiddenTickers';
import { setTvMomoOnly, useTvMomoOnly } from '../../hooks/useTvMomoOnly';
import { useSelection } from '../../context/SelectionContext';
import { TickerLink } from '../common/TickerLink';
import { TickerLinks } from '../common/TickerLinks';
import { TvStageTag, tvLevelsText, fmtTf, isVbStage, lineTokens, lineDistanceText, crossTfText, retestStopText, popRanText, isWeakSetup, emaEventKey, popEventKey, tagNumber, isBandCross, isLineCross, isPopBack, isFreePop, POP_FREE_VOL } from '../common/TvStageTag';
import { GradeCell } from '../common/GradeCell';
import { TwsBridgeButton, TwsBridgeLine } from './TwsBridgeControl';
import { bridgeCard, useTwsBridge, type BridgeOrderBlock } from '../../hooks/useTwsBridge';
import { BRIDGE_ALERT_MAX_AGE_MS, bridgeOrderRequest, type BridgeEntry } from '../../api/twsBridge';
import { fmtPct, fmtPrice } from '../../utils/format';
import pineScript from '../../tv/mvwap-bb-setup.pine?raw';
import rvolScript from '../../tv/rvol.pine?raw';

const { Text } = Typography;
const LOCAL_TZ = 'Asia/Tashkent'; // UTC+5, the operator's clock

// What counts as live (operator, 2026-10-05): a fresh CROSS (v21) or RETEST (v28),
// or a pullback still waiting at its line; a v35 EMA cross like a CROSS and its
// v37 BOUNCE like a RETEST. Everything else is "earlier". A v48 POP stays live for the 20
// minutes its BACK can come in (the script's default wait: 20 candles of 1m) unless a BACK or a
// newer POP takes its place first; a BACK like a RETEST.
const LIVE_MIN = { pullback: 60, cross: 15, retest: 15, ema: 15, bounce: 15, band: 15, turn: 15, pop: 20, back: 15 } as const;   // a BAND cross like the EMA's; a v47 TURN like a BOUNCE
// The 1m and 2m alerts report the same stage separately; within this window
// they are one event.
const MERGE_MS = 5 * 60_000;
// TWS bridge (2026-11-26): a button that moves money — Buy, Chase, Sell — that has just appeared
// or moved (a new alert pushed the list down, a row above opened, a buy filled and Sell stands
// where Cancel stood) takes no click for this long, so a click aimed at one thing cannot land on
// the button that slid under the cursor. Since 11-27 a move sideways counts too, and an alert's
// two buy buttons (Buy and the stop entry beside it) are held together: when Buy's label changes
// ("sending…" and back) the other slides along, and a click aimed at one could land on the other.
const BUY_HOLD_MS = 600;
// An order's line: still working (or selling), holding shares, over.
const ORDER_TONE = { working: '#d9d9d9', filled: '#95de64', done: '#8c8c8c' } as const;
// The bridge's buttons, smaller than antd's small (24 px) so the card stays compact.
const BUY_BTN = { height: 20, padding: '0 8px', fontSize: 11, lineHeight: '18px', fontWeight: 600 } as const;
const ORDER_BTN = { height: 18, padding: '0 6px', fontSize: 10, lineHeight: '16px', borderRadius: 3, marginLeft: 6 } as const;
const SELL_BTN = { ...ORDER_BTN, fontWeight: 600 } as const;
// `loose_exit` on an order: the one way this setup could go short, so it is said in so many words.
const LOOSE_EXIT = 'an exit order is still working in TWS on a closed position: the bridge is cancelling it; check TWS';

interface SetupEvent {
  id: string;
  ids: string[];       // the alert ids of every merged copy (the 1m and 30s alerts' rows), `id` first
  at: number;          // ms
  price: number | null;
  setup: TvSetupInfo;
  tfs: string[];       // the alert timeframes that reported it
  notified: boolean;
}
interface TickerCard {
  ticker: string;
  events: SetupEvent[];   // oldest first, 1m/2m copies merged — every stage (the day trail)
  current: SetupEvent;    // the live event, or the latest one of a shown stage
  live: boolean;
  resolved: boolean;      // CROSS / RETEST / HELD / BROKEN, or a PULLBACK a later BROKEN / HELD closed
  // How a PULLBACK shown as current ended — labelled on the row, since BROKEN /
  // HELD are usually switched off and hidden (2026-10-13, WFF 00:34 → broke 00:35).
  outcome: { stage: 'broken' | 'held'; at: number } | null;
}

// One setup thread per line combination: pullback (session / month / year and
// combinations). A pullback's BROKEN / HELD also closes an open pullback on any
// combination sharing one of its lines. The v21 VWAP + BB cross and its v28
// RETEST are their own thread, one per line combination (v22). The v48 POP and
// its BACK are one thread too: the BACK takes the POP's place as the thread's
// latest event, like a RETEST its CROSS. A BACK whose POP was never stored
// (the script's filters let only the BACK through) starts the thread itself.
// A weak POP or BACK (v49) is in the thread like a weak EMA cross: in the day
// trail, never the ticker's row (`listed` in buildCards).
function threadOf(s: TvSetupInfo): string {
  if (isPopBack(s.stage)) return `pp:${s.candle_tf ?? ''}`;   // v48: one thread per basis timeframe (no VWAP line), apart from TURN's
  if (s.stage === 'turn') return `tn:${s.candle_tf ?? ''}`;   // v47: a setup of its own, one thread per basis timeframe (it has no VWAP line)
  if (isBandCross(s)) return `bd:${lineTokens(s.stage, s.line).join('+')}`;   // v40: the band's crosses, beside the EMA's
  if (s.stage === 'ema' || s.stage === 'bounce') return `em:${lineTokens(s.stage, s.line).join('+')}`;   // v35: its own thread per line, with its v37 BOUNCE
  if (isVbStage(s.stage)) return `vb:${lineTokens(s.stage, s.line).join('+')}`;
  return `pb:${lineTokens(s.stage, s.line).join('+') || 'none'}`;
}

// `shown`: the ⚙ menu's 📐 stage switches (2026-10-06). A switched-off stage
// never becomes a card's current state, so a ticker with only such events has
// no card; BROKEN / HELD still close a pullback even while hidden.
function buildCards(alerts: OpportunityAlert[], now: number, shown: (stage: TvStage) => boolean): TickerCard[] {
  const byTicker = new Map<string, SetupEvent[]>();
  const sorted = alerts
    .filter((a) => a.kinds.includes('tv_setup') && a.setup)
    .map((a) => ({ a, at: Date.parse(a.at) }))
    .sort((x, y) => x.at - y.at);
  for (const { a, at } of sorted) {
    const s = a.setup!;
    const list = byTicker.get(a.ticker) ?? [];
    // A VB CROSS / RETEST comes from one alert: only a copy of the same one merges, not the next.
    const dup = list.find((e) => e.setup.stage === s.stage && threadOf(e.setup) === threadOf(s) && at - e.at <= MERGE_MS
      && (s.stage !== 'cross' || e.setup.cross_n === s.cross_n) && (s.stage !== 'retest' || e.setup.retest_n === s.retest_n)
      && ((!isLineCross(s.stage) && s.stage !== 'bounce') || emaEventKey(e.setup) === emaEventKey(s))
      && (s.stage !== 'turn' || e.setup.turn_n === s.turn_n)
      // v49: a weak POP / BACK takes no day's number, so the number alone doesn't tell it from the next
      && (!isPopBack(s.stage) || popEventKey(e.setup) === popEventKey(s)));
    if (dup) {
      if (s.tf && !dup.tfs.includes(s.tf)) dup.tfs.push(s.tf);
      if (!dup.ids.includes(a.id)) dup.ids.push(a.id);
      dup.notified ||= s.notified;
    } else {
      list.push({ id: a.id, ids: [a.id], at, price: a.price, setup: s, tfs: s.tf ? [s.tf] : [], notified: s.notified });
    }
    byTicker.set(a.ticker, list);
  }
  const cards: TickerCard[] = [];
  for (const [ticker, events] of byTicker) {
    const latest = new Map<string, SetupEvent>();
    for (const e of events) {
      const th = threadOf(e.setup);
      latest.set(th, e);
      if (e.setup.stage === 'broken' || e.setup.stage === 'held') {
        const lines = lineTokens(e.setup.stage, e.setup.line);
        for (const [k, open] of latest) {
          if (k !== th && open.setup.stage === 'pullback' && open.at < e.at
            && lineTokens(open.setup.stage, open.setup.line).some((t) => lines.includes(t))) latest.set(k, e);
        }
      }
    }
    // v36: an EMA cross the script's filter calls weak is never a ticker's row — it stays in the
    // day trail (the expanded row) and in the history table. v49: a POP under the script's volume
    // minimum and its BACK the same: neither starts a card nor takes a row's place. (A weak POP
    // is a new run, so the run of an older POP in the thread has ended and it can have no BACK:
    // that POP keeps the row but is no longer live.)
    const listed = (e: SetupEvent) => shown(e.setup.stage) && !isWeakSetup(e.setup);
    let live: SetupEvent | null = null;
    for (const e of latest.values()) {
      const limit = (LIVE_MIN as Record<string, number | undefined>)[e.setup.stage];
      if (listed(e) && limit != null && now - e.at <= limit * 60_000 && (!live || e.at > live.at)) live = e;
    }
    const current = live ?? [...events].reverse().find(listed);
    if (!current) continue;
    const st = current.setup.stage;
    const closer = latest.get(threadOf(current.setup));
    const closed = st === 'pullback' && closer != null && closer !== current
      && (closer.setup.stage === 'broken' || closer.setup.stage === 'held');
    const resolved = st === 'cross' || st === 'retest' || st === 'ema' || st === 'bounce' || st === 'band' || st === 'turn' || st === 'pop' || st === 'back' || st === 'held' || st === 'broken' || closed;
    const outcome = closed ? { stage: closer!.setup.stage as 'broken' | 'held', at: closer!.at } : null;
    cards.push({ ticker, events, current, live: live != null, resolved, outcome });
  }
  return cards;
}

// 2026-11-27: a row that pinged on any name — an announced POP or BACK that passes the volume
// rule (isFreePop: not weak, a reading of POP_FREE_VOL or more). The server announces it whether
// or not the ticker is on the Momentum list, so off the list its card is not dimmed, reads "off
// Momentum" where the ⭐ would be, and stays under "Show only Momentum tickers".
function pingedOnAnyName(e: SetupEvent): boolean {
  return e.notified && isFreePop(e.setup);
}

// "Show only Momentum tickers ⭐": the cards that stay — a ticker on the Momentum screen right
// now, and (2026-11-27) a card whose row is a POP or a BACK that pinged on any name. Every other
// card off the screen is hidden, and counted in "N off Momentum not shown".
function momoOnlyCards(cards: TickerCard[], onMomentum: (ticker: string) => boolean): TickerCard[] {
  return cards.filter((c) => onMomentum(c.ticker) || pingedOnAnyName(c.current));
}

// "+1.2% vs sVWAP" — where price sat against the setup's own line at the signal.
function lineDistance(s: TvSetupInfo): string {
  const first = lineTokens(s.stage, s.line)[0] ?? 'session';
  return lineDistanceText(s, first) ?? '';
}

// A pullback to a line that already held today, or its 3rd+ touch (a 3rd
// touch only comes after one held: the cap counts failures). First live
// grading, 2026-10-18: these held 33–36% vs 24% for the rest. Announced
// pullbacks only — the quiet ones past the cap held 6%.
function provenLine(c: TickerCard, e: SetupEvent): string | null {
  if (e.setup.stage !== 'pullback' || !e.notified) return null;
  const lines = lineTokens('pullback', e.setup.line);
  const heldBefore = c.events.some((x) => x.setup.stage === 'held' && x.at < e.at
    && lineTokens('held', x.setup.line).some((t) => lines.includes(t)));
  if (heldBefore) return '↺ held before';
  return (e.setup.touch ?? 0) >= 3 ? '↺ touch 3+' : null;
}

// TWS bridge: a setup that is over gets no Buy button — a card whose row is a BROKEN or a HELD
// event, or a PULLBACK already marked "✗ broke" (its BROKEN is usually switched off, so the row
// stays the PULLBACK). A PULLBACK marked "✓ held" keeps it, and so does a POP: the operator acts
// on POPs.
function setupOver(c: TickerCard): boolean {
  const st = c.current.setup.stage;
  return st === 'broken' || st === 'held' || c.outcome?.stage === 'broken';
}

// The moment of a click on Buy, on both clocks: the page's own (what the Buy button's hold is
// measured on) and the wall clock (the alert's age). Read in the click's handler, never while
// rendering.
function clickTime(): { sinceLoad: number; at: number } {
  return { sinceLoad: performance.now(), at: Date.now() };
}

function age(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
}

// "30S" < "1" < "2": seconds before minutes, then by length.
function tfSeconds(tf: string): number {
  return /^\d+S$/i.test(tf) ? Number.parseInt(tf, 10) : /^\d+$/.test(tf) ? Number(tf) * 60 : Number.MAX_SAFE_INTEGER;
}
function byTf(a: string, b: string): number {
  return tfSeconds(a) - tfSeconds(b);
}

function hhmm(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-GB', { timeZone: LOCAL_TZ, hour: '2-digit', minute: '2-digit', hour12: false });
}

const HOW_TO = (
  <div style={{ fontSize: 13, lineHeight: 1.6 }}>
    <div><b>1.</b> <b>Copy Pine script</b> → TradingView Pine Editor → paste → Add to chart. Its yellow line is the month VWAP, the purple one the session VWAP. With “VWAP lines from: chart bars” they sit exactly on TradingView's own “VWAP Month” and “VWAP Session”; with the default, 30s bars, they can differ a little on a 5m chart (see <b>VWAP lines</b> below). Its blue line is this year's VWAP built from hourly bars (v14). On liquid names it can differ from TradingView's own “VWAP Year” on an intraday chart, which only reaches back as far as the chart has loaded. Trust the blue one.</div>
    <div><b>2.</b> <b>Download .txt</b> → watchlist menu → Import list (or paste <b>Copy list</b>). Refresh it each morning. During the day the sidebar flags new names missing from it — <b>Copy</b> and add them to the watchlist (the alerts pick up added symbols by themselves).</div>
    <div><b>3.</b> Create <b>two</b> alerts → Symbols: that watchlist → Condition: <i>mVWAP-BB</i> → “Any alert() function call” · session Extended · once per bar close — one on <b>1 minute</b>, one on <b>30 seconds</b>.</div>
    <div><b>↻</b> After a script update: paste the new version, Save, then delete and recreate both alerts. For <b>v28</b>: after pasting it, open the indicator's Settings → Defaults → <b>Reset settings</b> once more. The defaults are your settings (gainer filter 10%, VB candle 5m, band 45s, tolerance 0), and the reset also restores the chart markers (BROKEN / HELD hidden, RETEST shown). Then recreate both alerts, and tick <b>RETEST</b> in ⚙ → 📐 Stages that alert if it isn't. For <b>v35</b> nothing shifts (the “EMA cross over VWAP” settings come last): paste, Save, recreate both alerts, and tick <b>EMA</b> in ⚙ → 📐 Stages that alert. For <b>v36</b> nothing shifts (the four “EMA filter” settings come last): paste, Save, recreate both alerts. For <b>v37</b> the same (the five “EMA bounce” settings come last); BOUNCE alerts follow the <b>EMA + BOUNCE</b> switch in ⚙. For <b>v39</b> a reset is needed: the VB lanes were removed with their settings, so the saved ones moved. After pasting, open Settings → Defaults → <b>Reset settings</b>, then check your own values. Recreate both alerts. For <b>v40</b> nothing shifts (its one setting, “EMA cross: the line that crosses the VWAP”, comes last and starts on <b>Both</b>): paste, Save, recreate both alerts. For <b>v41</b> the same (one setting, last: the band cross's middle-line test, on). For <b>v44</b> a reset is needed again: the RSI cross (with its DIP and MACD) and the BASIS cross were removed with their settings, so the saved ones moved. After pasting, open Settings → Defaults → <b>Reset settings</b>, check your own values, then recreate both alerts. The defaults are now what your alerts were running: VB candle 2m, band 30s, EMA candle 2m, and the BB upper band as the line that crosses. For <b>v45</b> nothing shifts (three settings, last, shown at the end of the Pullback group): paste and Save. It only draws a line, so the alerts can stay as they are. For <b>v46</b> the same (three settings, last, shown at the end of the “EMA cross over VWAP” group). For <b>v47</b> nothing shifts (TURN's thirteen settings come last, in their own group): paste, Save, and recreate both alerts — this one sends alerts. <b>TURN</b> is on in ⚙ unless you untick it. For <b>v48</b> nothing shifts either (the twelve POP and BACK settings come last, in their own group), so no Reset settings: paste, Save, and recreate both alerts — this one sends alerts too. <b>POP</b> and <b>BACK</b> are on in ⚙ unless you untick them. For <b>v49</b> nothing shifts (its two settings, the POP's volume test, come last, at the end of the POP and BACK group), so no Reset settings: paste, Save, and recreate both alerts. From then on a POP is weak when the biggest of its candle and the two candles before it traded under 10 times the average of the 20 candles before them: gray on the chart, stored, and it doesn't ping.</div>
    <div><b>Pullback basis line</b> (v45): a white line on the chart — the basis (middle line) of a Bollinger Band of its own timeframe, which is the average of that timeframe's last closes (default: the last 20 closes of 15-second bars). It is there to time an entry after a PULLBACK: a close back above it. A line only — no alert and no row here. Its switch, timeframe and length are the last three settings of the Inputs' Pullback group.</div>
    <div><b>Band cross basis line</b> (v46): the same kind of line for the band cross, in teal — the basis of a Bollinger Band of its own timeframe and length (default: the last 20 closes of 15-second bars), drawn while the EMA cross setup is on. It is not the band the cross itself uses (that one is the VWAP + BB cross's band). A line only — no alert and no row here. Its switch, timeframe and length are the last three settings of the Inputs' “EMA cross over VWAP” group. With the same timeframe and length as the Pullback basis line the two sit on top of each other.</div>
    <div><b>On / off</b>: each setup has a switch in the script's Inputs — “Pullback setup on”, “VWAP + BB cross setup on”. Off = no markers and no alerts from it; a VWAP line no setup uses isn't drawn. The alerts copy the switches when you create them.</div>
    <div><b>VWAP lines</b> (v28): the Inputs' “VWAP lines from” picks how the script builds its VWAPs, for the lines it draws and for every setup. <b>30s bars</b> (ours, the default): built from 30-second bars, so the line is the same on your 5m and 30s charts and closer to the true VWAP. <b>Chart bars</b>: TradingView's built-in way, from each chart's own bars, so it differs by timeframe (on your alerts, a 5m chart's line sat a median 0.4% from the 30s chart's, a 10m chart's 1.6%). The alerts copy the choice when you create them. The month line has its own switch (v31), “Month VWAP from”: <b>30s bars</b> (the default) builds it from this month's hourly bars plus today's 30-second bars — the yellow line you see is then the one PULLBACK and the VB use, on every chart (on a name whose one day dwarfs the month, TradingView's own month VWAP can sit several % away: ROMA 10-28, ~6%); <b>chart bars</b> = TradingView's anchored VWAP, as before.</div>
    <div><b>4.</b> Notifications → Webhook URL: <code>https://pnldash.uz/api/tv/webhook?key=…</code> (the key is TV_WEBHOOK_SECRET).</div>
    <div><b>RVol</b> (optional): ⋯ → <b>Copy RVol script</b> → a new Pine Editor tab → Add to chart. It shows the Momentum table's RVol 1m / 5m / Day in its own pane, in the same units; set the pane's scale to Logarithmic. No alert needed.</div>
    <div><b>TWS bridge</b> (optional, 11-26): a small program on your own computer (<code>tools/tws-bridge</code>) that talks to the TWS you are logged in to. The <b>TWS</b> button in this panel's header switches it on for this browser and holds its settings; until then nothing changes here. With it on, a row whose alert is no older than 10 minutes has <b>Buy</b>, with the shares and the limit price on it: one click places your bracket in TWS (a limit buy with a take-profit and a stop), and the row then reads what was sent, then the fill against the alert's price, with <b>Cancel</b> beside it until the buy fills. A setup that is over has no Buy: a BROKEN or a HELD row, and a PULLBACK already marked “✗ broke”. A POP has one. One alert, one order at a time: after a buy that is working or filled the button is gone; cancel it unfilled and the button returns, with “cancelled” before it (the same when TWS refused the order). <b>Chase</b>, beside Cancel on a buy that has not filled because the price ran: one click moves that buy up to the live ask plus the same offset, and its take-profit and stop with it; never past the cap against the alert's price, and only so many times (3% and 5 moves unless you changed them in the bridge's config). The line then says where the buy is and where it started (“moved 2×, first 0.4302”). <b>Sell</b>, on an order that holds shares: one click sells what it holds just under the live bid (2% under unless you changed it; a limit order, so it should fill at the bid and no lower than that limit). While that sell is working the button reads <b>Sell lower</b>, and a click moves it down to the bid of that moment; when it is done the line reads what was sold against the buy (“sold 929 @ 0.4101 (−4.7% vs the buy)”). On a buy that only part filled, <b>Cancel the rest</b> cancels what has not filled, and <b>Sell 40</b> sells the shares that did (the bridge cancels the rest first). Every price change is a click: nothing on this page and nothing in the bridge re-prices by itself. Sell and Cancel work while the bridge is halted and whatever the alert's age: an order that holds shares keeps its line and its Sell button on the card for as long as it holds them, after a reload and under a newer alert too (as “earlier order”). If an exit order is left working in TWS on a position that is already closed, the bridge cancels it and the card says so in amber; check TWS when you see it. <b>Dollar sizing</b>: with <code>order.amountUsd</code> in the bridge's config (400, say), a buy is as many whole shares as that pays for at its limit, rounded down, and the button reads <b>Buy $400 ≈ 929 @ 0.4302</b>; when the limit comes from the live ask it reads <b>Buy $400 @ ask +1%</b> and the shares are worked out at the click. A chase does not change the shares. Orders go from this computer straight to TWS and never through the pnldash server. The bridge refuses a live account until its own config says otherwise (<code>"paperOnly": false</code>, set by hand in its file; the button then reads <b>Buy LIVE</b>, in red). It also refuses an alert older than 10 minutes and a second order for the same ticker within 10 seconds (a Buy clicked that soon after the order you cancelled is refused with the bridge's “duplicate” text: click again a few seconds later), and it places nothing while TWS has lost IB's servers (the TWS line then reads “offline”). The prices are the bridge's settings, not this page's: the page sends the ticker, the alert's price and the alert's stop, and the shares, the limit, the take-profit and the stop are worked out by the bridge from <code>tools/tws-bridge/config.json</code> (the TWS button's panel shows them).</div>
    <div><b>Buy if ≥</b> (TWS bridge, 11-27), the outlined button beside Buy: one click places the same bracket with a buy that waits above the alert's price (<b>Buy $400 if ≥ 0.3744 (+5%)</b>), so it fills only if the price gets up there, and a pop that goes nowhere buys nothing. While it waits the row reads <b>waiting: buy … if the price reaches …</b> with the time it waits until; IB then cancels it by itself if it has not filled, the row reads <b>expired unfilled at …</b>, and the two buttons come back while the alert is under 10 minutes old. It has <b>Cancel</b> and no Chase, and its numbers (how far above the alert it triggers, its limit above that, how long it waits) are the bridge's settings, shown in the TWS button's panel as <b>Buy if above</b>.</div>
    <div style={{ marginTop: 8, color: '#8c8c8c' }}>
      <b>Reading the list.</b> Five setups: <b>PULLBACK</b> (price back near a VWAP line after a run; then BROKEN or HELD), the <b>VWAP + BB cross</b> (CROSS, then RETEST), (v35) the <b>EMA cross</b> over VWAP, with (v37) its <b>BOUNCE</b>, (v47) <b>TURN</b> (a bounce off a basis line that fell and turned up), and (v48) <b>POP and BACK</b> (a run gets 10% above its basis line: POP, a heads-up; then it comes back to the basis and bounces: BACK, the entry; since v49 a POP without a volume surge is weak and stays quiet, and so does its BACK). A CROSS or a RETEST pings only when the name is on Momentum (⭐) or its day high is +30% or more; an EMA cross, a BAND cross, a BOUNCE, a TURN, a POP or a BACK pings only when the name is on Momentum (since 11-15; ⚙ → <b>EMA / BAND / BOUNCE / TURN / POP / BACK: Momentum list only</b> — untick it to let a +30% day high ping off the list too). The rule has one exception since 11-27: <b>a POP or a BACK with volume {POP_FREE_VOL}× and over alerts on any name</b>, on the list or not. Off-list ones show dimmed, except such a POP or BACK that pinged: it is a full row and reads <b>off Momentum</b> where the ⭐ would be. <b>Show only Momentum tickers</b> (the checkbox under the title) hides the rows without a ⭐ and silences their toasts and sounds on this dashboard (Telegram is unchanged), again except a POP or a BACK with volume {POP_FREE_VOL}× and over that pinged: it stays in the list and still rings. The browser remembers the checkbox.
      <span style={{ color: '#95de64' }}> ↺ held before</span> / <span style={{ color: '#95de64' }}>↺ touch 3+</span> on a pullback: that line already held today, or this is its 3rd+ touch. On the first 10 live days (to 10-16) those held 33–36% of the time, against 24% for the rest.
      <div style={{ marginTop: 6 }}>
        <b>CROSS</b> (v21, the 30s alert only): a candle of the timeframe you set (default <b>2m</b>) crosses a VWAP line and the upper BB of the other timeframe you set (default <b>30s</b>): at a 30s close inside it, its open is under both as they stand then (with the tolerance setting above 0, an open up to that % over the lower line also counts; default 0) and the close is above both — the body crosses the lines the chart draws for that candle (v23; the day's first candle counts). The lines (v22): session (<b>S</b>), month (<b>M</b>) and year (<b>Y</b>), each with its own count. It rings while the candle is still open, and on the candle timeframe's chart that candle gets a marker: teal <b>VB</b> (session), yellow <b>VB M</b> (month), blue <b>VB Y</b> (year). The tag shows the line, the timeframes and the day's cross number on that line (#1 = first); after a line's 3rd cross of the day, its crosses stay quiet, and so do crosses on names off our Momentum list unless the day high is +30% or more (a runner the screen hasn't caught yet). ⚙ → 📐 Stages that alert → CROSS turns it on or off.
      </div>
      <div style={{ marginTop: 6 }}>
        <b>RETEST</b> (v28, the 30s alert only): your entry. After the VB candle closes, price comes back to the VWAP line it crossed (within 1% of it, or under it), and (v30) <b>the candle that came back closes above the line</b> — it rings at that candle's close (a candle closing under it gives no RETEST and ends it); the Inputs' “VB retest fires” can switch back to v28's first green 30s close above the line. Its row shows <b>retest · stop $X</b>: the stop under the pullback's low, with its distance from the RETEST price. A newer VB candle starts a new one, and a candle closing back under the line cancels it (on your VB timeframe, so a wick under the line doesn't). Like CROSS it pings only on Momentum names (or a day high of +30% or more), its tag shows the timeframes and the ticker's retest number for the day, and after its 3rd of the day it stays quiet. It waits up to 6 candles after the VB candle closes (an input). Measured on four months: the cheapest entry per trade (−0.9% against −1.3% for buying the break of the VB high and −1.9% for buying the CROSS), with a ~2% stop, but stopped more often — a heads-up, not an edge. ⚙ → RETEST turns it on or off.
      </div>
      <div style={{ marginTop: 6 }}>
        <b>EMA</b> (v35, the 30s alert only): the EMA of a timeframe's closes (default <b>EMA 9</b> of <b>2m</b> candles) crosses above a VWAP line — the <b>session</b> line by default; month and year are switches in the Inputs. Since v44 the script's default line is the band (BAND, below): set “EMA cross: the line that crosses the VWAP” to EMA or Both to run this one. It is judged when each 2m candle closes: the EMA above the line at that close, at or under it at the close before. The day's first candle can't fire (the session line starts over there), and a cross on a day's last candle is not sent the next morning. The script draws the EMA (aqua) and an orange <b>EMA</b> marker on a chart whose bars divide the EMA's timeframe: a 2m, 1m or 30s chart for a 2m EMA. The tag shows the line, the timeframe and length (<b>2m/9</b>) and the day's cross number on that line; after a line's 3rd cross of the day it stays quiet. Gainers only by default, and it pings only on Momentum names (the ⚙ rule “EMA / BAND / BOUNCE / TURN / POP / BACK: Momentum list only”, on by default; off, a day high of +30% or more pings off the list too, like CROSS; the rule's one exception is a POP or a BACK with volume {POP_FREE_VOL}× and over, which alerts on any name). The line is the script's own VWAP (from 30s bars by default), so it can sit a little off TradingView's built-in VWAP on a 2m chart. Not graded. ⚙ → EMA turns it on or off.
      </div>
      <div style={{ marginTop: 6 }}>
        <b>EMA filter</b> (v36): the script calls a cross <b>weak</b> when its candle opened before <b>07:00</b> New York time, when the EMA had been under the line for fewer than <b>5</b> candles before it, or when the EMA and the line crossed more than <b>2</b> times in the 20 candles before (chop). A weak cross gets a small gray <b>ema</b> marker on the chart, is stored and listed in the Setups history with <b>weak</b> beside it, and never pings or takes a row here; it doesn't take a day's cross number either. Measured on three months of our Momentum names (3,768 crosses): the weak ones closed back under the VWAP within 5 candles 57% of the time, the rest 41–44%. The plain cross still loses on average with a stop and a 2R target (about −0.16R after the filter, −0.21R before) — fewer false ones, not an edge. The three numbers and the on/off switch are in the Inputs' “EMA cross over VWAP”, last four; change them, then recreate both alerts. The expanded row shows what the script measured (<b>12 candles under · 1 flip</b>).
      </div>
      <div style={{ marginTop: 6 }}>
        <b>BOUNCE</b> (v37, the 30s alert only): the pullback after an EMA cross. After the cross candle, the script waits up to <b>10</b> of the EMA's candles (20 minutes on 2m) for a candle whose <b>low comes down to the EMA</b> (at or under it) <b>or to the VWAP</b> (within 1% above it), and then for that candle or a later one to <b>close green above the EMA</b> — that close is the BOUNCE. A candle closing under the VWAP first ends the wait, and so does a newer cross (it starts its own). Its row shows <b>bounce · stop $X</b>: a tick under the pullback's lowest low. On the chart it is a lime <b>BNC</b> label; a bounce after a weak cross is a small gray <b>bnc</b>, stored with <b>weak</b> and not announced. Like the EMA cross it pings only on Momentum names (the same ⚙ rule) and stays quiet after its 3rd of the day on a line. Measured on the same three months: about 44% of the crosses give a bounce; those entries closed back under the VWAP within 5 candles 35% of the time (48% for buying the cross) and lost about −0.08R with that stop and a 2R target (−0.21R for the cross) — fewer false ones and under half the loss, still not an edge on its own. The crosses that never gave a bounce were mostly the failures, not runs that got away. The settings (on / off, EMA or VWAP or both, the wait, the two touch distances) are the last five in the Inputs' “EMA cross over VWAP”. It rides the <b>EMA + BOUNCE</b> switch in ⚙.
      </div>
      <div style={{ marginTop: 6 }}>
        <b>BAND</b> (v40, the 30s alert only): the EMA cross's rule with the <b>upper Bollinger Band</b> as the line that crosses the VWAP. “EMA cross: the line that crosses the VWAP” picks <b>EMA</b>, <b>BB upper</b> (the default since v44) or <b>Both</b>; with Both each line runs on its own, with its own alerts and day's cross numbers. The band is the VWAP + BB cross's own: its BB timeframe (default <b>30s</b>), length and StdDev, built from the 30s bars, so every chart and the alert read one line. The rest is the EMA cross's: judged at each close of the EMA's candle timeframe (default 2m) — the band above the VWAP at that close, at or under it at the close before — the same lines, gainer filter, weak-cross filter (counting the band's own candles under the line and its crossings) and the day's cap. There is <b>no BOUNCE</b> after a band cross: the bounce is a pullback to the EMA and follows the EMA's crosses. The band usually sits above price, so it crosses the VWAP before price does: an earlier heads-up, often with price still under the line. The chart draws the band (orange) on a 2m, 1m or 30s chart for a 2m timeframe, whether or not the VWAP + BB cross is on, and marks the cross with a maroon <b>BB</b> label (a small gray <b>bb</b> for a weak one). Here its pill reads <b>BAND</b> (maroon) with the timeframes (<b>2m/30s</b>), and since 11-16 it has its own switch in ⚙ → <b>BAND (BB upper)</b> (it started with the EMA switch's value). The alerts copy the choice when you create them. <b>v41, the middle-line test:</b> a fast drop widens the band, so its upper line can rise over the VWAP while the price falls away from it (CLRO 11-16). A band cross whose candle <b>closed under the band's middle line</b> (the average the band is built around) is that kind: the script draws it as a small gray <b>bb</b>, sends it with “weak”, and it never pings or takes a row here; the expanded row and the history show how far under the middle the price was. The last input switches the test off. Measured on three months of our Momentum names (a 1m band, 5,563 crosses): a quarter of the band's crosses are of this kind, and they were followed by a bounce more often than the rest (about +0.2% to +0.8% five candles later against −0.5% to −0.6%), so it is a different event — a dip, not a push — rather than a worse one; the first push of a move from flat (the RBNE / GP kind) happens before a name reaches our screen and isn't in that data.
      </div>
      <div style={{ marginTop: 6 }}>
        <b>TURN</b> (v47, the 1m alert only): a bounce off a basis line that fell and turned up. The <b>basis</b> is the average of the last <b>15</b> closes of <b>1-minute</b> candles. It must have <b>fallen at least 10%</b> before its low, and that low must be recent (within the last 15 candles). Then a candle <b>closes above the basis</b>, and within the next <b>10</b> candles a candle's <b>low comes back to the basis</b> (within 1% above it counts) and that candle or a later one <b>closes green above the basis</b>, with the basis rising and the MACD green (above its signal line) — that close is the TURN. A candle closing under the basis first ends the wait. Its row shows <b>turn · stop $X</b>: a tick under the pullback's lowest low. On the chart it is a fuchsia <b>TN</b> label and its basis is the fuchsia line, both on a chart of the basis's timeframe (1m). Here its pill reads <b>TURN</b> (fuchsia) with the timeframe and the length (<b>1m·15</b>) and the ticker's TURN number for the day. Like the EMA cross it pings only on Momentum names (the same ⚙ rule) and stays quiet after its 3rd of the day on a ticker. Measured on 71 days before it was built: after a 10% fall about one in five went +5% and one in eleven +10% before closing back under the basis — about break-even with that stop and a 2R target. An experiment, not an edge. Its settings are the Inputs' group “TURN: the bounce off a basis that turned up” (the last one before v48's). ⚙ → TURN turns it on or off.
      </div>
      <div style={{ marginTop: 6 }}>
        <b>POP and BACK</b> (v48, the 1m alert only): one setup in two steps, on a basis line of its own — the average of the last <b>15</b> closes of <b>1-minute</b> candles. A <b>run</b> starts when a candle closes above the basis and ends when one closes under it. <b>POP</b> is a heads-up, not an entry: the first candle of a run by which a high has reached <b>10%</b> above the basis, one per run. Open the chart and be ready. <b>BACK</b> is the entry: after the POP candle a candle's <b>low comes back to the basis</b> (within 1% above it counts), then that candle or a later one <b>closes green above the basis</b>, with the basis rising and the MACD green (12 26 9, above its signal line), within <b>20</b> candles of the POP candle — that close is the BACK. A candle closing under the basis first ends the wait, and a POP has one BACK at most. A BACK's row shows <b>back · stop $X</b>: a tick under the pullback's lowest low. A POP's row shows <b>pop · ran +X% · vol N×</b> (how far a high of the run got above the basis, and since v49 its volume reading, explained under the volume test below) and has no stop. On the chart POP is a yellow <b>POP</b> label above its candle and BACK an aqua <b>BK</b> label under its candle, both on a chart of the basis's timeframe (1m); the basis line (“POP basis (v48)”) is hidden until you switch it on in the indicator's Style tab, and with the default settings it is the same line as TURN's. Here the pills read <b>POP</b> (gold) and <b>BACK</b> (purple) with the timeframe and the length (<b>1m·15</b>) and the ticker's POP or BACK number for the day. A BACK takes its POP's place as the ticker's row, and the POP stays in the day trail (click the row). A BACK can also come with no POP before it, and a POP's BACK can go unsent: the gainer filter is read at each alert's own candle. A BACK and a TURN can ring on the same candle: they are separate setups and both are sent. Since 11-27 a POP or a BACK that is not weak and whose volume reading is <b>{POP_FREE_VOL}× or more</b> pings on <b>any name</b>, on the Momentum list or not, whatever the ⚙ rule says. The reason: a stock with no volume that suddenly pops is not on the Momentum screen yet. On the first live morning (11-27) there were 12 strong POPs and only 2 pinged, because the other 10 were on names not on the list at that moment. Off the list such a row reads <b>off Momentum</b> where the ⭐ would be and isn't dimmed, and <b>Show only Momentum tickers</b> no longer hides it or silences its toast and sound. A POP or a BACK with a lower reading, or with no reading, still pings only on Momentum names, like TURN (the same ⚙ rule). The {POP_FREE_VOL}× is the server's own number: it doesn't move with the script's minimum. Each still answers to its own ⚙ switch and stays quiet after its 3rd of the day on a ticker. Measured on 71 days of our own 1m bars before it was built: about 35 POPs a day on Momentum names (28 after the 3-a-day cap); a BACK followed 28% of the POPs, a median 7 candles later and 1–2% under the POP candle's close — about 10 BACKs a day. Of the BACKs, 29–35% went +5% and 16–20% went +10% before a close back under the basis; with that stop and a 2R target they came to −0.05R to −0.08R, about break-even. Buying the POP candle itself was measured first and loses (a third of the pops were back under the basis within 5 candles), which is why POP is only a heads-up. With 5% in place of 10% there were 110–130 POPs a day and the BACKs did worse (−0.22R). An experiment, not an edge. Its twelve settings are in the script's last group, the Inputs' “POP and BACK: a pop off the basis and its first pullback (v48)” (v49's two come after them). ⚙ → POP and ⚙ → BACK turn each on or off. <b>v49, the volume test:</b> the script takes <b>the biggest volume among the POP candle and the two candles before it</b> and reads it <b>against the average volume of the 20 candles before those three</b>. Three candles, because a pop often takes two or three candles to reach the 10% mark, and against the 20 candles before the POP candle alone its own first candles would water the average down. A POP whose reading is under <b>10×</b> is <b>weak</b>: the script draws it as a small gray <b>pop</b> label and sends it with “weak”; it is stored and listed in the Setups history with <b>weak</b> beside it, and it never pings or takes a row here. It doesn't take a day's POP number either. The <b>BACK after a weak POP is weak</b> the same way (a small gray <b>bk</b> label, stored, no ping, no row, no BACK number). Every POP and BACK row shows the reading: a POP's row here reads <b>vol 212×</b> after <b>ran</b>, the expanded row spells it out (<b>volume 212.4× the 20 candles before the pop</b>; on a BACK it is its POP's, <b>the pop's volume 212.4× the 20 candles before it</b>), and the Setups history has it in the <b>POP vol</b> column, the weak ones included. Two cases have no reading: those 20 candles had no volume at all (a POP with volume now then counts as a surge), or the chart has fewer than 23 candles (that POP is weak). Rows from before v49 have none either. The reason is your observation: the POPs worth taking come out of a stock with almost no volume before (RAYA 11-25: the pop off a flat base was the kind you want; the later one, at the end of a slow climb on steady volume, was not, and reads 6.2×). Measured on our own 71 days of 1m bars before it was built: among names already on the Momentum screen the reading did not sort the POPs (a high +10% above the POP's close followed about as many whatever the reading). That data has no pops from stocks that were not yet on the screen, which is the case you mean, so the stored readings will show whether it holds. The two settings are the script's last, at the end of the POP and BACK group: the switch (“POP: only a pop with a volume surge is announced (v49)”) and the minimum, 10 (“POP: …the biggest of the POP candle and the two candles before it traded at least this many times the average of the 20 candles before them”). With the switch off every POP is announced as before, and the reading is still sent. Change them, then recreate both alerts.
      </div>
    </div>
  </div>
);

// The TradingView watchlist the alerts run on is pasted in by hand (TradingView
// has no watchlist API), and the alerts only see names that are on it. The
// sidebar remembers what the last Copy list / Download held (this browser) and
// flags today's screen names that weren't in it — a name that wasn't a runner
// yet goes unwatched all day otherwise (MI 2026-10-05: +634%, no alerts).
// Watchlist alerts pick up added symbols by themselves; no alert recreation.
const LIST_KEY = 'tvList.lastCopied';
interface CopiedList { at: number; symbols: string[] }   // bare tickers
const bareSym = (s: string) => s.replace(/^[A-Z_]+:/i, '').toUpperCase();
function loadCopied(): CopiedList | null {
  try {
    const raw = localStorage.getItem(LIST_KEY);
    return raw ? (JSON.parse(raw) as CopiedList) : null;
  } catch {
    return null;
  }
}
// Replace the remembered list (a full Copy / Download) or add to it (Copy new).
function saveCopied(symbols: string[], addTo: CopiedList | null): CopiedList {
  const v = { at: Date.now(), symbols: [...new Set([...(addTo?.symbols ?? []), ...symbols.map(bareSym)])] };
  try { localStorage.setItem(LIST_KEY, JSON.stringify(v)); } catch { /* private mode */ }
  return v;
}

// 📐 setups in the left rail (operator, 2026-10-05: "organize this list … move
// it to the sidebar"). One row per ticker with its CURRENT state — the stage,
// its line (S session / M month / Y year), touch #, age and the distance to
// the line — live setups first, the rest under "Earlier today", each section
// newest first (operator: order by alert time; ⭐ still marks Momentum names).
// The 1m and 2m alerts' copies merge into one event. A click selects the
// ticker and opens its day trail.
export function TvSetupsSidebar({ payload }: { payload: CyclePayload | null }) {
  const { message } = App.useApp();
  const { selected, setSelected } = useSelection();
  const { alerts } = useAlertLog(payload);
  const { settings: stageSettings } = useTvAlertStages();
  // A ticker hidden from Momentum (today, this user) is hidden here too (2026-10-07).
  const { hidden } = useHiddenTickers();
  const hiddenKey = [...hidden].sort().join(',');
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [showEarlier, setShowEarlier] = useState(() => {
    try { return localStorage.getItem('tvSidebar.earlier') !== '0'; } catch { return true; }
  });
  // 11-03 (operator): "Show only momentum tickers" — only the ⭐ rows; their
  // toasts and sounds follow it (useTvMomoOnly). 11-27: a POP or a BACK that
  // pinged on any name stays, off the list too (momoOnlyCards).
  const momoOnly = useTvMomoOnly();
  const [howTo, setHowTo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<CopiedList | null>(() => loadCopied());
  // TWS bridge (2026-11-26): off unless switched on in this browser. Then a fresh alert's row
  // has a Buy button that places the operator's bracket order — through a program on this
  // computer, never through our API — and the row shows that order with what can be asked of it:
  // Cancel, Chase (move a buy that has not filled up to the ask) and Sell (get out of what it
  // holds), since 2026-11-27. Every one is a click; nothing re-prices by itself. (The first
  // version also had a per-row "TWS" button and a row click that moved TWS's windows to the
  // ticker; removed 2026-11-27 at the operator's request.)
  const tws = useTwsBridge();
  const twsOn = tws.settings.enabled;
  const listRef = useRef<HTMLDivElement | null>(null);
  // The Buy, stop-entry, Chase and Sell buttons on screen, by what they are for ("buy:<alert id>",
  // "stop:<alert id>", "chase:<order id>", "sell:<order id>:first" / ":lower").
  const buyEls = useRef(new Map<string, HTMLElement>());
  const buyTops = useRef(new Map<string, { top: number; left: number }>());   // where each sat after the last render
  const buyHold = useRef(new Map<string, number>());          // …and until when it takes no click
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    // Where a button sits on screen, with the list's own scrolling taken out: scrolling the list
    // is the operator's doing, anything else that moves a button is not.
    const scrolled = list.scrollTop;
    const t = performance.now();
    const tops = new Map<string, { top: number; left: number }>();
    const moved: string[] = [];
    for (const [id, el] of buyEls.current) {
      const box = el.getBoundingClientRect();
      const at = { top: Math.round(box.top + scrolled), left: Math.round(box.left) };
      tops.set(id, at);
      const was = buyTops.current.get(id);
      if (was == null || Math.abs(was.top - at.top) > 2 || Math.abs(was.left - at.left) > 2) moved.push(id);
    }
    for (const id of moved) {
      buyHold.current.set(id, t + BUY_HOLD_MS);
      // An alert's two buy buttons are held as one.
      const pair = /^buy:/.test(id) ? id.replace(/^buy:/, 'stop:') : /^stop:/.test(id) ? id.replace(/^stop:/, 'buy:') : null;
      if (pair != null && tops.has(pair)) buyHold.current.set(pair, t + BUY_HOLD_MS);
    }
    buyTops.current = tops;
    for (const id of [...buyHold.current.keys()]) if (!tops.has(id)) buyHold.current.delete(id);
  });
  // Today's screen names come first in the server's list (`today` of them).
  const { data: tvList } = useQuery({
    queryKey: ['tv', 'watchlist'],
    queryFn: () => tvApi.watchlist(),
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
  });
  const missing = useMemo(() => {
    if (!tvList || !copied) return [];
    const have = new Set(copied.symbols);
    return tvList.symbols.slice(0, tvList.today).filter((sym) => !have.has(bareSym(sym)) && !hidden.has(bareSym(sym)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hiddenKey stands in for the Set
  }, [tvList, copied, hiddenKey]);

  useEffect(() => {
    // 5 s (was 30 s): the 20-s "just rang" highlight below has to clear on time.
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, []);

  const rowByTicker = useMemo(() => new Map((payload?.rows ?? []).map((r) => [r.ticker, r])), [payload]);
  // Until the switches load, show every stage rather than flash an empty list.
  const allCards = useMemo(() => {
    const on = stageSettings ? new Set(stageSettings.announced) : null;
    return buildCards(alerts, now, (st) => on == null || on.has(stageSwitch(st)));   // a BOUNCE rides the EMA switch
  }, [alerts, now, stageSettings]);
  const cards = useMemo(
    () => allCards.filter((c) => !hidden.has(c.ticker)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hiddenKey stands in for the Set
    [allCards, hiddenKey],
  );
  const hiddenCount = allCards.length - cards.length;
  // On Momentum = on the screen right now (the ⭐). Before the first cycle
  // arrives nothing is, so the filter waits for it. `offMomo` counts the cards
  // the checkbox really hides: a POP or a BACK that pinged on any name is shown.
  const shown = momoOnly && payload ? momoOnlyCards(cards, (t) => rowByTicker.has(t)) : cards;
  const offMomo = cards.length - shown.length;
  const live = shown.filter((c) => c.live).sort((x, y) => y.current.at - x.current.at);
  const earlier = shown.filter((c) => !c.live).sort((x, y) => y.current.at - x.current.at);

  const toggleEarlier = () => setShowEarlier((v) => {
    try { localStorage.setItem('tvSidebar.earlier', v ? '0' : '1'); } catch { /* private mode */ }
    return !v;
  });
  const toggleOpen = (t: string) => setOpen((s) => {
    const n = new Set(s);
    if (n.has(t)) n.delete(t); else n.add(t);
    return n;
  });

  // A place for a button that moves money: where it sits is remembered (the layout effect above),
  // so a click on it right after it appeared or moved can be held back.
  const holdRef = (key: string) => (el: HTMLElement | null) => {
    if (el) buyEls.current.set(key, el); else buyEls.current.delete(key);
  };
  // True, with a line on the card saying so, when the button under the click only just got there.
  const heldBack = (key: string, ticker: string, what: string): boolean => {
    if (clickTime().sinceLoad >= (buyHold.current.get(key) ?? 0)) return false;
    tws.note(ticker, `The list just moved under the button: nothing was sent. Click ${what} again.`);
    return true;
  };
  // One click on Buy = one /order call for that alert (the bridge controller's lock sees to it).
  // The page sends the ticker, the alert's price, its stop when it has one, and what the alert was.
  // The second button (11-27) is the same call with `entry: "stop"`: the buy waits above the
  // alert's price. The two share the alert's one lock, so a click on both sends one order.
  const buyRow = (c: TickerCard, entry: BridgeEntry) => {
    const e = c.current;
    if (setupOver(c)) return;   // no button there; a second look costs nothing
    if (heldBack(`${entry === 'stop' ? 'stop' : 'buy'}:${e.id}`, c.ticker, entry === 'stop' ? '“Buy if ≥”' : 'Buy')) return;
    const click = clickTime();
    if (click.at - e.at > BRIDGE_ALERT_MAX_AGE_MS) {
      tws.note(c.ticker, 'This alert is older than 10 minutes: nothing was sent.');
      return;
    }
    const req = bridgeOrderRequest({ ticker: c.ticker, price: e.price, stop: e.setup.stop, stage: e.setup.stage, at: e.at, id: e.id });
    if (req) tws.buy(e.id, entry === 'stop' ? { ...req, entry: 'stop' } : req);
  };

  const withList = async (use: (list: TvWatchlist) => Promise<void> | void) => {
    setBusy(true);
    try {
      await use(await tvApi.watchlist());
    } catch (err) {
      message.error(`Could not build the list: ${err instanceof Error ? err.message : 'error'}`);
    } finally {
      setBusy(false);
    }
  };
  const menu = {
    items: [
      { key: 'copy', label: 'Copy list' },
      { key: 'download', label: 'Download .txt' },
      { key: 'script', label: 'Copy Pine script' },
      { key: 'rvol', label: 'Copy RVol script' },
      { key: 'howto', label: 'How to set up the alerts' },
    ],
    onClick: ({ key }: { key: string }) => {
      if (key === 'copy') {
        void withList(async (list) => {
          await navigator.clipboard.writeText(list.symbols.join(','));
          setCopied(saveCopied(list.symbols, null));
          message.success(`Copied ${list.symbols.length} symbols — ${list.today} on today's screen + ${list.runners} runners (≥+${list.min_chg}% in ${list.days}d, ≥+${list.recent_min_chg}% in the last 3 sessions)`);
        });
      } else if (key === 'download') {
        void withList((list) => {
          const url = URL.createObjectURL(new Blob([list.symbols.join(',')], { type: 'text/plain' }));
          const a = document.createElement('a');
          a.href = url;
          a.download = `pnldash-runners-${new Date().toISOString().slice(0, 10)}.txt`;
          a.click();
          URL.revokeObjectURL(url);
          setCopied(saveCopied(list.symbols, null));
          message.success(`Downloaded ${list.symbols.length} symbols — import it from the TradingView watchlist menu`);
        });
      } else if (key === 'script') {
        navigator.clipboard.writeText(pineScript)
          .then(() => message.success('Pine script copied — paste it into the TradingView Pine Editor'))
          .catch(() => message.error('Clipboard blocked by the browser'));
      } else if (key === 'rvol') {
        navigator.clipboard.writeText(rvolScript)
          .then(() => message.success('RVol script copied — paste it into a new Pine Editor tab and Add to chart (no alert needed)'))
          .catch(() => message.error('Clipboard blocked by the browser'));
      } else {
        setHowTo(true);
      }
    },
  };

  const copyNew = () => {
    navigator.clipboard.writeText(missing.join(','))
      .then(() => {
        setCopied(saveCopied(missing, copied));
        message.success(`Copied ${missing.length} new symbol${missing.length === 1 ? '' : 's'} — add them to the TradingView watchlist; the alerts pick them up by themselves`);
      })
      .catch(() => message.error('Clipboard blocked by the browser'));
  };

  // One click on Chase = one /chase call: the bridge moves that buy up to the live ask + offset,
  // once. One click on Sell = one /sell call: it sells what the order holds just under the live
  // bid, or moves a sell that is already working lower. The page sends the order's id, no price.
  const chaseOrder = (b: BridgeOrderBlock, ticker: string) => {
    if (heldBack(`chase:${b.order_id}`, ticker, 'Chase')) return;
    tws.chase(b.order_id, ticker);
  };
  const sellOrder = (b: BridgeOrderBlock, ticker: string) => {
    if (b.sell == null || heldBack(`sell:${b.order_id}:${b.sell.lower ? 'lower' : 'first'}`, ticker, b.sell.label)) return;
    tws.sell(b.order_id, ticker);
  };
  // An order's buttons, in its text's own flow after the last word, so they cost no line of
  // their own: Chase, Cancel (the buy, or "the rest" of one that part filled), Sell (in the
  // danger style: it sells at the bid). While a call for the order is in flight none takes a click.
  const orderButtons = (b: BridgeOrderBlock, ticker: string) => (
    <>
      {b.chase && (
        <span ref={holdRef(`chase:${b.order_id}`)} style={{ display: 'inline-flex' }}>
          <Button size="small" disabled={b.busy != null} onClick={() => chaseOrder(b, ticker)} style={ORDER_BTN}>
            {b.busy === 'chase' ? 'moving…' : 'Chase'}
          </Button>
        </span>
      )}
      {b.cancel != null && (
        <Button size="small" disabled={b.busy != null} onClick={() => tws.cancel(b.order_id, ticker)} style={ORDER_BTN}>
          {b.busy === 'cancel' ? 'cancelling…' : b.cancel}
        </Button>
      )}
      {b.sell != null && (
        <span ref={holdRef(`sell:${b.order_id}:${b.sell.lower ? 'lower' : 'first'}`)} style={{ display: 'inline-flex' }}>
          <Button size="small" type="primary" danger disabled={b.busy != null} onClick={() => sellOrder(b, ticker)} style={SELL_BTN}>
            {b.busy === 'sell' ? 'selling…' : b.sell.label}
          </Button>
        </span>
      )}
    </>
  );
  // One order on a card: its line, then what the bridge or TWS had to say about it (a notice, a
  // refused change, an exit left working on a closed position), then its buttons. An error on an
  // order that is still working takes no button away.
  const orderBlock = (b: BridgeOrderBlock, ticker: string, lead: string | null) => (
    <span key={b.order_id} style={{ color: ORDER_TONE[b.tone] }}>
      {lead}{b.text}
      {b.note && <span style={{ color: '#8c8c8c' }}> · {b.note}</span>}
      {b.error && <span style={{ color: '#ff7875' }}> · {b.error}</span>}
      {b.loose && <span style={{ color: '#faad14' }}> · {LOOSE_EXIT}</span>}
      {orderButtons(b, ticker)}
    </span>
  );

  const row = (c: TickerCard, dim: boolean) => {
    const e = c.current;
    const s = e.setup;
    const r = rowByTicker.get(c.ticker);
    // Current price / change: the Momentum row when the name is on our screen,
    // otherwise the server's ~1-min quote for 📐 tickers off it (no grade there).
    const q = r ? null : payload?.tv_quotes?.[c.ticker] ?? null;
    const nowPx = r?.price != null ? Number(r.price) : q?.price ?? null;
    const nowChg = r?.change_pct != null ? Number(r.change_pct) : q?.change_pct ?? null;
    const since = nowPx != null && e.price != null && e.price > 0 ? (nowPx / e.price - 1) * 100 : null;
    const expanded = open.has(c.ticker);
    const resolved = c.resolved;
    const proven = provenLine(c, e);
    // 10-20: a setup that just rang is lit for 20 s, so the row behind the sound
    // is easy to find.
    const fresh = e.notified && now - e.at < 20_000;
    // 11-27: a POP or a BACK that pinged on any name, on a ticker that is not on the Momentum
    // screen now. It is a full row like a ⭐ one (not dimmed as off-list) and reads "off Momentum"
    // where the ⭐ would be. (Before the first cycle arrives nothing has a ⭐ yet: no label then.)
    const anyName = payload != null && !r && pingedOnAnyName(e);
    const full = r != null || anyName;
    // v28: a RETEST row leads with its stop (under the pullback's low) against the RETEST price;
    // a v37 BOUNCE row, a v47 TURN row and a v48 BACK row with their own. A v48 POP has no stop
    // (it is a heads-up): its row leads with how far the run got above the basis and (v49) its
    // volume reading, the biggest of the POP candle and the two candles before it against the 20
    // candles before those ("pop · ran +31.5% · vol 212×").
    const retestStop = s.stage === 'pop' ? popRanText(s)
      : s.stage === 'retest' || s.stage === 'bounce' || s.stage === 'turn' || s.stage === 'back' ? retestStopText(s, e.price) : null;
    // TWS bridge: the Buy button of a fresh alert, the order it made, a refusal's text.
    const t = twsOn ? bridgeCard(tws, { ticker: c.ticker, ids: e.ids, at: e.at, price: e.price, over: setupOver(c) }, now) : null;
    return (
      <div
        key={c.ticker}
        onClick={() => { setSelected(c.ticker); toggleOpen(c.ticker); }}
        style={{
          padding: '5px 8px', borderBottom: '1px solid #262626', cursor: 'pointer',
          borderLeft: `3px solid ${fresh ? '#faad14' : 'transparent'}`,
          background: fresh ? 'rgba(250, 173, 20, 0.12)' : c.ticker === selected ? '#111d2c' : undefined,
          opacity: dim ? (full ? 0.7 : 0.45) : full ? 1 : 0.7,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          {expanded ? <CaretDownOutlined style={{ fontSize: 9, color: '#8c8c8c' }} /> : <CaretRightOutlined style={{ fontSize: 9, color: '#595959' }} />}
          <TickerLinks ticker={c.ticker} />
          <TickerLink ticker={c.ticker} onSelect={setSelected} stopPropagation style={{ color: '#fff', fontWeight: 600 }} />
          {r && <span style={{ color: '#fadb14', fontSize: 11 }}>⭐</span>}
          {anyName && <span style={{ color: '#bfbfbf', fontSize: 10, whiteSpace: 'nowrap' }}>off Momentum</span>}
          <TvStageTag stage={s.stage} dim={!e.notified} line={s.line} touch={tagNumber(s)} tfs={crossTfText(s)} />
          {/* v16: past the day's cap — pings only for a B+-or-better Momentum name */}
          {s.capped && <Text type="secondary" style={{ fontSize: 10 }}>past cap</Text>}
          {proven && <span style={{ fontSize: 10, color: '#95de64', whiteSpace: 'nowrap' }}>{proven}</span>}
          {c.outcome && (
            <span style={{ fontSize: 10, color: c.outcome.stage === 'held' ? '#52c41a' : '#ff4d4f', whiteSpace: 'nowrap' }}>
              {c.outcome.stage === 'held' ? '✓ held' : '✗ broke'} {hhmm(c.outcome.at)}
            </span>
          )}
          <Text type="secondary" style={{ fontSize: 10, marginLeft: 'auto', whiteSpace: 'nowrap' }}>{age(now - e.at)}</Text>
        </div>
        <div style={{ fontSize: 11, color: '#8c8c8c', paddingLeft: 59, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ color: nowChg == null ? '#595959' : nowChg >= 0 ? '#52c41a' : '#ff4d4f', fontWeight: 700, fontSize: 12 }}>
            {nowChg == null ? '—' : fmtPct(nowChg)}
          </span>
          <span style={{ transform: 'scale(0.9)', transformOrigin: 'left center' }}>
            <GradeCell grade={r?.grade} faded={r?.grade_faded} offHigh={r?.off_high_pct} />
          </span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {retestStop && <span style={{ color: '#5cdbd3', fontWeight: 600 }}>{retestStop} · </span>}
            {resolved
              ? (since != null
                ? <span style={{ color: since >= 0 ? '#52c41a' : '#ff4d4f' }}>since {since >= 0 ? '+' : ''}{since.toFixed(1)}%</span>
                : 'since —')
              : lineDistance(s)}
            {e.tfs.length > 0 && <> · {[...e.tfs].sort(byTf).map(fmtTf).join('+')}</>}
          </span>
        </div>
        {/* TWS bridge: a third line only when there is something to put on it — the Buy button of
            an alert up to 10 minutes old, the order that came of it, or an error. Aligned on the
            text's baseline, so a text that wraps beside the button does not move the button. */}
        {t && t.any && (
          <div
            onClick={(ev) => ev.stopPropagation()}
            style={{ paddingLeft: 59, paddingTop: 3, fontSize: 11, display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '2px 6px', cursor: 'default' }}
          >
            {/* An order that ended with nothing filled (cancelled, refused, a stop entry that
                expired) freed its alert: its line comes first, then the buttons — "cancelled · Buy
                100 @ 0.4302", "expired unfilled at 15:06:30 · Buy … · Buy if ≥ …". */}
            {t.order != null && t.orderEnded && (
              <span style={{ color: ORDER_TONE[t.order.tone] }}>
                {t.order.text}
                {t.order.error && <span style={{ color: '#ff7875' }}> · {t.order.error}</span>}
                {t.buyLabel != null && ' ·'}
              </span>
            )}
            {/* Buy, and beside it the stop entry (11-27: a buy that waits above the alert's price,
                outlined so the two are told apart at a glance; red on a live account, as Buy is).
                While either's call is in flight both take no click. They wrap rather than overflow. */}
            {t.buyLabel != null && (
              <span ref={holdRef(`buy:${e.id}`)} style={{ display: 'inline-flex' }}>
                <Button size="small" type="primary" danger={tws.view.live} disabled={t.sending != null} onClick={() => buyRow(c, 'now')} style={BUY_BTN}>
                  {t.sending === 'now' ? 'sending…' : t.buyLabel}
                </Button>
              </span>
            )}
            {t.stopLabel != null && (
              <span ref={holdRef(`stop:${e.id}`)} style={{ display: 'inline-flex' }}>
                <Button size="small" type="primary" ghost danger={tws.view.live} disabled={t.sending != null} onClick={() => buyRow(c, 'stop')} style={BUY_BTN}>
                  {t.sending === 'stop' ? 'sending…' : t.stopLabel}
                </Button>
              </span>
            )}
            {/* The alert's order while it works or holds shares, with its buttons. */}
            {t.order != null && !t.orderEnded && orderBlock(t.order, c.ticker, null)}
            {t.error && <span style={{ color: '#ff7875' }}>{t.error}</span>}
            {/* Other alerts' orders on this ticker that are working or hold shares (and, beside a
                Buy button, the last one that filled): each keeps its Cancel and its Sell here. */}
            {t.others.map((b) => orderBlock(b, c.ticker, `earlier order ${hhmm(Date.parse(b.placed_at))}: `))}
            {t.note && <span style={{ color: '#ff7875' }}>{t.note}</span>}
          </div>
        )}
        {expanded && (
          <div style={{ paddingLeft: 59, paddingTop: 4, fontSize: 11 }} onClick={(ev) => ev.stopPropagation()}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
              {c.events.map((x) => (
                <span key={x.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                  <TvStageTag stage={x.setup.stage} dim={!x.notified} line={x.setup.line} touch={tagNumber(x.setup)} />
                  {isWeakSetup(x.setup) && <Text type="secondary" style={{ fontSize: 10 }}>weak</Text>}
                  <Text type="secondary" style={{ fontSize: 10 }}>{hhmm(x.at)}</Text>
                </span>
              ))}
            </div>
            <div style={{ color: '#bfbfbf', marginTop: 3 }}>
              {fmtPrice(e.price)} · {tvLevelsText(s, e.price)}
              {s.day_gain != null && <> · day high {s.day_gain >= 0 ? '+' : '−'}{Math.abs(Math.round(s.day_gain))}%</>}
              {/* v28: which VWAP the script used — our 30s-bar line or TradingView's chart-bar one */}
              {s.vwap_src && <> · VWAP from {s.vwap_src === '30s' ? '30s bars' : 'chart bars'}</>}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '6px 8px', borderBottom: '1px solid #303030', display: 'flex', alignItems: 'center', gap: 6 }}>
        <Text strong style={{ fontSize: 13 }}>📐 Setups</Text>
        <Text type="secondary" style={{ fontSize: 11, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {live.length} live · {earlier.length} earlier{hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ''}
        </Text>
        {/* The TWS bridge's button: all there is of it until it is switched on in this browser. */}
        <TwsBridgeButton bridge={tws} />
        <Dropdown menu={menu} trigger={['click']} placement="bottomRight">
          <Button size="small" type="text" icon={<EllipsisOutlined />} loading={busy} />
        </Dropdown>
      </div>
      <div style={{ padding: '2px 8px', borderBottom: '1px solid #262626', display: 'flex', alignItems: 'center', gap: 6 }}>
        <Checkbox checked={momoOnly} onChange={(e) => setTvMomoOnly(e.target.checked)}>
          <span style={{ fontSize: 11 }}>Show only Momentum tickers ⭐</span>
        </Checkbox>
        {momoOnly && offMomo > 0 && (
          <Text type="secondary" style={{ fontSize: 10, marginLeft: 'auto', whiteSpace: 'nowrap' }}>{offMomo} off Momentum not shown</Text>
        )}
      </div>
      <TwsBridgeLine bridge={tws} />
      {copied && missing.length > 0 && (
        <div style={{ padding: '4px 8px', background: '#2b2111', borderBottom: '1px solid #614700', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, color: '#ffd666', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            ⚠ {missing.length} new, not in your TV list: {missing.map(bareSym).join(', ')}
          </span>
          <Button size="small" onClick={copyNew} style={{ marginLeft: 'auto', flexShrink: 0 }}>Copy</Button>
        </div>
      )}
      {!copied && (
        <div style={{ padding: '4px 8px', borderBottom: '1px solid #262626', fontSize: 11, color: '#8c8c8c' }}>
          ⋯ → Copy list once, and new names missing from your TradingView list will show here.
        </div>
      )}
      <div ref={listRef} style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
        <div style={{ padding: '4px 8px', fontSize: 10, color: '#8c8c8c', letterSpacing: 0.5, background: '#141414', marginTop: 2 }}>
          LIVE · {live.length}
        </div>
        {live.length === 0 && (
          <div style={{ padding: '8px', fontSize: 11, color: '#595959' }}>Nothing live{momoOnly ? ' on Momentum' : ''} right now.</div>
        )}
        {live.map((c) => row(c, false))}
        <div
          onClick={toggleEarlier}
          style={{ padding: '4px 8px', fontSize: 10, color: '#8c8c8c', letterSpacing: 0.5, background: '#141414', cursor: 'pointer', marginTop: 2 }}
        >
          {showEarlier ? '▾' : '▸'} EARLIER TODAY · {earlier.length}
        </div>
        {showEarlier && earlier.map((c) => row(c, true))}
        {shown.length === 0 && (
          <div style={{ padding: '8px', fontSize: 11, color: '#595959' }}>
            {cards.length > 0
              ? 'No setups on Momentum names today. Untick "Show only Momentum tickers" to see the rest.'
              : 'No setups yet today. Signals appear here when the TradingView alerts fire (⋯ → How to).'}
          </div>
        )}
      </div>
      <Modal open={howTo} onCancel={() => setHowTo(false)} footer={null} title="Set up the TradingView alerts" width={560}>
        {HOW_TO}
      </Modal>
    </div>
  );
}
