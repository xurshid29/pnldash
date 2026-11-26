// TradingView VWAP-setup signals (2026-10-03) — the operator's discretionary
// edge, detected by TradingView itself. A Pine v6 script
// (apps/web/src/tv/mvwap-bb-setup.pine) runs as two watchlist alerts (1m + 30s)
// over the "runners" list (GET /api/tv/watchlist). Since script v27 (2026-10-28)
// it carries two setups, the ones the operator kept after trying all four:
// PULLBACK (script v10): a fast run stretches price well above the session,
// month or year VWAP and it comes back down to the line —
//   PULLBACK  a close back within ~5% above the line — be ready
//   BROKEN    a close under the line — the setup is over (the operator's exit)
//   HELD      price ran +10% from the PULLBACK close first
// tagged with the line (session / month / year, or several) and the touch
// number. The operator rates the first pullback after the first big move
// highest; on our own data (research/vwap-pullback, 2026-10-05) touch 2 did as well.
// The VWAP + BB cross (script v21): one candle of a timeframe the operator picks
// (5m, 1h, …) crosses over both a VWAP line (session; v22 also month and year)
// and the upper BB of another timeframe (45s, 2m, 30m, …) — CROSS, sent from the
// 30s alert the moment a 30s close inside the candle is above both lines. v25 adds
// its trigger (LEVEL / BREAK); v28 replaced that with RETEST, the operator's entry: after the
// VB candle closes, price comes back to the line and a 30s candle closes green above it.
// v28 also builds the lines from 30s bars by default (`vwap 30s`) or the chart's (`vwap chart`).
// v27 removed the RECLAIM setup (FORMING / READY / GO, v1–v26) and the BB breakout
// (TOUCH / BREAKOUT / TRIGGERED, v17–v26); their rows stay in tier_events, and a
// message of theirs is now rejected as unrecognised (400).
// TURN (script v47, 2026-11-25), a fourth setup: on the candles of a basis's own timeframe (the
// SMA of 15 one-minute closes), after the basis fell and turned up, price closes above it, comes
// back to it and bounces. Sent from the alert on that timeframe (1m) alone.
// POP and BACK (script v48, 2026-11-26), a fifth setup in two steps, on the same kind of basis: POP,
// a heads-up when a run's high gets well above the basis, and BACK, the entry, when the price then
// comes back to the basis and bounces. Both from the 1m alert alone. Since script v49 both carry the
// POP's volume reading (`vol_x`: the largest volume among the POP candle and the two before it
// against the 20 candles before those three), and a POP that fails the script's volume test is
// `weak`, with its BACK: stored, never announced.
//
// Why TradingView computes it and we don't: the lines are VWAPs anchored at the
// session, month and year INCLUDING pre-market volume. Yahoo's extended-hours bars
// carry zero volume, and our Finviz snapshots start only when a name reaches
// the screen — our own line cannot match the chart the operator trades.
//
// The alert's webhook posts the message to POST /api/tv/webhook (routes/tv.ts).
// This module parses it and gates duplicates; the poller delivers it like any
// opportunity alert (tier_events tier='alert' event='tv_setup', payload.alerts,
// an immediate SSE 'alert' event, Telegram) so every stage can be graded later
// against what the price did next.

import { escapeHtml } from './telegram.js';

export type TvStage = 'pullback' | 'broken' | 'held' | 'cross' | 'retest' | 'ema' | 'bounce' | 'band' | 'turn' | 'pop' | 'back';
// The PULLBACK setup's stages (script v10).
export const PULLBACK_STAGES: ReadonlySet<TvStage> = new Set<TvStage>(['pullback', 'broken', 'held']);
// The VWAP + BB cross (script v21): one stage, CROSS, on the candle timeframe's
// session VWAP — v21 messages name no line — and since v22 also on the month and
// year VWAPs (`line session|month|year`, combined like PULLBACK's). Stored as
// tier_events event 'tv_setup' and announced behind the ⚙ stage switch and the cap.
// v28 RETEST (it replaced v25–v27's LEVEL / BREAK): after the VB candle closes, price back
// within 1% of the line it crossed and a 30s candle closing green above it; `stop` = a tick
// under the pullback's low. Announced like CROSS (its own ⚙ switch, the cap on `retest N`).
export const VB_STAGES: ReadonlySet<TvStage> = new Set<TvStage>(['cross', 'retest']);
// Removed 2026-11-22 (script v44), at the operator's request: the RSI cross (stage `rsi`, v32), its
// DIP (`dip`, v34), the MACD cross after a DIP (`macd`, v39) and the basis's cross (`basis`, v42;
// see emaLineStage). Their messages are no longer read (400), a saved ⚙ switch of theirs is
// dropped, and their rows stay in tier_events, unlisted. The code is in git at 97546dd.
// Removed before them, in v39: the DIP's LIFT (stage `lift`, v38: a level some % above the DIP)
// and the VB lanes (v29: more candle timeframes for CROSS / RETEST); code in git at v38 (7c7b4b9).
// v37 BOUNCE (operator, 2026-11-13): after an EMA cross, a candle's low comes down to the EMA or
// the VWAP and that candle or a later one closes green above the EMA — the pullback entry, with a
// stop under the pullback's low. It rides the EMA's ⚙ switch (no switch of its own).
export function stageSwitch(stage: TvStage): TvStage {
  return stage === 'bounce' ? 'ema' : stage;
}
// The EMA cross, its bounce and (since 2026-11-16 a stage of its own) the band's cross: one alert
// each from the 30s alert, limited alike.
export const EMA_STAGES: ReadonlySet<TvStage> = new Set<TvStage>(['ema', 'bounce', 'band']);
// The crosses of a line over the VWAP (not the bounce): the EMA's and the band's.
export const LINE_CROSS_STAGES: ReadonlySet<TvStage> = new Set<TvStage>(['ema', 'band']);
// v35 EMA cross (operator, 2026-11-13): the EMA of a timeframe's closes (3m, length 9) crosses
// above a VWAP line (session; month / year are script switches), judged at that timeframe's
// candle close, from the 30s alert alone. Announced like CROSS: its own ⚙ switch, Momentum names
// (or a day high ≥ vb_fresh_gain), TV_SETUP.em_cap on the day's `cross N` per line.
// v36: the script's filter marks a cross `| weak` (before 07:00 ET, the EMA under the line for
// fewer than 5 candles, or more than 2 crossings in the 20 candles before; its inputs). A weak
// cross is stored and shown, never announced; the script doesn't count it in `cross N`.
// v37: a cross arms a BOUNCE (above). Announced like the cross (Momentum or a fresh runner,
// em_cap on its own `bounce N`); one after a weak cross carries `| weak` and stays quiet.
// v40 (operator, 2026-11-15: "can we make EMA Cross use BollingerBands upper row instead of EMA?
// So, add this to settings so I can switch between EMA and BB Upper row?", then "or, could we do
// both?"): a script input picks the line that crosses the VWAP — the EMA, the upper Bollinger Band
// (the VB's own), or both, each with its own crosses and day's numbers. A band cross is the EMA's
// message with `| upper 8.03 (+0.7%) | bb 45S` in the place of `| ema 9 8.03`: the same stage,
// ⚙ switch, cap and filter, shown as BAND, and its own event beside an EMA cross of the same
// candle (the gate's key). There is no BOUNCE after it (the bounce is the EMA's).
// 2026-11-16 (operator, with the ⚙ menu and a sidebar full of BAND pills: "can we separate what band
// are these? … and, these ones also?"): the band's cross is a stage of its own, `band`, with a ⚙
// switch, a label and a Telegram slug (tv_band). The script still heads its message "EMA";
// emaLineStage() tells the two apart by their fields, for a new message and for a row stored as
// stage `ema` on 11-15 / 11-16 alike. (The basis's cross became a stage the same day; removed since.)
export function emaByBand(sig: { stage: TvStage }): boolean {
  return sig.stage === 'band';
}
// The stage of an "EMA …" message by the line it names: `band` when it carries a band timeframe and
// no EMA, else `ema`. Any other stage is itself.
// Null = the basis's cross (v42: the basis of a separate band crossed the VWAP; its message was the
// EMA's with `| basis 8.03 (+0.7%) | bb 45S | len 10` in the place of `| ema 9 8.03`), removed
// 2026-11-22 (script v44; code in git at 97546dd). A message that carries a basis and no EMA is
// rejected (parseTvMessage), so its `| bb` can't pass for a band cross's; a row stored that way on
// 11-15 / 11-16 isn't listed (storedStage).
export function emaLineStage(sig: { stage: TvStage; ema?: number | null; bb_tf?: string | null; basis?: number | null }): TvStage | null {
  if (sig.stage !== 'ema' || sig.ema != null) return sig.stage;
  if (sig.basis != null) return null;
  return sig.bb_tf != null ? 'band' : 'ema';
}
// v47 TURN (operator, 2026-11-25: "bb basis goes down (usually big drop), and after that, it starts
// moving up, price crosses it, and bounces (also, macd turns green)"): a fourth setup, judged on
// the candles of a basis's own timeframe (the SMA of 15 one-minute closes by default). After the
// basis fell and turned up, a candle closes above it, a later one comes back down to it, and that
// one or a later one closes green above it with the basis rising: that bounce is the TURN, with a
// stop a tick under the pullback's low. The script sends it from the alert on the basis's
// timeframe (1m) alone, so there is no other timeframe's copy to merge. It names no VWAP line and
// has no weak filter, so it is not one of EMA_STAGES. Announced behind its own ⚙ switch (on by
// default), for Momentum names (the ⚙ rule "Momentum list only" that governs the EMA family
// governs it too), up to TV_SETUP.tn_cap a day on the message's `turn N`.
// v48 POP and BACK (operator, 2026-11-26: "these moves are initial pop, and their first pullback to
// bb basis row … how to catch such pullbacks?"; buying the pop's own candle was measured first and
// loses, so the setup has two steps, like CROSS and RETEST): on the candles of a basis's own
// timeframe (the SMA of 15 one-minute closes by default), a run is a row of closes above the basis.
//   POP   the first candle of a run by which one of its highs is at least 10% above the basis: a
//         heads-up with no entry and no stop
//   BACK  the entry: after the POP candle a low comes back down to the basis, and that candle or a
//         later one closes green above it with the basis rising; stop a tick under the pullback's low
// Two stages, each with its own ⚙ switch (on by default) and its own day's number (`pop N`,
// `back N`), announced like the TURN: Momentum names (the same ⚙ rule), up to TV_SETUP.pp_cap a day
// per ticker. The script reads the gainer filter at each alert's own candle, so a BACK can arrive
// after a POP that was never sent: a BACK is announced on its own conditions. A TURN and a BACK can
// fire on one candle; they are separate setups and both are delivered.
// v49 (operator, 2026-11-26, with two POPs of RAYA, one off a flat base with almost no volume and
// one at the end of a slow climb: "the rvol for that moment should be very high … I think we should
// focus on only such moves"): the script's volume test. Every POP and BACK carries `| vol 212.4x`
// (`vol_x`: the largest volume among the POP candle and the two candles before it ÷ the average of
// the 20 candles before those three; a BACK carries its POP's). It is not the PULLBACK's or the
// CROSS's `vol` (one candle against the 20 before it), though it is read the same way. A POP under
// the script's minimum (10) carries `| weak`, and so does the BACK after it: a weak one is stored
// and never announced, whatever its ⚙ switch, the Momentum rule and the cap say (the way a weak EMA
// cross is quiet). The script gives a weak one no number: its `pop N` / `back N` is the count so far
// (it can be 0). A weak POP takes nothing from a later strong one.
// Weak is the script's word alone (`| weak`): the server holds no minimum and never judges `vol_x`.
// The script prints the reading to one decimal, so a 9.96 arrives as `| vol 10x | … | weak`.
// The setups judged on the candles of a basis's own timeframe and sent from the alert on that
// timeframe (1m) alone: no other timeframe's copy to merge, no VWAP line named. The TURN has no
// weak filter; the POP and the BACK have one since v49 (POP_STAGES).
export const BASIS_STAGES: ReadonlySet<TvStage> = new Set<TvStage>(['turn', 'pop', 'back']);
// The POP and its BACK (v48): the two steps of one setup, and since v49 the two basis stages a
// message may call weak.
export const POP_STAGES: ReadonlySet<TvStage> = new Set<TvStage>(['pop', 'back']);
// The stages whose message may carry `| weak`: the EMA family (v36 the filter, v37 the BOUNCE after
// a weak cross, v41 a band cross under the band's middle) and (v49) the POP and the BACK.
export const WEAK_STAGES: ReadonlySet<TvStage> = new Set<TvStage>([...EMA_STAGES, ...POP_STAGES]);
// The script called this one weak: it is stored and shown, never announced. A `weak` on any other
// stage (a TURN, a CROSS, a PULLBACK: none has a weak notion) means nothing.
export function isWeak(sig: { stage: TvStage; weak?: boolean }): boolean {
  return sig.weak === true && WEAK_STAGES.has(sig.stage);
}
// Which VWAP line(s) a message is about: session / month / year (v14). Lines
// that fired the same stage on one bar are named together in script order,
// e.g. "session+month". The legacy 'both' (v10–v13) meant session + month.
export type TvLineName = 'session' | 'month' | 'year';
export type TvLine = TvLineName | 'both' | 'session+month' | 'session+year' | 'month+year' | 'session+month+year';
const LINE_ORDER: TvLineName[] = ['session', 'month', 'year'];

