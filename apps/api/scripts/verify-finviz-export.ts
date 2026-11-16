// Regression for the Finviz screener export client (services/finviz.ts).
// Run:  npx tsx scripts/verify-finviz-export.ts
// 2026-11-16: Finviz split its screener into a Stock and an ETF one ("add type= to your Finviz
// screener export URLs by 07.Dec.2026"). Every screener export URL names its product now
// (/export/screener?type=stocks&…), and the parsers read their columns by header name, because
// the notice says the new screener's CSV starts a custom column list with "No." and "Ticker".
// The sample rows are what the API returned on 11-16 (identical with and without type=stocks).

process.env.FINVIZ_API_TOKEN = 'test-token';
const { csvColumns, parseAfterHoursQuotes, parseCsv, parseQuotes, parseScreenerExports, screenerExportUrl } = await import('../src/services/finviz.js');

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('The export URL');
{
  const u = screenerExportUrl('v=131&f=ind_stocksonly%2Csh_price_1to25&o=-change');
  check('names the product and uses the screener export path',
    u === 'https://elite.finviz.com/export/screener?type=stocks&v=131&f=ind_stocksonly%2Csh_price_1to25&o=-change&auth=test-token', u);
  check('…with a caller\'s own token', screenerExportUrl('v=110&f=x', 'abc') === 'https://elite.finviz.com/export/screener?type=stocks&v=110&f=x&auth=abc');
}

console.log('Columns by name');
{
  const c = csvColumns(['No.', 'Ticker', 'Price', 'Change'], { Ticker: 0, Price: 1, Change: 2 }, 'test');
  check('found by name, whatever the position', c.Ticker === 1 && c.Price === 2 && c.Change === 3, JSON.stringify(c));
  check('case and spaces don\'t matter', csvColumns([' ticker ', 'PRICE'], { Ticker: 5, Price: 6 }, 'test').Ticker === 0);
  const warn = console.warn;
  const warned: string[] = [];
  console.warn = (m: string) => { warned.push(m); };
  const f = csvColumns(['Ticker', 'Last'], { Ticker: 0, Price: 1 }, 'test-missing');
  csvColumns(['Ticker', 'Last'], { Ticker: 0, Price: 1 }, 'test-missing');
  console.warn = warn;
  check('a name the header lacks keeps its old position, logged once', f.Ticker === 0 && f.Price === 1 && warned.length === 1 && warned[0].includes('"Price"'), warned.join(' | '));
  check('no header at all → the old positions, silently', csvColumns(undefined, { Ticker: 0, Price: 1 }, 'test-empty').Price === 1);
}

const OWN = `"No.","Ticker","Market Cap","Shares Outstanding","Shares Float","Insider Ownership","Insider Transactions","Institutional Ownership","Institutional Transactions","Short Float","Short Ratio","Average Volume","Price","Change","Volume"
1,"FCUV",6.95,0.98,0.88,10.37%,0.00%,11.49%,12.07%,0.27%,0.00,1940.21,7.08,136.00%,117440752
2,"AKAN",3.58,2.63,2.39,9.30%,0.00%,1.78%,-20.27%,8.09%,0.08,2551.55,1.36,102.47%,89210168
3,"BIGF",900.00,60.00,55.00,1.00%,0.00%,50.00%,1.00%,2.00%,1.00,500.00,15.00,25.00%,1000000
4,"NOFL",,,,,,,,,,10.00,2.00,22.00%,50000
`;
const OVW = `"No.","Ticker","Company","Sector","Industry","Country","Market Cap","P/E","Price","Change","Volume"
1,"FCUV","Focus Universal Inc","Technology","Scientific & Technical Instruments","USA",6.95,,7.08,136.00%,117440752
2,"AKAN","Akanda Corp, Class A","Healthcare","Drug Manufacturers","Canada",3.58,,1.36,102.47%,89210168
`;