// The individual lines of a message; a VB message without a line (v21) is the session line.
export function lineTokens(stage: TvStage, line: TvLine | null | undefined): TvLineName[] {
  if (!line) return VB_STAGES.has(stage) ? ['session'] : [];
  if (line === 'both') return ['session', 'month'];
  return line.split('+') as TvLineName[];
}

// v28: which bars the script built its VWAP lines from.
export type TvVwapSrc = '30s' | 'chart';

export interface TvSetupSignal {
  stage: TvStage;
  ticker: string;
  price: number | null;
  mvwap: number | null;
  px_pct: number | null;      // price vs mVWAP, % (negative = under the line)
  day_gain: number | null;    // day high vs the prior close, %
  ah_gain: number | null;     // after hours only (script v3+): high since today's close, %
  tf: string | null;          // TradingView interval: "1", "2", "30S", …
  vol_x: number | null;       // script v9+: signal bar volume ÷ average of the previous 20 bars (v49, a POP or a BACK: the POP's own reading, the largest of the POP candle and the two before it ÷ the average of the 20 before those three)
  run_pct: number | null;     // script v9+: close vs 10 bars earlier, %
  svwap?: number | null;      // session VWAP (anchor Session, 04:00 ET on an Extended chart)
  spx_pct?: number | null;    // price vs the session VWAP, %
  yvwap?: number | null;      // year VWAP (script v11; v14 from this year's hourly bars)
  ypx_pct?: number | null;    // price vs the year VWAP, %
  line?: TvLine | null;       // null on a v21 CROSS = the session line
  // PULLBACK setup (script v10)
  touch?: number | null;      // pullbacks to this line today, this one included
  fails?: number | null;      // script v16+, PULLBACK: failed pullbacks on the line before this one (null = older script, which capped itself)
  peak_pct?: number | null;   // PULLBACK: highest bar high above the line before it, %
  // VWAP + BB cross (script v21): svwap / upper are the candle timeframe's session
  // VWAP and the BB timeframe's upper band at the 30s close that crossed.
  upper?: number | null;      // the BB timeframe's upper band at the cross
  upper_pct?: number | null;  // price vs that band, %
  candle_tf?: string | null;  // the candle's timeframe: "5", "60", …
  bb_tf?: string | null;      // the band's timeframe: "2", "45S", …
  // v41, a band cross (emaByBand): the band's middle line at the cross and the price against it.
  // Under it, the band widened on a drop — the script calls such a cross weak (its bbMidOn input).
  bb_mid?: number | null;
  bb_mid_pct?: number | null;
  candle_open?: number | null; // the candle's open
  cross_n?: number | null;    // the day's crosses on this ticker, this one included
  // VB retest (script v28)
  stop?: number | null;       // RETEST: a tick under the pullback's low
  retest_n?: number | null;   // RETEST: the day's retests on this ticker, this one included
  vwap_src?: TvVwapSrc | null; // v28: the lines from 30s bars or the chart's bars; null = an older script (chart bars)
  // EMA cross (script v35): candle_tf = the EMA's timeframe, cross_n = the day's crosses on the line
  ema_len?: number | null;    // the EMA's length (9)
  ema?: number | null;        // its value at the candle's close
  late?: boolean;             // judged a bar late (the candle's closing bar had no trades)
  // v36, the script's filter: what it measured, and its verdict
  under_n?: number | null;    // candles in a row the EMA had been at or under the line before the cross
  flips_n?: number | null;    // EMA / line crossings in the 20 candles before
  weak?: boolean;             // the filter calls the cross weak → stored, not announced (v49: a POP that failed the volume test, and its BACK; isWeak)
  // EMA bounce (script v37): stop = a tick under the pullback's low, candle_tf / ema_len / ema as
  // the cross, weak = its cross was weak
  since_n?: number | null;    // candles after the cross candle
  bounce_n?: number | null;   // the day's bounces on the line, this one included (a weak one isn't counted)
  bounce_from?: TvBounceFrom | null;  // what the pullback came down to
  // TURN (script v47): candle_tf = the basis's timeframe, stop = a tick under the pullback's low,
  // since_n = candles after the close above the basis
  sma_len?: number | null;    // the basis's length (15)
  sma?: number | null;        // the basis (the SMA of its timeframe's closes) at the bounce
  sma_pct?: number | null;    // price vs the basis, %
  fall_pct?: number | null;   // how far the basis fell before its low, % (null = the script had no reading)
  turn_n?: number | null;     // the day's TURNs on this ticker, this one included
  macd_green?: boolean | null; // the MACD above its signal line at the bounce (null = the message doesn't say)
  // POP and BACK (script v48): candle_tf / sma_len / sma / sma_pct as the TURN's (the basis, its
  // timeframe, the price against it). A BACK also has stop (a tick under the pullback's low),
  // since_n (candles after the POP candle) and macd_green; a POP has none of the three.
  // v49: both carry vol_x (above), and `weak` when the POP failed the script's volume test.
  ran_pct?: number | null;    // the furthest a high of the run got above the basis so far, %
  pop_n?: number | null;      // POP: the day's POPs sent on this ticker, this one included (a weak one isn't counted: the count so far)
  back_n?: number | null;     // BACK: the day's BACKs sent on this ticker, this one included (a weak one isn't counted: the count so far)
}
export type TvBounceFrom = 'ema' | 'vwap' | 'ema+vwap';

export const TV_SETUP = {
  dup_sec: 120,           // same ticker + stage + timeframe again within 2 min = a re-delivery → dropped
  notify_merge_sec: 300,  // same event from another timeframe within 5 min → logged; one announcement per ticker + stage (PULLBACK: per line) per 5 min
  max_per_min: 120,       // flood guard: a leaked key or a runaway alert must not spam the phone
  // Noise cut (operator, 2026-10-05: "I hide broken, held … setups"). Quiet
  // stages are stored, graded and shown in the 📐 sidebar, but never announced:
  // no toast, sound, browser notification or Telegram. This is the DEFAULT;
  // since 2026-10-06 the live set is the ⚙ menu's stage switches
  // (app_settings 'tv_alert_stages', TvSetupGate.setAnnounced).
  quiet_stages: ['broken', 'held'] as readonly TvStage[],
  // The PULLBACK cap moved here from the script in v16 (2026-10-10): past
  // pb_cap failed pullbacks on a line (BROKEN or straight through, the
  // message's `fails`), a PULLBACK is quiet — unless the ticker is on our
  // Momentum list at grade pb_cap_exempt or better (operator's trial after
  // WFF 10-09 and BIYA 10-07; on the session line, capped touches averaged
  // −0.64%, the B+ ones +0.90% on n 17 in October). Grade ~10-24.
  pb_cap: 2,
  pb_cap_exempt: 'B+' as string,
  // VWAP + BB cross (script v21). The script sends one CROSS per candle from the
  // 30s alert alone, so there's no other timeframe's copy to merge and a cross on
  // the next candle is a real event: only a re-delivery inside this window drops.
  vb_dup_sec: 20,
  // Past this many crosses on a ticker in a day (the message's `cross N`), a CROSS
  // is stored and shown, not announced — a name chopping around VWAP crosses on
  // candle after candle. Untested: grade with the first live weeks.
  vb_cap: 3,
  // A CROSS is announced only for a ticker on our Momentum list, like GO
  // (operator, 2026-10-20: the first morning announced 20–25 an hour on the
  // session line alone, 4–5 of them on Momentum). Off-list crosses are quiet:
  // stored, graded and shown dimmed in the 📐 sidebar.
  vb_momentum_only: true,
  // …except a runner our 20-s screen hasn't caught yet (operator, 2026-10-21:
  // RBNE reached the screen at 04:00:34 ET and WHLR at 04:01:14, after the 30s bar
  // that crossed): a message saying the day high is at least this % still announces.
  // On 10-20 that would have added 18 off-list crosses on 11 tickers.
  vb_fresh_gain: 30,
  // (v29–v38 also let a VB on candles of 60 minutes or more announce off Momentum: the lanes for
  // longer trades, removed in v39 with `vb_long_min`.)
  // A v28 RETEST follows the same rules (its own ⚙ switch, Momentum or fresh, vb_cap on
  // its own `retest N`).
  // v35 EMA cross: past this many crosses on a line in a day (the message's `cross N`), an EMA
  // cross is stored and shown, not announced — an EMA weaving around VWAP. Untested.
  em_cap: 3,
  // 2026-11-15 (operator: "ema cross must be checked only with momentum list"; asked whether to
  // drop the fresh-runner exception for it: "yes, please, also, make it configurable if
  // possible"): an EMA cross, a band cross (v40) or a BOUNCE off our Momentum list is quiet
  // whatever its day high. This is the default of the ⚙ menu's "EMA / BAND / BOUNCE: Momentum
  // list only" (app_settings `tv_alert_rules`, TvSetupGate.setEmaMomentumOnly); switched off,
  // they follow the VB's rule again (a day high ≥ vb_fresh_gain still announces).
  // v47: a TURN follows the same rule and the same switch. v48: a POP and a BACK too.
  em_momentum_only: true,
  // v47 TURN: past this many TURNs on a ticker in a day (the message's `turn N`), a TURN is stored
  // and shown, not announced. Untested, like the other caps.
  tn_cap: 3,
  // v48 POP and BACK: past this many POPs on a ticker in a day (the message's `pop N`), a POP is
  // stored and shown, not announced; the same for a BACK on its own `back N`. (The study behind the
  // setup counted about 35 POPs a day on Momentum names, 28 with this cap, and about 10 BACKs.)
  // v49: a weak POP or BACK is quiet before the cap is looked at; the script gives it no number, so
  // it is never past the cap (pastCap).
  pp_cap: 3,
  // Priority (operator, 2026-10-04): a setup on a ticker that is on our Momentum
  // list right now is the one to act on — ⭐ and a normal (buzzing) Telegram push.
  // Off-list setups still go out, but as silent messages.
  offscreen_silent: true,
} as const;

// A message's head word (or a JSON body's `stage`) → its stage. The script heads the band's cross
// "EMA" (emaLineStage sorts it out); a JSON body may name `band` itself.
const STAGES: Record<string, TvStage> = {
  pullback: 'pullback', broken: 'broken', held: 'held', cross: 'cross', retest: 'retest', ema: 'ema',
  bounce: 'bounce', band: 'band', turn: 'turn', pop: 'pop', back: 'back',
};

// v16: a PULLBACK past the day's cap on every line it names. Older scripts
// (no `fails`) capped themselves, so they're never capped here.
// v21: a CROSS past the day's TV_SETUP.vb_cap crosses on its ticker. v35: an EMA cross past em_cap
// (v37: its BOUNCE on its own `bounce N`). v47: a TURN past tn_cap on its `turn N`. v48: a POP past
// pp_cap on its `pop N`, a BACK past it on its own `back N`.
// v49: a weak POP or BACK is never past the cap. The script gives it no number: the `pop N` /
// `back N` it carries is the day's count without it, so there is nothing of its own to hold against
// the cap, and its row and its alert are not `capped`. (The EMA family is as it was: a weak cross
// carries the count so far too, and is still read against em_cap.)
export function pastCap(sig: TvSetupSignal): boolean {
  if (LINE_CROSS_STAGES.has(sig.stage)) return sig.cross_n != null && sig.cross_n > TV_SETUP.em_cap;   // each line its own `cross N`
  if (sig.stage === 'bounce') return sig.bounce_n != null && sig.bounce_n > TV_SETUP.em_cap;
  if (sig.stage === 'turn') return sig.turn_n != null && sig.turn_n > TV_SETUP.tn_cap;
  if (sig.stage === 'pop') return sig.weak !== true && sig.pop_n != null && sig.pop_n > TV_SETUP.pp_cap;
  if (sig.stage === 'back') return sig.weak !== true && sig.back_n != null && sig.back_n > TV_SETUP.pp_cap;
  if (sig.stage === 'cross') return sig.cross_n != null && sig.cross_n > TV_SETUP.vb_cap;
  if (sig.stage === 'retest') return sig.retest_n != null && sig.retest_n > TV_SETUP.vb_cap;
  return sig.stage === 'pullback' && sig.fails != null && sig.fails >= TV_SETUP.pb_cap;
}

// The VWAP + BB cross's fields (CROSS v21; RETEST v28) for the alert's setup info and
// its tier_events row; none on other stages.
export function vbFields(sig: TvSetupSignal): {
  upper?: number | null; upper_pct?: number | null; candle_tf?: string | null; bb_tf?: string | null;
  candle_open?: number | null; cross_n?: number | null; stop?: number | null; retest_n?: number | null;
} {
  if (sig.stage === 'cross') {
    return {
      upper: sig.upper ?? null, upper_pct: sig.upper_pct ?? null, candle_tf: sig.candle_tf ?? null,
      bb_tf: sig.bb_tf ?? null, candle_open: sig.candle_open ?? null, cross_n: sig.cross_n ?? null,
    };
  }
  if (sig.stage === 'retest') {
    return { stop: sig.stop ?? null, candle_tf: sig.candle_tf ?? null, bb_tf: sig.bb_tf ?? null, retest_n: sig.retest_n ?? null };
  }
  return {};
}

// The v35 EMA cross's fields for the alert's setup info and its tier_events row; none on other stages.
export function emaFields(sig: TvSetupSignal): {
  candle_tf?: string | null; cross_n?: number | null; ema_len?: number | null; ema?: number | null; late?: boolean;
  under_n?: number | null; flips_n?: number | null; weak?: boolean;
  stop?: number | null; bounce_n?: number | null; since_n?: number | null; bounce_from?: TvBounceFrom | null;
  upper?: number | null; upper_pct?: number | null; bb_tf?: string | null; bb_mid?: number | null; bb_mid_pct?: number | null;
} {
  if (sig.stage === 'bounce') {
    return {
      candle_tf: sig.candle_tf ?? null, ema_len: sig.ema_len ?? null, ema: sig.ema ?? null, late: sig.late === true,
      weak: sig.weak === true, stop: sig.stop ?? null, bounce_n: sig.bounce_n ?? null, since_n: sig.since_n ?? null,
      bounce_from: sig.bounce_from ?? null,
    };
  }
  if (!LINE_CROSS_STAGES.has(sig.stage)) return {};
  return {
    candle_tf: sig.candle_tf ?? null, cross_n: sig.cross_n ?? null, ema_len: sig.ema_len ?? null, ema: sig.ema ?? null,
    late: sig.late === true,
    under_n: sig.under_n ?? null, flips_n: sig.flips_n ?? null, weak: sig.weak === true,
    // v40: the band that crossed, when it was the band
    ...(emaByBand(sig) ? {
      upper: sig.upper ?? null, upper_pct: sig.upper_pct ?? null, bb_tf: sig.bb_tf ?? null,
      bb_mid: sig.bb_mid ?? null, bb_mid_pct: sig.bb_mid_pct ?? null,   // v41
    } : {}),
  };
}

// The v47 TURN's fields for the alert's setup info and its tier_events row; none on other stages.
export function turnFields(sig: TvSetupSignal): {
  candle_tf?: string | null; stop?: number | null; since_n?: number | null;
  sma_len?: number | null; sma?: number | null; sma_pct?: number | null; fall_pct?: number | null;
  turn_n?: number | null; macd_green?: boolean | null;
} {
  if (sig.stage !== 'turn') return {};
  return {
    candle_tf: sig.candle_tf ?? null, stop: sig.stop ?? null, since_n: sig.since_n ?? null,
    sma_len: sig.sma_len ?? null, sma: sig.sma ?? null, sma_pct: sig.sma_pct ?? null, fall_pct: sig.fall_pct ?? null,
    turn_n: sig.turn_n ?? null, macd_green: sig.macd_green ?? null,
  };
}

// The v48 POP's and BACK's fields for the alert's setup info and its tier_events row; none on other
// stages. A POP is a heads-up: it has no stop, no `since` and no MACD reading, so its row has none.
// v49: both carry `weak` (the POP failed the script's volume test; false on a strong one and on a
// v48 message), the way an EMA cross's row does. The reading itself, `vol_x`, is one of the fields
// every stage's row and alert carry (the poller writes it beside these), so it is not repeated here.
export function popFields(sig: TvSetupSignal): {
  candle_tf?: string | null; sma_len?: number | null; sma?: number | null; sma_pct?: number | null;
  ran_pct?: number | null; pop_n?: number | null;
  stop?: number | null; since_n?: number | null; back_n?: number | null; macd_green?: boolean | null;
  weak?: boolean;
} {
  if (sig.stage === 'pop') {
    return {
      candle_tf: sig.candle_tf ?? null, sma_len: sig.sma_len ?? null, sma: sig.sma ?? null, sma_pct: sig.sma_pct ?? null,
      ran_pct: sig.ran_pct ?? null, pop_n: sig.pop_n ?? null, weak: sig.weak === true,
    };
  }
  if (sig.stage === 'back') {
    return {
      candle_tf: sig.candle_tf ?? null, stop: sig.stop ?? null, since_n: sig.since_n ?? null,
      sma_len: sig.sma_len ?? null, sma: sig.sma ?? null, sma_pct: sig.sma_pct ?? null,
      ran_pct: sig.ran_pct ?? null, back_n: sig.back_n ?? null, macd_green: sig.macd_green ?? null,
      weak: sig.weak === true,
    };
  }
  return {};
}

// A stored tv_setup row's stage-specific fields (what vbFields / emaFields / turnFields / popFields
// put in its meta) → the same fields for the alert's setup info, each kept only when the row has it. GET
// /api/screener/alerts builds a reloaded page's rows from this. Until 2026-11-16 that endpoint
// copied the VB's fields alone, so after a reload an EMA row lost its length ("1m/?") and a weak
// cross its `weak`. The fields of the stages removed 2026-11-22 (the RSI's, the DIP's, the MACD's,
// the basis's) are no longer copied: their rows aren't listed.
const STORED_NUM_FIELDS = ['upper', 'upper_pct', 'candle_open', 'cross_n', 'stop', 'retest_n',
  'since_n', 'ema_len', 'ema', 'under_n', 'flips_n', 'bounce_n', 'bb_mid', 'bb_mid_pct',
  'sma_len', 'sma', 'sma_pct', 'fall_pct', 'turn_n',   // these five: the TURN's (v47); the POP and the BACK share the three `sma` ones
  'ran_pct', 'pop_n', 'back_n'] as const;              // the POP's and the BACK's (v48)
const STORED_STR_FIELDS = ['candle_tf', 'bb_tf', 'bounce_from'] as const;
// `weak`: the EMA family's, and since v49 a POP's and a BACK's (popFields). Their `vol_x` is not
// here: GET /api/screener/alerts reads it for every stage, as it does a PULLBACK's and a CROSS's.
const STORED_BOOL_FIELDS = ['late', 'weak'] as const;
// A reading a message may leave out (the TURN's and the BACK's `green 1|0`): true / false as stored,
// null when the row has the field without a reading.
const STORED_FLAG_FIELDS = ['macd_green'] as const;
export function storedSetupFields(meta: Record<string, unknown>): Record<string, number | string | boolean | null> {
  const out: Record<string, number | string | boolean | null> = {};
  for (const k of STORED_NUM_FIELDS) {
    if (k in meta) out[k] = typeof meta[k] === 'number' && Number.isFinite(meta[k] as number) ? (meta[k] as number) : null;
  }
  for (const k of STORED_STR_FIELDS) if (k in meta) out[k] = typeof meta[k] === 'string' ? (meta[k] as string) : null;
  for (const k of STORED_BOOL_FIELDS) if (k in meta) out[k] = meta[k] === true;
  for (const k of STORED_FLAG_FIELDS) if (k in meta) out[k] = typeof meta[k] === 'boolean' ? (meta[k] as boolean) : null;
  return out;
}

// A stored row's stage as the dashboard should see it: a band cross stored as `ema` (rows of
// 2026-11-15 / 11-16, before it was a stage) reads `band`. A basis cross stored as `ema` on those
// days still reads `basis`, a removed stage: GET /api/screener/alerts leaves such a row out, so it
// can't come back as an EMA row. Every other stage reads as stored (`turn`, v48's `pop` and `back`).
export function storedStage(meta: Record<string, unknown>): string | null {
  const stage = typeof meta.stage === 'string' ? meta.stage : null;
  if (stage !== 'ema') return stage;
  return emaLineStage({
    stage: 'ema', ema: typeof meta.ema === 'number' ? meta.ema : null,
    bb_tf: typeof meta.bb_tf === 'string' ? meta.bb_tf : null, basis: typeof meta.basis === 'number' ? meta.basis : null,
  }) ?? 'basis';
}

const GRADE_LADDER = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C', 'D'];
// "B+" or better, by the Momentum grade ladder.
export function gradeAtLeast(grade: string | null | undefined, min: string): boolean {
  const g = grade == null ? -1 : GRADE_LADDER.indexOf(grade);
  return g >= 0 && g <= GRADE_LADDER.indexOf(min);
}

// Every stage, in the order the ⚙ menu lists them, and the stages announced
// until the operator changes the switches.
export const TV_STAGE_ORDER: readonly TvStage[] = ['pullback', 'cross', 'retest', 'ema', 'band', 'turn', 'pop', 'back', 'broken', 'held'];
export const DEFAULT_ANNOUNCED: readonly TvStage[] = TV_STAGE_ORDER.filter((s) => !TV_SETUP.quiet_stages.includes(s));

// A stored or posted stage list → known stages in menu order; null if it isn't a list.
// A stage v27, v28, v39 or v44 removed (forming / ready / go, level / break, lift, rsi / dip /
// macd / basis) is dropped.
export function parseStageList(v: unknown): TvStage[] | null {
  if (!Array.isArray(v)) return null;
  const wanted = new Set(v.filter((x): x is string => typeof x === 'string').map((x) => x.trim().toLowerCase()));
  return TV_STAGE_ORDER.filter((s) => wanted.has(s));
}