console.log('The screener rows (v=131 + v=110)');
{
  const rows = parseScreenerExports(parseCsv(OWN), parseCsv(OVW), { floatMaxM: 35, topN: 10 });
  const f = rows[0];
  check('today\'s layout parses', rows.length === 3 && f.ticker === 'FCUV' && f.price === 7.08 && f.change_pct === 136 && f.volume === 117440752
    && f.float_m === 0.88 && f.float_is_proxy === false && f.mcap_m === 6.95 && f.shares_out_m === 0.98 && f.avg_volume === 1940210
    && f.rel_volume === 60.53 && f.insider_own_pct === 10.37 && f.inst_trans_pct === 12.07 && f.short_float_pct === 0.27 && f.short_ratio === 0,
    JSON.stringify(f));
  check('…the overview\'s company, sector, industry, country (a quoted comma too)', f.company === 'Focus Universal Inc' && f.sector === 'Technology'
    && f.industry === 'Scientific & Technical Instruments' && f.country === 'USA' && rows[1].company === 'Akanda Corp, Class A' && rows[1].country === 'Canada');
  check('…the float cap drops the big one, an unknown float is kept, no overview row → no company',
    !rows.some((r) => r.ticker === 'BIGF') && rows[2].ticker === 'NOFL' && rows[2].float_m === null && rows[2].company === null);
  check('…topN', parseScreenerExports(parseCsv(OWN), parseCsv(OVW), { floatMaxM: 35, topN: 1 }).length === 1);
  // the same data with the columns moved: one more in front, Price / Change / Volume first
  const moved = (csv: string) => parseCsv(csv).map((r, i) => [i === 0 ? 'Type' : 'stock', r[0], r[12], r[13], r[14], ...r.slice(1, 12)]);
  const again = parseScreenerExports(moved(OWN), parseCsv(OVW).map((r) => [r[0], r[5], r[4], r[3], r[2], r[1]]), { floatMaxM: 35, topN: 10 });
  check('a moved layout gives the same rows (columns are read by name)', JSON.stringify(again) === JSON.stringify(rows), JSON.stringify(again[0]));
}

console.log('The quote export (v=152, custom columns)');
{
  const today = parseQuotes(parseCsv('"Ticker","Price","Change"\n"AAPL",356.27,0.39%\n"MSFT",512.10,-1.20%\n'), false);
  check('today\'s layout: Ticker, Price, Change', today.size === 2 && today.get('AAPL')?.price === 356.27 && today.get('AAPL')?.change_pct === 0.39
    && today.get('MSFT')?.change_pct === -1.2, JSON.stringify([...today]));
  const next = parseQuotes(parseCsv('"No.","Ticker","Price","Change"\n1,"AAPL",356.27,0.39%\n2,"MSFT",512.10,-1.20%\n'), false);
  check('the announced layout (No. and Ticker first) gives the same quotes, keyed by ticker',
    JSON.stringify([...next]) === JSON.stringify([...today]) && !next.has('1'), JSON.stringify([...next]));
  const ah = parseQuotes(parseCsv('"Ticker","Price","Change","After-Hours Close","After-Hours Change"\n"AAPL",356.27,0.39%,355.33,-0.26%\n"MSFT",512.10,-1.20%,,\n'), true);
  check('after hours: the after-hours close and change where Finviz has them, the regular ones otherwise',
    ah.get('AAPL')?.price === 355.33 && ah.get('AAPL')?.change_pct === -0.26 && ah.get('MSFT')?.price === 512.1 && ah.get('MSFT')?.change_pct === -1.2,
    JSON.stringify([...ah]));
  const ahNext = parseQuotes(parseCsv('"No.","Ticker","Price","Change","After-Hours Close","After-Hours Change"\n1,"AAPL",356.27,0.39%,355.33,-0.26%\n'), true);
  check('…and in the announced layout', ahNext.get('AAPL')?.price === 355.33 && ahNext.get('AAPL')?.change_pct === -0.26);
  check('an empty or header-only answer → no quotes', parseQuotes([], false).size === 0 && parseQuotes(parseCsv('"Ticker","Price","Change"\n'), false).size === 0);
}

console.log('The after-hours overlay (v=152)');
{
  const a = parseAfterHoursQuotes(parseCsv('"Ticker","After-Hours Close","After-Hours Change","After-Hours Volume"\n"AAPL",355.33,-0.26%,6073028\n"MSFT",,,\n'));
  check('today\'s layout', a.get('AAPL')?.close === 355.33 && a.get('AAPL')?.change === -0.26 && a.get('AAPL')?.volume === 6073028
    && a.get('MSFT')?.close === null, JSON.stringify([...a]));
  const b = parseAfterHoursQuotes(parseCsv('"No.","Ticker","After-Hours Close","After-Hours Change","After-Hours Volume"\n1,"AAPL",355.33,-0.26%,6073028\n'));
  check('the announced layout', b.get('AAPL')?.close === 355.33 && b.get('AAPL')?.volume === 6073028 && !b.has('1'), JSON.stringify([...b]));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll Finviz export checks passed');