// A stage that got its own switch after riding another's starts with that switch's value, so a
// list saved before the split keeps announcing what it did: BAND, which rode the EMA's switch on
// 2026-11-15 / 11-16, starts with its value. A parent comes before its child in TV_STAGE_ORDER,
// so it is settled first. (DIP from RSI, MACD from DIP and BASIS from EMA went with their stages
// on 2026-11-22.) TURN (v47) is a new setup that rode no switch: a list saved before it gives it
// its default, on. The same for POP and BACK (v48): two new switches, each on for a list saved
// before v48 (BACK does not follow POP's switch: either can be on without the other).
const SPLIT_FROM: Partial<Record<TvStage, TvStage>> = { band: 'ema' };
// The menu's stages while the switches were stored as a plain array (before 2026-11-13), without
// the RSI cross it also had then (removed 2026-11-22).
const LEGACY_KNOWN: readonly TvStage[] = ['pullback', 'cross', 'retest', 'ema', 'broken', 'held'];

// The stored switches: `{ announced, known }`, `known` = the menu's stages when it was saved. A
// stage the list didn't know takes the switch it split from, or its default. A plain array (saved
// before 2026-11-13) knew LEGACY_KNOWN. A removed stage in either list is ignored: it switches
// nothing on or off. Null if the value is neither.
export function readStoredStages(v: unknown): TvStage[] | null {
  let list: unknown;
  let known: Set<string>;
  if (Array.isArray(v)) {
    list = v;
    known = new Set(LEGACY_KNOWN);
  } else if (v && typeof v === 'object' && Array.isArray((v as { announced?: unknown }).announced)
    && Array.isArray((v as { known?: unknown }).known)) {
    list = (v as { announced: unknown[] }).announced;
    known = new Set((v as { known: unknown[] }).known.filter((x): x is string => typeof x === 'string'));
  } else {
    return null;
  }
  const on = new Set(parseStageList(list) ?? []);
  for (const s of TV_STAGE_ORDER) {
    if (known.has(s)) continue;
    const from = SPLIT_FROM[s];
    if (from ? on.has(from) : DEFAULT_ANNOUNCED.includes(s)) on.add(s);
  }
  return TV_STAGE_ORDER.filter((s) => on.has(s));
}

// The ⚙ menu's alert rules beside the stage switches (app_settings `tv_alert_rules`), as stored →
// each rule's value, a missing or malformed one at its default.
export interface TvAlertRules {
  ema_momo_only: boolean;   // EMA / BAND / BOUNCE, (v47) TURN and (v48) POP / BACK announce on Momentum names only (TV_SETUP.em_momentum_only)
}
export function readStoredRules(v: unknown): TvAlertRules {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  return { ema_momo_only: typeof o.ema_momo_only === 'boolean' ? o.ema_momo_only : TV_SETUP.em_momentum_only };
}

// What PUT /api/tv/settings stores: the switches and the stages the menu had.
export function storedStages(stages: readonly TvStage[]): { announced: TvStage[]; known: TvStage[] } {
  return { announced: [...stages], known: [...TV_STAGE_ORDER] };
}

function toLine(v: unknown): TvLine | null {
  const p = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (p === 'both') return 'both';
  const parts = new Set(p.split('+').map((x) => x.trim()));
  const tokens = LINE_ORDER.filter((t) => parts.has(t));
  return tokens.length > 0 && tokens.length === parts.size ? (tokens.join('+') as TvLine) : null;
}

function toNum(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

// "NASDAQ:AIXI" / "aixi" → "AIXI"; anything that isn't a plausible US ticker → null.
export function normTicker(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().toUpperCase().replace(/^[A-Z_]+:/, '');
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(t) ? t : null;
}

// A message as the parser read it: the signal, and the basis an "EMA …" message may name in the
// EMA's place. The basis is not part of the signal: emaLineStage alone looks at it, to reject the
// removed basis cross.
type TvMessageAsSent = TvSetupSignal & { basis: number | null };

function fromJson(o: Record<string, unknown>): TvMessageAsSent | null {
  const stage = typeof o.stage === 'string' ? STAGES[o.stage.trim().toLowerCase()] : undefined;
  const ticker = normTicker(o.ticker);
  if (!stage || !ticker) return null;
  return {
    stage, ticker,
    price: toNum(o.price),
    mvwap: toNum(o.mvwap),
    px_pct: toNum(o.px_pct),
    day_gain: toNum(o.day_gain),
    ah_gain: toNum(o.ah_gain),
    tf: typeof o.tf === 'string' || typeof o.tf === 'number' ? String(o.tf) : null,
    vol_x: toNum(o.vol_x),
    run_pct: toNum(o.run_pct),
    svwap: toNum(o.svwap),
    spx_pct: toNum(o.spx_pct),
    yvwap: toNum(o.yvwap),
    ypx_pct: toNum(o.ypx_pct),
    line: toLine(o.line),
    touch: toNum(o.touch),
    peak_pct: toNum(o.peak_pct),
    fails: toNum(o.fails),
    upper: toNum(o.upper),
    upper_pct: toNum(o.upper_pct),
    candle_tf: toTf(o.candle_tf ?? o.candle),
    bb_tf: toTf(o.bb_tf ?? o.bb),
    bb_mid: toNum(o.bb_mid ?? o.mid),
    bb_mid_pct: toNum(o.bb_mid_pct),
    candle_open: toNum(o.candle_open ?? o.open),
    cross_n: toNum(o.cross_n ?? o.cross),
    stop: toNum(o.stop),
    retest_n: toNum(o.retest_n ?? o.retest),
    vwap_src: toVwapSrc(o.vwap_src ?? o.vwap),
    late: o.late === true,
    since_n: toNum(o.since_n ?? o.since),
    ema_len: toNum(o.ema_len),
    ema: toNum(o.ema),
    under_n: toNum(o.under_n ?? o.under),
    flips_n: toNum(o.flips_n ?? o.flips),
    weak: o.weak === true,
    bounce_n: toNum(o.bounce_n ?? o.bounce),
    bounce_from: toBounceFrom(o.bounce_from ?? o.from),
    sma_len: toNum(o.sma_len),
    sma: toNum(o.sma),
    sma_pct: toNum(o.sma_pct),
    fall_pct: toNum(o.fall_pct ?? o.fall),
    turn_n: toNum(o.turn_n ?? o.turn),
    macd_green: toFlag(o.macd_green ?? o.green),
    ran_pct: toNum(o.ran_pct ?? o.ran),
    pop_n: toNum(o.pop_n ?? o.pop),
    back_n: toNum(o.back_n ?? o.back),
    basis: toNum(o.basis),
  };
}

// A JSON body's yes / no reading: true / false, or the message's 1 / 0; anything else → null.
function toFlag(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  return v === 1 || v === '1' ? true : v === 0 || v === '0' ? false : null;
}

function toBounceFrom(v: unknown): TvBounceFrom | null {
  const p = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return p === 'ema' || p === 'vwap' || p === 'ema+vwap' ? p : null;
}

function toVwapSrc(v: unknown): TvVwapSrc | null {
  const p = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return p === '30s' || p === 'chart' ? p : null;
}

function toTf(v: unknown): string | null {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim().toUpperCase() : '';
  if (/^[DWM]$/.test(s)) return `1${s}`;   // a bare "D" is "1D"
  return /^[0-9]+[A-Z]?$/.test(s) ? s : null;
}

// A TradingView interval in minutes: "5" → 5, "240" → 240, "1D" → 1440, "30S" → 0.5; null if unknown.
export function tfMinutes(tf: string | null | undefined): number | null {
  const m = /^(\d+)([SDWM]?)$/i.exec(tf ?? '');
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toUpperCase();
  return unit === 'S' ? n / 60 : unit === 'D' ? n * 1440 : unit === 'W' ? n * 10080 : unit === 'M' ? n * 43200 : n;
}

// The Pine script's alert() message:
//   PULLBACK SAIQ 6.2 | sVWAP 6.16 (+0.7%) | mVWAP 4.1 (+51.2%) | line session | touch 2 | peak +17% | day high +336% | tf 1   (v10)
//   PULLBACK MI 5.31 | sVWAP 4.67 (+13.7%) | mVWAP 4.65 (+14.2%) | yVWAP 5.2 (+2.1%) | line year | touch 1 | peak +27% | tf 1   (v14)
//   PULLBACK WFF 3.53 | sVWAP 3.12 (+13.1%) | mVWAP 3.11 (+13.5%) | yVWAP 3.39 (+4.1%) | line year | touch 4 | fails 2 | peak +45% | tf 30S   (v16)
//   CROSS AIXI 2.61 | sVWAP 2.47 (+5.7%) | upper 2.58 (+1.2%) | open 2.5 | candle 5 | bb 2 | cross 1 | day high +25% | vol 1.8x | tf 30S   (v21)
//   CROSS AIXI 2.61 | sVWAP 2.47 (+5.7%) | mVWAP 2.55 (+2.4%) | yVWAP 3.1 (-15.8%) | upper 2.58 (+1.2%) | open 2.5 | line session+month | candle 5 | bb 2 | cross 1 | … | tf 30S   (v22)
//   RETEST AIOK 17.28 | stop 17.09 | sVWAP 17.1 (+1.1%) | mVWAP 14.2 (+21.7%) | line session | candle 5 | bb 45S | retest 1 | day high +46% | vwap 30s | tf 30S   (v28)
//   EMA OMH 8.09 | sVWAP 8.01 (+1.0%) | mVWAP 7.5 (+7.9%) | ema 9 8.03 | line session | candle 3 | cross 1 | day high +25% | vwap 30s | tf 30S   (v35; `ema` its length and value, `candle` its timeframe)
//   EMA OMH 8.09 | sVWAP 8.01 (+1.0%) | ema 9 8.03 | line session | candle 3 | cross 0 | under 3 | flips 4 | weak | day high +25% | vwap 30s | tf 30S   (v36; the filter's readings, `| weak` when it calls the cross weak)
//   BOUNCE PARA 0.1021 | stop 0.0985 | sVWAP 0.0975 (+4.7%) | ema 9 0.099 | line session | from ema+vwap | candle 3 | bounce 1 | since 3 | day high +25% | vwap 30s | tf 30S   (v37; `from` what the pullback came down to, `since` candles after the cross, `| weak` after a weak cross)
//   TURN NIVF 0.0213 | stop 0.0206 | sVWAP 0.0211 (+0.9%) | mVWAP 0.023 (-7.4%) | sma 15 0.0207 (+2.9%) | fall 12.3% | candle 1 | turn 1 | since 3 | green 1 | day high +25% | vwap 30s | tf 1   (v47; `sma` the basis's length, value and the price against it, `fall` how far it fell before its low (may be missing), `candle` its timeframe, `since` candles after the close above it, `green` the MACD above its signal: 1 / 0)
//   POP SVRE 1.85 | sVWAP 1.62 (+14.2%) | mVWAP 1.4 (+32.1%) | sma 15 1.66 (+11.4%) | ran 12.6% | candle 1 | pop 1 | day high +38% | vwap 30s | tf 1   (v48; `sma` as the TURN's, `ran` the furthest a high of the run got above the basis so far, `pop` the day's POPs sent on the ticker; no stop)
//   BACK SVRE 1.92 | stop 1.84 | sVWAP 1.7 (+12.9%) | mVWAP 1.41 (+36.2%) | sma 15 1.88 (+2.1%) | ran 18.4% | candle 1 | back 1 | since 6 | green 1 | day high +45% | vwap 30s | tf 1   (v48; `stop` a tick under the pullback's low, `back` the day's BACKs sent on the ticker, `since` candles after the POP candle, `green` as the TURN's)
//   POP RAYA 0.58 | sVWAP 0.47 (+23.4%) | sma 15 0.46 (+26.1%) | ran 31.5% | vol 212.4x | candle 1 | pop 1 | day high +29% | vwap 30s | tf 1   (v49; `vol` after `ran`: the largest volume among the POP candle and the two before it ÷ the average of the 20 candles before those three, read into vol_x like a PULLBACK's; left out when the script has no reading)
//   POP RAYA 0.73 | sVWAP 0.71 (+2.8%) | sma 15 0.68 (+7.4%) | ran 10.5% | vol 6.2x | candle 1 | pop 1 | weak | day high +120% | vwap 30s | tf 1   (v49; `| weak` after `pop N`: the POP failed the volume test, and `pop N` is the count so far, this one not in it; the flag is the script's, never read off `vol`)
//   BACK RAYA 0.91 | stop 0.82 | sVWAP 0.88 (+3.4%) | sma 15 0.9 (+1.1%) | ran 150.2% | vol 212.4x | candle 1 | back 1 | since 11 | green 1 | day high +156% | vwap 30s | tf 1   (v49; `vol` is its POP's reading; `| weak` after `green N` when that POP was weak)
// (v28 adds `vwap 30s|chart` to every message.)
// (a negative day high is written "-2%"; scripts before v3 wrote "+-2%"), or a JSON
// object with the TvSetupSignal field names. Express hands us the raw text for
// text/plain bodies and an already-parsed object for JSON ones.
// No longer read since 2026-11-22 (script v44), like v38's LIFT before them: "RSI …", "DIP …" and
// "MACD …" messages, and an "EMA …" message with `| basis …` in the EMA's place. Each returns null
// here, so the webhook answers 400 and nothing is stored or announced.
export function parseTvMessage(body: unknown): TvSetupSignal | null {
  const sent = parseTvMessageAsSent(body);
  if (!sent) return null;
  const { basis, ...sig } = sent;
  // 2026-11-16: an "EMA …" message about the band is stage `band`. One about the basis has no stage.
  const stage = emaLineStage({ ...sig, basis });
  return stage ? { ...sig, stage } : null;
}

function parseTvMessageAsSent(body: unknown): TvMessageAsSent | null {
  if (body && typeof body === 'object' && !Array.isArray(body)) return fromJson(body as Record<string, unknown>);
  if (typeof body !== 'string') return null;
  const text = body.replace(/−/g, '-').trim();
  if (text.startsWith('{')) {
    try {
      const o = JSON.parse(text) as unknown;
      return o && typeof o === 'object' && !Array.isArray(o) ? fromJson(o as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  // The head word is the message's first word, whole: "PULLBACK …" is not a BACK, "POPULAR …" not a POP.
  const head = /^(PULLBACK|BROKEN|HELD|CROSS|RETEST|EMA|BOUNCE|TURN|POP|BACK)\s+([A-Za-z0-9_.:-]+)(?:\s+\$?(\d*\.?\d+))?/i.exec(text);
  if (!head) return null;
  const ticker = normTicker(head[2]);
  if (!ticker) return null;
  const line = (label: string) => new RegExp(`${label}\\s+\\$?(\\d*\\.?\\d+)\\s*\\(\\s*([-+]?\\d*\\.?\\d+)\\s*%\\s*\\)`, 'i').exec(text);
  const mv = line('mVWAP');
  const sv = line('sVWAP');
  const yv = line('yVWAP');
  const up = line('upper');
  const day = /day\s+high\s+\+?(-?\d*\.?\d+)\s*%/i.exec(text);   // v1/v2 wrote "+-2%" for a negative day
  const ah = /\bah\s+\+?(-?\d*\.?\d+)\s*%/i.exec(text);
  const tf = /\btf\s+([0-9A-Za-z]+)/i.exec(text);
  const vol = /\bvol\s+(\d*\.?\d+)\s*x\b/i.exec(text);
  const run = /\brun\s+\+?(-?\d*\.?\d+)\s*%/i.exec(text);
  const ln = /\bline\s+((?:session|month|year)(?:\+(?:session|month|year)){0,2}|both)\b/i.exec(text);
  const touch = /\btouch\s+(\d+)\b/i.exec(text);
  const fails = /\bfails\s+(\d+)\b/i.exec(text);
  const peak = /\bpeak\s+\+?(-?\d*\.?\d+)\s*%/i.exec(text);
  const stop = /\bstop\s+\$?(\d*\.?\d+)/i.exec(text);
  // v21 fields, read after a "|" so a ticker can't pass for one (BB, OPEN).
  const candle = /\|\s*candle\s+([0-9]+[A-Za-z]?|[DWM])\b/i.exec(text);
  const bbTf = /\|\s*bb\s+([0-9]+[A-Za-z]?|[DWM])\b/i.exec(text);
  // v41, a band cross: "| mid 8.05 (+0.5%)" — the band's middle line and the price against it
  const bbMid = /\|\s*mid\s+\$?(\d*\.?\d+)\s*\(\s*([-+]?\d*\.?\d+)\s*%\s*\)/i.exec(text);
  // v42's basis cross: "| basis 8.03 (+0.7%) | bb 45S | len 10" in the place of "| ema 9 8.03".
  // Read only so that parseTvMessage can reject the message (removed 2026-11-22): without it, the
  // `| bb` would make it a band cross.
  const bsLine = /\|\s*basis\s+\$?(\d*\.?\d+)/i.exec(text);
  const open = /\|\s*open\s+\$?(\d*\.?\d+)/i.exec(text);
  const crossN = /\|\s*cross\s+(\d+)\b/i.exec(text);
  const retestN = /\|\s*retest\s+(\d+)\b/i.exec(text);   // v28
  const vwapSrc = /\|\s*vwap\s+(30s|chart)\b/i.exec(text);
  const sinceN = /\|\s*since\s+(\d+)\b/i.exec(text);   // v37
  const ema = /\|\s*ema\s+(\d+)\s+\$?(\d*\.?\d+)/i.exec(text);   // v35: "| ema 9 8.03"
  const underN = /\|\s*under\s+(\d+)\b/i.exec(text);   // v36
  const flipsN = /\|\s*flips\s+(\d+)\b/i.exec(text);
  const bounceN = /\|\s*bounce\s+(\d+)\b/i.exec(text);   // v37
  const bounceFrom = /\|\s*from\s+(ema\+vwap|ema|vwap)\b/i.exec(text);
  // v47 TURN: "| sma 15 0.0207 (+2.9%)" — the basis's length, its value and the price against it;
  // "| fall 12.3%", "| turn 1", "| green 1"
  const sma = /\|\s*sma\s+(\d+)\s+\$?(\d*\.?\d+)(?:\s*\(\s*([-+]?\d*\.?\d+)\s*%\s*\))?/i.exec(text);
  const fall = /\|\s*fall\s+([-+]?\d*\.?\d+)\s*%/i.exec(text);
  const turnN = /\|\s*turn\s+(\d+)\b/i.exec(text);
  const green = /\|\s*green\s+([01])\b/i.exec(text);
  // v48 POP / BACK: "| ran 12.6%", "| pop 1", "| back 1" — read after a "|" like the rest, so the
  // tickers POP, BACK and RAN are not read as one, nor a PULLBACK's head word as `back`.
  const ran = /\|\s*ran\s+([-+]?\d*\.?\d+)\s*%/i.exec(text);
  const popN = /\|\s*pop\s+(\d+)\b/i.exec(text);
  const backN = /\|\s*back\s+(\d+)\b/i.exec(text);
  return {
    stage: STAGES[head[1].toLowerCase()],
    ticker,
    price: toNum(head[3]),
    mvwap: toNum(mv?.[1]),
    px_pct: toNum(mv?.[2]),
    day_gain: toNum(day?.[1]),
    ah_gain: toNum(ah?.[1]),
    tf: tf?.[1] ?? null,
    vol_x: toNum(vol?.[1]),
    run_pct: toNum(run?.[1]),
    svwap: toNum(sv?.[1]),
    spx_pct: toNum(sv?.[2]),
    yvwap: toNum(yv?.[1]),
    ypx_pct: toNum(yv?.[2]),
    line: toLine(ln?.[1]),
    touch: toNum(touch?.[1]),
    peak_pct: toNum(peak?.[1]),
    fails: toNum(fails?.[1]),
    upper: toNum(up?.[1]),
    upper_pct: toNum(up?.[2]),
    candle_tf: toTf(candle?.[1]),
    bb_tf: toTf(bbTf?.[1]),
    bb_mid: toNum(bbMid?.[1]),
    bb_mid_pct: toNum(bbMid?.[2]),
    candle_open: toNum(open?.[1]),
    cross_n: toNum(crossN?.[1]),
    stop: toNum(stop?.[1]),
    retest_n: toNum(retestN?.[1]),
    vwap_src: toVwapSrc(vwapSrc?.[1]),
    late: /\|\s*late\b/i.test(text),
    since_n: toNum(sinceN?.[1]),
    ema_len: toNum(ema?.[1]),
    ema: toNum(ema?.[2]),
    under_n: toNum(underN?.[1]),
    flips_n: toNum(flipsN?.[1]),
    weak: /\|\s*weak\b/i.test(text),
    bounce_n: toNum(bounceN?.[1]),
    bounce_from: toBounceFrom(bounceFrom?.[1]),
    sma_len: toNum(sma?.[1]),
    sma: toNum(sma?.[2]),
    sma_pct: toNum(sma?.[3]),
    fall_pct: toNum(fall?.[1]),
    turn_n: toNum(turnN?.[1]),
    macd_green: green ? green[1] === '1' : null,
    ran_pct: toNum(ran?.[1]),
    pop_n: toNum(popN?.[1]),
    back_n: toNum(backN?.[1]),
    basis: toNum(bsLine?.[1]),
  };
}

// Duplicate + flood gate, and which signals get announced. TradingView can
// deliver the same alert twice, and the watchlist alert runs on two timeframes
// (1m and 30s), so one event arrives twice: the first copy counts, the second
// is only logged. A first copy is then 'quiet' (stored and shown in the 📐
// sidebar, not announced) for a stage switched off in the ⚙ menu, a PULLBACK
// past the cap, or a CROSS / RETEST off our Momentum list, else announced — a
// PULLBACK at most once per ticker and line per 5 min; the rest are logged.
// (The VB's stages, the EMA family, the TURN and (v48) the POP and the BACK each come from one alert only: no copy to log.)
export type TvVerdict = 'notify' | 'quiet' | 'log' | 'drop' | 'flood';

export class TvSetupGate {
  private lastExact = new Map<string, number>();   // ticker|stage|tf|line → epoch sec
  private lastEvent = new Map<string, number>();   // ticker|stage|line → epoch sec of the event's first copy
  private lastNotify = new Map<string, number>();  // ticker|stage (PULLBACK: ticker|pullback|line) → last announcement
  private announced = new Set<TvStage>(DEFAULT_ANNOUNCED);  // the ⚙ stage switches
  private emaMomoOnly: boolean = TV_SETUP.em_momentum_only;  // the ⚙ rule: EMA / BAND / BOUNCE, (v47) TURN and (v48) POP / BACK on Momentum names only
  private recent: number[] = [];

  // The ⚙ menu's "EMA / BAND / BOUNCE: Momentum list only". Off = a day high ≥ vb_fresh_gain
  // announces off the list too, as for a CROSS. v47: a TURN follows it too. v48: a POP and a BACK too.
  setEmaMomentumOnly(on: boolean): void {
    this.emaMomoOnly = on;
  }

  emaMomentumOnly(): boolean {
    return this.emaMomoOnly;
  }

  setAnnounced(stages: readonly TvStage[]): void {
    this.announced = new Set(stages);
  }

  announcedStages(): TvStage[] {
    return TV_STAGE_ORDER.filter((s) => this.announced.has(s));
  }

  announces(stage: TvStage): boolean {
    return this.announced.has(stageSwitch(stage));
  }

  // `capExempt`: a PULLBACK past the cap may still announce (v16 — the caller
  // knows the ticker's Momentum row and grade). `onMomentum`: the ticker is on
  // our Momentum list now; off it, a CROSS or RETEST is quiet (vb_momentum_only)
  // unless its day high is ≥ vb_fresh_gain %. An EMA cross, a band cross, a BOUNCE,
  // a TURN, a POP or a BACK off the list is quiet whatever its day high, unless the ⚙ rule is off.
  admit(sig: TvSetupSignal, nowSec: number, capExempt = false, onMomentum = true): TvVerdict {
    this.recent = this.recent.filter((t) => nowSec - t < 60);
    if (this.recent.length >= TV_SETUP.max_per_min) return 'flood';
    this.recent.push(nowSec);
    for (const m of [this.lastExact, this.lastEvent, this.lastNotify]) {
      for (const [k, t] of m) if (nowSec - t > 600) m.delete(k);
    }

    // The line is part of the exact key: a PULLBACK on the month line two
    // minutes after one on the session line is a second event, not a re-delivery.
    const vb = VB_STAGES.has(sig.stage);
    // The candle timeframe is part of a VB event's key (a changed VB candle is another event), and
    // of an EMA cross's, a band cross's or a BOUNCE's: the timeframe it is judged at.
    const ema = EMA_STAGES.has(sig.stage);   // the EMA cross, (v37) its bounce, and the band's cross
    // v47: a TURN's key carries its basis's timeframe the same way (the candles it is judged on).
    // v48: a POP's and a BACK's too. The stage is in the key, so a ticker's POP and its BACK never
    // pass for each other's re-delivery, and a TURN and a BACK on one candle are two events.
    const basis = BASIS_STAGES.has(sig.stage);   // the TURN, the POP, the BACK
    // v49: a POP the script's volume test calls weak, or the BACK after one. It has a key of its own
    // (`|weak`), so a weak one and a strong one of the same ticker and stage are never each other's
    // re-delivery: a weak POP can't drop the strong POP of a later run. (A TURN's key is as it was.)
    const weakPop = POP_STAGES.has(sig.stage) && sig.weak === true;
    // v40: a band cross and an EMA cross of one candle are two events (`|bb`).
    const exact = `${sig.ticker}|${sig.stage}|${sig.tf ?? ''}|${sig.line ?? ''}${vb || ema || basis ? `|${sig.candle_tf ?? ''}` : ''}${weakPop ? '|weak' : ''}`;   // the stage tells an EMA and a band cross of one candle apart
    const prev = this.lastExact.get(exact);
    const dupSec = vb || ema || basis ? TV_SETUP.vb_dup_sec : TV_SETUP.dup_sec;
    if (prev != null && nowSec - prev < dupSec) return 'drop';
    this.lastExact.set(exact, nowSec);
    // v47 TURN: one per bounce from the alert on the basis's timeframe alone, so a later one is a
    // new event (no copy to merge, no 5-min spacing). Limited by its own ⚙ switch, the day's cap
    // on `turn N`, and Momentum names only — the EMA family's ⚙ rule: switched off, a day high
    // ≥ vb_fresh_gain announces off the list too. It has no weak filter.
    // v48 POP and BACK: the same, each on its own switch and its own day's number (`pop N`,
    // `back N` against pp_cap). A BACK is judged on its own: whether its POP was announced, quiet
    // or never sent plays no part.
    // v49: a weak POP and a weak BACK (the message's own `| weak`) are quiet, whatever the switch,
    // the list and the cap say. The gate keeps nothing about them, so the next strong one is
    // judged as if they had not come. A TURN has no weak notion: a `weak` in its message changes nothing.
    if (basis) {
      const fresh = !this.emaMomoOnly && sig.day_gain != null && sig.day_gain >= TV_SETUP.vb_fresh_gain;
      const quiet = !this.announced.has(sig.stage) || weakPop || pastCap(sig)
        || (TV_SETUP.vb_momentum_only && !onMomentum && !fresh);
      return quiet ? 'quiet' : 'notify';
    }
    // v35 EMA cross: one per candle and line from the 30s alert alone, limited like a CROSS —
    // its ⚙ switch, the day's cap, and Momentum names only (or a day high ≥ vb_fresh_gain).
    // v36: a cross the script's filter calls weak is quiet. v37: its BOUNCE follows the same rules
    // (the EMA's switch, the cap on its own `bounce N`, weak after a weak cross).
    // 2026-11-15: Momentum names only by default — the fresh-runner exception is a ⚙ rule now.
    if (ema) {
      const fresh = !this.emaMomoOnly && sig.day_gain != null && sig.day_gain >= TV_SETUP.vb_fresh_gain;
      // each line its own ⚙ switch since 2026-11-16 (EMA, BAND); the BOUNCE rides the EMA's
      const quiet = !this.announced.has(stageSwitch(sig.stage)) || sig.weak === true || pastCap(sig)
        || (TV_SETUP.vb_momentum_only && !onMomentum && !fresh);
      return quiet ? 'quiet' : 'notify';
    }
    // v21 CROSS and v28 RETEST: one per candle / VB candle from the 30s alert alone — no
    // copy to merge, and no 5-min spacing (the next one is a new event); the cap and
    // the Momentum-only rule limit them.
    if (vb) {
      const fresh = sig.day_gain != null && sig.day_gain >= TV_SETUP.vb_fresh_gain;
      const quiet = !this.announced.has(sig.stage) || (pastCap(sig) && !capExempt)
        || (TV_SETUP.vb_momentum_only && !onMomentum && !fresh);
      return quiet ? 'quiet' : 'notify';
    }

    const tokens = lineTokens(sig.stage, sig.line);
    const event = `${sig.ticker}|${sig.stage}|${tokens.join('+')}`;
    const first = this.lastEvent.get(event);
    if (first != null && nowSec - first < TV_SETUP.notify_merge_sec) return 'log';
    this.lastEvent.set(event, nowSec);

    if (!this.announced.has(sig.stage)) return 'quiet';
    if (pastCap(sig) && !capExempt) return 'quiet';

    // One announcement per ticker + stage per 5 min. A quiet event doesn't use
    // up the slot. PULLBACK counts per line (operator, 2026-10-05):
    // each line is its own level and setup — MI's 15:21 session pullback,
    // +10% two minutes later, was only logged because a year-line PULLBACK
    // had pinged 3½ min earlier. A line already announced in another
    // combination (session+month, then session) is the same level → logged.
    const keys = sig.stage === 'pullback' && tokens.length > 0
      ? tokens.map((t) => `${sig.ticker}|pullback|${t}`)
      : [`${sig.ticker}|${sig.stage}`];
    const announcedLately = (k: string) => {
      const t = this.lastNotify.get(k);
      return t != null && nowSec - t < TV_SETUP.notify_merge_sec;
    };
    if (keys.some(announcedLately)) return 'log';
    for (const k of keys) this.lastNotify.set(k, nowSec);
    return 'notify';
  }
}

export const TV_STAGE_LABEL: Record<TvStage, string> = {
  pullback: 'PULLBACK', broken: 'BROKEN', held: 'HELD', cross: 'CROSS', retest: 'RETEST', ema: 'EMA',
  bounce: 'BOUNCE', band: 'BAND', turn: 'TURN', pop: 'POP', back: 'BACK',
};
// The band's (v40) label, as the checks have named it.
export const EMA_BAND_LABEL = TV_STAGE_LABEL.band;
const STAGE_ICON: Record<TvStage, string> = {
  pullback: '↩️', broken: '✖️', held: '✅', cross: '⏫', retest: '🔁', ema: '〽️', bounce: '🏀',
  band: '〽️',   // the EMA cross's sign: the same setup with another line
  turn: '⤴️',
  pop: '💥', back: '🎯',   // v48: the heads-up and its entry
};
const STAGE_HINT: Record<TvStage, string> = {
  pullback: 'back near VWAP after the run — be ready',
  broken: 'closed under VWAP — setup broken',
  held: 'held — ran +10% from the pullback',
  cross: 'the candle crossed over the session VWAP and the BB upper band',
  retest: 'back at the VWAP line after the VB candle, and bounced',
  ema: 'the EMA crossed above the VWAP line',
  bounce: 'after the EMA cross, price pulled back and bounced',
  band: 'the BB upper band crossed above the VWAP line',
  turn: 'after its basis fell and turned up, price closed above it, came back to it and bounced',
  pop: 'a pop: the run\'s high got well above its basis — a heads-up, no entry (the entry is the BACK)',
  back: 'the first pullback after the pop: price came back to its basis and bounced — the entry',
};
// A TradingView interval, short: "5" → "5m", "60" → "1h", "30S" → "30s".
export function fmtTf(tf: string | null | undefined): string {
  if (!tf) return '?';
  if (/^\d+$/.test(tf)) {
    const n = Number(tf);
    return n >= 60 && n % 60 === 0 ? `${n / 60}h` : `${n}m`;
  }
  return /^\d+S$/i.test(tf) ? tf.toLowerCase() : tf;
}
// The line(s) a message is about, in words: "session + month VWAP".
function lineName(sig: TvSetupSignal): string {
  const tokens = lineTokens(sig.stage, sig.line);
  return `${(tokens.length > 0 ? tokens : ['session']).join(' + ')} VWAP`;
}

// "touch 1 (first)" — the operator rates the first pullback after the first big move highest.
export function touchText(touch: number | null | undefined): string {
  return touch == null ? '' : `touch ${touch}${touch === 1 ? ' (first)' : ''}`;
}

function fmtPx(p: number | null): string {
  return p == null ? '' : `$${p < 1 ? p.toFixed(4) : p.toFixed(2)}`;
}
function fmtSigned(p: number | null): string {
  return p == null ? '?' : `${p > 0 ? '+' : ''}${p.toFixed(1)}%`;
}

// Telegram message. `tvSym` is the exchange-qualified chart symbol (edgar.tvSymbol)
// and `row` the Momentum row when the ticker is on our screen right now — those
// get ⭐ and an "on Momentum" line (they are the priority signals).
export function formatTvSetupAlert(
  sig: TvSetupSignal,
  tvSym: string,
  row: { change_pct: number | null; grade: string | null; float_m: number | null } | null,
): string {
  if (sig.stage === 'cross') return formatCross(sig, tvSym, row);
  if (sig.stage === 'retest') return formatRetest(sig, tvSym, row);
  if (LINE_CROSS_STAGES.has(sig.stage)) return formatEma(sig, tvSym, row);   // the EMA's, the band's
  if (sig.stage === 'bounce') return formatBounce(sig, tvSym, row);
  if (sig.stage === 'turn') return formatTurn(sig, tvSym, row);
  if (sig.stage === 'pop') return formatPop(sig, tvSym, row);
  if (sig.stage === 'back') return formatBack(sig, tvSym, row);
  // PULLBACK / BROKEN / HELD. PULLBACK and BROKEN name the line: "back near the
  // session VWAP after the run — be ready".
  const tokens = lineTokens(sig.stage, sig.line);
  const hint = sig.line && sig.stage !== 'held' ? STAGE_HINT[sig.stage].replace('VWAP', `the ${lineName(sig)}`) : STAGE_HINT[sig.stage];
  const lines = [
    `${row ? '⭐ ' : ''}📐 ${STAGE_ICON[sig.stage]} <b>${TV_STAGE_LABEL[sig.stage]}</b>  <b>${escapeHtml(sig.ticker)}</b>  ${fmtPx(sig.price)}`.trimEnd(),
    `<i>${hint}</i>`,
  ];
  const what = [touchText(sig.touch)];
  if (sig.stage === 'pullback' && sig.fails != null && sig.fails > 0) {
    what.push(pastCap(sig) ? `${sig.fails} failed before — past the cap, sent for grade ${escapeHtml(row?.grade ?? '?')}` : `${sig.fails} failed before`);
  }
  if (sig.stage === 'pullback' && sig.peak_pct != null) what.push(`ran +${Math.round(sig.peak_pct)}% above the line first`);
  if (what.some(Boolean)) lines.push(what.filter(Boolean).join(' · '));
  // Levels: the setup's own line(s) first, then the others the message carries.
  const lvlOf: Record<TvLineName, string | null> = {
    session: sig.svwap != null ? `sVWAP ${fmtPx(sig.svwap)} (${fmtSigned(sig.spx_pct ?? null)})` : null,
    month: sig.mvwap != null ? `mVWAP ${fmtPx(sig.mvwap)} (${fmtSigned(sig.px_pct)})` : null,
    year: sig.yvwap != null ? `yVWAP ${fmtPx(sig.yvwap)} (${fmtSigned(sig.ypx_pct ?? null)})` : null,
  };
  const lvl: string[] = [...tokens, ...LINE_ORDER.filter((t) => !tokens.includes(t))]
    .map((t) => lvlOf[t]).filter((x): x is string => x != null);
  if (lvl.length > 0) lines.push(lvl.join(' · '));
  lines.push(momentumLine(row));
  const ctx = contextParts(sig);
  if (ctx.length > 0) lines.push(ctx.join(' · '));
  lines.push(linksLine(sig, tvSym));
  return lines.join('\n');
}

// v21 CROSS: "the 5m candle crossed over the session VWAP and the 2m BB upper band";
// v22 names the month / year line it crossed ("the session + month VWAP").
function formatCross(
  sig: TvSetupSignal,
  tvSym: string,
  row: { change_pct: number | null; grade: string | null; float_m: number | null } | null,
): string {
  const bb = fmtTf(sig.bb_tf);
  const tokens = lineTokens(sig.stage, sig.line);
  const lines = [
    `${row ? '⭐ ' : ''}📐 ${STAGE_ICON.cross} <b>${TV_STAGE_LABEL.cross}</b>  <b>${escapeHtml(sig.ticker)}</b>  ${fmtPx(sig.price)}`.trimEnd(),
    `<i>the ${fmtTf(sig.candle_tf)} candle crossed over the ${tokens.join(' + ')} VWAP and the ${bb} BB upper band</i>`,
  ];
  const what: string[] = [];
  if (sig.cross_n != null) {
    what.push(`cross ${sig.cross_n} today${sig.cross_n === 1 ? ' (first)' : ''}${pastCap(sig) ? ' — past the cap' : ''}`);
  }
  if (sig.candle_open != null) what.push(`opened ${fmtPx(sig.candle_open)}`);
  if (what.length > 0) lines.push(what.join(' · '));
  // Levels: the crossed line(s), the band, then the other lines the message carries.
  const lvlOf: Record<TvLineName, string | null> = {
    session: sig.svwap != null ? `sVWAP ${fmtPx(sig.svwap)} (${fmtSigned(sig.spx_pct ?? null)})` : null,
    month: sig.mvwap != null ? `mVWAP ${fmtPx(sig.mvwap)} (${fmtSigned(sig.px_pct)})` : null,
    year: sig.yvwap != null ? `yVWAP ${fmtPx(sig.yvwap)} (${fmtSigned(sig.ypx_pct ?? null)})` : null,
  };
  const lvl = tokens.map((t) => lvlOf[t]).filter((x): x is string => x != null);
  if (sig.upper != null) lvl.push(`${bb} BB upper ${fmtPx(sig.upper)} (${fmtSigned(sig.upper_pct ?? null)})`);
  lvl.push(...LINE_ORDER.filter((t) => !tokens.includes(t)).map((t) => lvlOf[t]).filter((x): x is string => x != null));
  if (lvl.length > 0) lines.push(lvl.join(' · '));
  lines.push(momentumLine(row));
  const ctx = contextParts(sig, sig.vol_x != null ? [`volume ${sig.vol_x.toFixed(1)}× its last 20 candles`] : []);
  if (ctx.length > 0) lines.push(ctx.join(' · '));
  lines.push(linksLine(sig, tvSym));
  return lines.join('\n');
}

// v28 RETEST: "back at the session VWAP after the 5m VB candle (45s BB) and bounced · stop $17.09
// (−1.1%, under the pullback low)".
function formatRetest(
  sig: TvSetupSignal,
  tvSym: string,
  row: { change_pct: number | null; grade: string | null; float_m: number | null } | null,
): string {
  const tokens = lineTokens(sig.stage, sig.line);
  const lines = [
    `${row ? '⭐ ' : ''}📐 ${STAGE_ICON[sig.stage]} <b>${TV_STAGE_LABEL[sig.stage]}</b>  <b>${escapeHtml(sig.ticker)}</b>  ${fmtPx(sig.price)}`.trimEnd(),
    `<i>back at the ${tokens.join(' + ')} VWAP after the ${fmtTf(sig.candle_tf)} VB candle (${fmtTf(sig.bb_tf)} BB) and bounced</i>`,
  ];
  const what: string[] = [];
  if (sig.stop != null) {
    const risk = sig.price != null && sig.price > 0 ? `${fmtSigned((sig.stop / sig.price - 1) * 100)}, ` : '';
    what.push(`stop ${fmtPx(sig.stop)} (${risk}under the pullback low)`);
  }
  if (sig.retest_n != null) {
    what.push(`retest ${sig.retest_n} today${sig.retest_n === 1 ? ' (first)' : ''}${pastCap(sig) ? ' — past the cap' : ''}`);
  }
  if (what.length > 0) lines.push(what.join(' · '));
  const lvlOf: Record<TvLineName, string | null> = {
    session: sig.svwap != null ? `sVWAP ${fmtPx(sig.svwap)} (${fmtSigned(sig.spx_pct ?? null)})` : null,
    month: sig.mvwap != null ? `mVWAP ${fmtPx(sig.mvwap)} (${fmtSigned(sig.px_pct)})` : null,
    year: sig.yvwap != null ? `yVWAP ${fmtPx(sig.yvwap)} (${fmtSigned(sig.ypx_pct ?? null)})` : null,
  };
  const lvl = [...tokens, ...LINE_ORDER.filter((t) => !tokens.includes(t))].map((t) => lvlOf[t]).filter((x): x is string => x != null);
  if (lvl.length > 0) lines.push(lvl.join(' · '));
  lines.push(momentumLine(row));
  const ctx = contextParts(sig);
  if (ctx.length > 0) lines.push(ctx.join(' · '));
  lines.push(linksLine(sig, tvSym));
  return lines.join('\n');
}

// v35 EMA cross: "the 3m EMA 9 crossed above the session VWAP (at the 3m close)".
function formatEma(
  sig: TvSetupSignal,
  tvSym: string,
  row: { change_pct: number | null; grade: string | null; float_m: number | null } | null,
): string {
  const tokens = lineTokens(sig.stage, sig.line);
  const tf = fmtTf(sig.candle_tf);
  // v40: the line that crossed — the EMA, or the BB upper band (headline "BAND")
  const band = emaByBand(sig);
  const crossed = band ? `the ${fmtTf(sig.bb_tf)} BB upper band` : `the ${tf} EMA ${sig.ema_len ?? '?'}`;
  const lines = [
    `${row ? '⭐ ' : ''}📐 ${STAGE_ICON.ema} <b>${band ? EMA_BAND_LABEL : TV_STAGE_LABEL.ema}</b>  <b>${escapeHtml(sig.ticker)}</b>  ${fmtPx(sig.price)}`.trimEnd(),
    `<i>${crossed} crossed above the ${(tokens.length > 0 ? tokens : ['session']).join(' + ')} VWAP (at the ${tf} close${sig.late ? ', a bar late' : ''})</i>`,
  ];
  const what: string[] = [];
  if (band) {
    if (sig.upper != null) what.push(`${fmtTf(sig.bb_tf)} BB upper ${fmtPx(sig.upper)} (${fmtSigned(sig.upper_pct ?? null)})`);
    // v41: the price against the band's middle line — under it, the band widened on a drop
    if (sig.bb_mid_pct != null) {
      what.push(sig.bb_mid_pct < 0
        ? `price ${fmtSigned(sig.bb_mid_pct)} under the band's middle (the band widened on a drop)`
        : `price ${fmtSigned(sig.bb_mid_pct)} over the band's middle`);
    }
  } else if (sig.ema != null) what.push(`EMA ${fmtPx(sig.ema)}`);
  if (sig.cross_n != null) {
    what.push(`cross ${sig.cross_n} today${sig.cross_n === 1 ? ' (first)' : ''}${pastCap(sig) ? ' — past the cap' : ''}`);
  }
  // v36: what the filter measured.
  if (sig.under_n != null) what.push(`${sig.under_n} candle${sig.under_n === 1 ? '' : 's'} under the line before`);
  if (sig.flips_n != null) what.push(`${sig.flips_n} crossing${sig.flips_n === 1 ? '' : 's'} in the 20 before`);
  if (sig.weak) what.push('filtered as weak');
  if (what.length > 0) lines.push(what.join(' · '));
  // Levels: the crossed line(s) first, then the others the message carries.
  const lvlOf: Record<TvLineName, string | null> = {
    session: sig.svwap != null ? `sVWAP ${fmtPx(sig.svwap)} (${fmtSigned(sig.spx_pct ?? null)})` : null,
    month: sig.mvwap != null ? `mVWAP ${fmtPx(sig.mvwap)} (${fmtSigned(sig.px_pct)})` : null,
    year: sig.yvwap != null ? `yVWAP ${fmtPx(sig.yvwap)} (${fmtSigned(sig.ypx_pct ?? null)})` : null,
  };
  const lvl = [...tokens, ...LINE_ORDER.filter((t) => !tokens.includes(t))].map((t) => lvlOf[t]).filter((x): x is string => x != null);
  if (lvl.length > 0) lines.push(lvl.join(' · '));
  lines.push(momentumLine(row));
  const ctx = contextParts(sig);
  if (ctx.length > 0) lines.push(ctx.join(' · '));
  lines.push(linksLine(sig, tvSym));
  return lines.join('\n');
}

// v37 BOUNCE: "after the 3m EMA 9 crossed above the session VWAP, price pulled back to the EMA and
// bounced (at the 3m close)", then the stop under the pullback's low.
function formatBounce(
  sig: TvSetupSignal,
  tvSym: string,
  row: { change_pct: number | null; grade: string | null; float_m: number | null } | null,
): string {
  const tokens = lineTokens(sig.stage, sig.line);
  const tf = fmtTf(sig.candle_tf);
  const to = sig.bounce_from === 'ema+vwap' ? 'the EMA and the VWAP' : sig.bounce_from === 'vwap' ? 'the VWAP' : 'the EMA';
  const lines = [
    `${row ? '⭐ ' : ''}📐 ${STAGE_ICON.bounce} <b>${TV_STAGE_LABEL.bounce}</b>  <b>${escapeHtml(sig.ticker)}</b>  ${fmtPx(sig.price)}`.trimEnd(),
    `<i>after the ${tf} EMA ${sig.ema_len ?? '?'} crossed above the ${(tokens.length > 0 ? tokens : ['session']).join(' + ')} VWAP, price pulled back to ${to} and bounced (at the ${tf} close${sig.late ? ', a bar late' : ''})</i>`,
  ];
  const what: string[] = [];
  if (sig.stop != null) {
    const risk = sig.price != null && sig.price > 0 ? `${fmtSigned((sig.stop / sig.price - 1) * 100)}, ` : '';
    what.push(`stop ${fmtPx(sig.stop)} (${risk}under the pullback's low)`);
  }
  if (sig.bounce_n != null) {
    what.push(`bounce ${sig.bounce_n} today${sig.bounce_n === 1 ? ' (first)' : ''}${pastCap(sig) ? ' — past the cap' : ''}`);
  }
  if (sig.since_n != null) what.push(`${sig.since_n} candle${sig.since_n === 1 ? '' : 's'} after the cross`);
  if (sig.weak) what.push('after a weak cross');
  if (what.length > 0) lines.push(what.join(' · '));
  const lvlOf: Record<TvLineName, string | null> = {
    session: sig.svwap != null ? `sVWAP ${fmtPx(sig.svwap)} (${fmtSigned(sig.spx_pct ?? null)})` : null,
    month: sig.mvwap != null ? `mVWAP ${fmtPx(sig.mvwap)} (${fmtSigned(sig.px_pct)})` : null,
    year: sig.yvwap != null ? `yVWAP ${fmtPx(sig.yvwap)} (${fmtSigned(sig.ypx_pct ?? null)})` : null,
  };
  const lvl = [...tokens, ...LINE_ORDER.filter((t) => !tokens.includes(t))].map((t) => lvlOf[t]).filter((x): x is string => x != null);
  if (sig.ema != null) lvl.unshift(`EMA ${fmtPx(sig.ema)}`);
  if (lvl.length > 0) lines.push(lvl.join(' · '));
  lines.push(momentumLine(row));
  const ctx = contextParts(sig);
  if (ctx.length > 0) lines.push(ctx.join(' · '));
  lines.push(linksLine(sig, tvSym));
  return lines.join('\n');
}

// v47 TURN: "after its 1m basis (SMA 15) fell 12.3% and turned up, price closed above it, came back
// to it and bounced (at the 1m close)", then the stop under the pullback's low, the basis and the
// VWAP lines the message carries (basisLevels).
function formatTurn(
  sig: TvSetupSignal,
  tvSym: string,
  row: { change_pct: number | null; grade: string | null; float_m: number | null } | null,
): string {
  const tf = fmtTf(sig.candle_tf);
  const fell = sig.fall_pct != null ? ` fell ${sig.fall_pct.toFixed(1)}% and` : '';
  const lines = [
    `${row ? '⭐ ' : ''}📐 ${STAGE_ICON.turn} <b>${TV_STAGE_LABEL.turn}</b>  <b>${escapeHtml(sig.ticker)}</b>  ${fmtPx(sig.price)}`.trimEnd(),
    `<i>after its ${tf} basis (SMA ${sig.sma_len ?? '?'})${fell} turned up, price closed above it, came back to it and bounced (at the ${tf} close)</i>`,
  ];
  const what: string[] = [];
  if (sig.stop != null) {
    const risk = sig.price != null && sig.price > 0 ? `${fmtSigned((sig.stop / sig.price - 1) * 100)}, ` : '';
    what.push(`stop ${fmtPx(sig.stop)} (${risk}under the pullback's low)`);
  }
  if (sig.turn_n != null) {
    what.push(`turn ${sig.turn_n} today${sig.turn_n === 1 ? ' (first)' : ''}${pastCap(sig) ? ' — past the cap' : ''}`);
  }
  if (sig.since_n != null) what.push(`${sig.since_n} candle${sig.since_n === 1 ? '' : 's'} after the close above the basis`);
  if (sig.macd_green != null) what.push(sig.macd_green ? 'MACD green' : 'MACD not green');
  if (what.length > 0) lines.push(what.join(' · '));
  const lvl = basisLevels(sig);
  if (lvl.length > 0) lines.push(lvl.join(' · '));
  lines.push(momentumLine(row));
  const ctx = contextParts(sig);
  if (ctx.length > 0) lines.push(ctx.join(' · '));
  lines.push(linksLine(sig, tvSym));
  return lines.join('\n');
}

// The basis and the VWAP lines a TURN, a POP or a BACK carries (none is about a VWAP line, so they
// come in script order): "basis $1.66 (+11.4%) · sVWAP $1.62 (+14.2%) · mVWAP $1.40 (+32.1%)".
function basisLevels(sig: TvSetupSignal): string[] {
  const lvl: string[] = [];
  if (sig.sma != null) lvl.push(`basis ${fmtPx(sig.sma)}${sig.sma_pct != null ? ` (${fmtSigned(sig.sma_pct)})` : ''}`);
  if (sig.svwap != null) lvl.push(`sVWAP ${fmtPx(sig.svwap)} (${fmtSigned(sig.spx_pct ?? null)})`);
  if (sig.mvwap != null) lvl.push(`mVWAP ${fmtPx(sig.mvwap)} (${fmtSigned(sig.px_pct)})`);
  if (sig.yvwap != null) lvl.push(`yVWAP ${fmtPx(sig.yvwap)} (${fmtSigned(sig.ypx_pct ?? null)})`);
  return lvl;
}

// v48 POP: "a pop: the run's high got 12.6% above its 1m basis (SMA 15) — a heads-up, no entry: the
// entry is the BACK, the first pullback to the basis", then the day's number, the basis and the
// VWAP lines. No stop: there is nothing to buy yet.
// v49: the day's number is followed by the POP's volume reading: "volume 212.4× the 20 candles before
// the pop". Not the CROSS's words ("its last 20 candles"): that is one candle against the 20 before
// it, this the largest of three against the 20 before them. A weak POP is never announced; if one is
// formatted, the line says it is not counted (its `pop N` is the day's count without it) and that it
// was filtered as weak for low volume.
function formatPop(
  sig: TvSetupSignal,
  tvSym: string,
  row: { change_pct: number | null; grade: string | null; float_m: number | null } | null,
): string {
  const tf = fmtTf(sig.candle_tf);
  const ran = sig.ran_pct != null ? `${sig.ran_pct.toFixed(1)}%` : 'well';
  const weak = isWeak(sig);
  const lines = [
    `${row ? '⭐ ' : ''}📐 ${STAGE_ICON.pop} <b>${TV_STAGE_LABEL.pop}</b>  <b>${escapeHtml(sig.ticker)}</b>  ${fmtPx(sig.price)}`.trimEnd(),
    `<i>a pop: the run's high got ${ran} above its ${tf} basis (SMA ${sig.sma_len ?? '?'}) — a heads-up, no entry: the entry is the BACK, the first pullback to the basis</i>`,
  ];
  const what: string[] = [];
  if (sig.pop_n != null) {
    what.push(weak ? `not counted (${sig.pop_n} POP${sig.pop_n === 1 ? '' : 's'} today so far)`
      : `pop ${sig.pop_n} today${sig.pop_n === 1 ? ' (first)' : ''}${pastCap(sig) ? ' — past the cap' : ''}`);
  }
  if (sig.vol_x != null) what.push(`volume ${sig.vol_x.toFixed(1)}× the 20 candles before the pop`);
  if (weak) what.push('filtered as weak for low volume');
  if (what.length > 0) lines.push(what.join(' · '));
  const lvl = basisLevels(sig);
  if (lvl.length > 0) lines.push(lvl.join(' · '));
  lines.push(momentumLine(row));
  const ctx = contextParts(sig);
  if (ctx.length > 0) lines.push(ctx.join(' · '));
  lines.push(linksLine(sig, tvSym));
  return lines.join('\n');
}

// v48 BACK: "the first pullback after the pop: price came back to its 1m basis (SMA 15) and bounced
// (at the 1m close) — the entry", then the stop under the pullback's low, the day's number, how far
// the run's high got above the basis, the candles after the POP candle and the MACD, then the basis
// and the VWAP lines.
// v49: after the run's high comes its POP's volume reading, named as the POP's ("its POP's volume
// 212.4× the 20 candles before it"). A weak BACK is never announced; if one is formatted, it is not
// counted (its `back N` is the day's count without it) and the line ends "after a POP filtered as
// weak for low volume".
function formatBack(
  sig: TvSetupSignal,
  tvSym: string,
  row: { change_pct: number | null; grade: string | null; float_m: number | null } | null,
): string {
  const tf = fmtTf(sig.candle_tf);
  const weak = isWeak(sig);
  const lines = [
    `${row ? '⭐ ' : ''}📐 ${STAGE_ICON.back} <b>${TV_STAGE_LABEL.back}</b>  <b>${escapeHtml(sig.ticker)}</b>  ${fmtPx(sig.price)}`.trimEnd(),
    `<i>the first pullback after the pop: price came back to its ${tf} basis (SMA ${sig.sma_len ?? '?'}) and bounced (at the ${tf} close) — the entry</i>`,
  ];
  const what: string[] = [];
  if (sig.stop != null) {
    const risk = sig.price != null && sig.price > 0 ? `${fmtSigned((sig.stop / sig.price - 1) * 100)}, ` : '';
    what.push(`stop ${fmtPx(sig.stop)} (${risk}under the pullback's low)`);
  }
  if (sig.back_n != null) {
    what.push(weak ? `not counted (${sig.back_n} BACK${sig.back_n === 1 ? '' : 's'} today so far)`
      : `back ${sig.back_n} today${sig.back_n === 1 ? ' (first)' : ''}${pastCap(sig) ? ' — past the cap' : ''}`);
  }
  if (sig.ran_pct != null) what.push(`the run's high got ${sig.ran_pct.toFixed(1)}% above the basis`);
  if (sig.vol_x != null) what.push(`its POP's volume ${sig.vol_x.toFixed(1)}× the 20 candles before it`);
  if (sig.since_n != null) what.push(`${sig.since_n} candle${sig.since_n === 1 ? '' : 's'} after the POP`);
  if (sig.macd_green != null) what.push(sig.macd_green ? 'MACD green' : 'MACD not green');
  if (weak) what.push('after a POP filtered as weak for low volume');
  if (what.length > 0) lines.push(what.join(' · '));
  const lvl = basisLevels(sig);
  if (lvl.length > 0) lines.push(lvl.join(' · '));
  lines.push(momentumLine(row));
  const ctx = contextParts(sig);
  if (ctx.length > 0) lines.push(ctx.join(' · '));
  lines.push(linksLine(sig, tvSym));
  return lines.join('\n');
}

function momentumLine(row: { change_pct: number | null; grade: string | null; float_m: number | null } | null): string {
  if (!row) return '<i>not on our Momentum list</i>';
  const mom = ['⭐ <b>on Momentum</b>'];
  if (row.grade) mom.push(`grade ${escapeHtml(row.grade)}`);
  if (row.change_pct != null) mom.push(`now ${fmtSigned(row.change_pct)}`);
  if (row.float_m != null) mom.push(`float ${row.float_m.toFixed(1)}M`);
  return mom.join(' · ');
}

// "day high +41% · after hours +34% · tf 1" (`extra` goes before the timeframe)
function contextParts(sig: TvSetupSignal, extra: string[] = []): string[] {
  const ctx: string[] = [];
  if (sig.day_gain != null) ctx.push(`day high ${fmtSigned(Math.round(sig.day_gain)).replace('.0%', '%')}`);
  if (sig.ah_gain != null) ctx.push(`after hours ${fmtSigned(Math.round(sig.ah_gain)).replace('.0%', '%')}`);
  ctx.push(...extra);
  if (sig.tf) ctx.push(`tf ${escapeHtml(sig.tf)}`);
  return ctx;
}

function linksLine(sig: TvSetupSignal, tvSym: string): string {
  const finviz = `https://finviz.com/quote.ashx?t=${encodeURIComponent(sig.ticker)}`;
  const tv = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSym)}`;
  return `<a href="${tv}">TradingView</a> · <a href="${finviz}">Finviz</a>`;
}
