# pokemon-sniper

The auction snipers and the report that sets their tier tables. Split out of
the trading-market app on 2026-09-16 so their runs bill against this account's
own GitHub Actions minutes; nothing here reads or writes the app's database.

## What is in it

| | |
|---|---|
| `scripts/sniper-core.ts` | everything both houses share: the chase list, the tier table, the sales rule, Card Uploader pricing and identification, the per-card cap, the CSV and the run itself |
| `scripts/sniper-book.ts` | the budget, the bid ladder, and the one rule with money behind it — the amount sent is never above the lot's max hammer |
| `scripts/fanatics-sniper.ts`, `scripts/fanatics-bidder.ts` | Fanatics Collect: the scan, the session, the bid |
| `scripts/alt-sniper.ts`, `scripts/alt-bidder.ts` | the same at alt.xyz |
| `scripts/sold-report.ts`, `scripts/*-sold.ts` | the backtest: what every sold lot went for, and therefore what the tier tables should be |
| `scripts/carduploader-batch.ts`, `scripts/carduploader-comps.ts` | the Card Uploader driver — the free per-cert price lookup and the paid identify batch |
| `scripts/cert-price.ts` | what a card is worth from its recent sales, and whether those sales are enough to say |
| `lib/odds-config.ts` | the pack odds ladder, read only to refuse a lot no pack could ever award |

`carduploader-batch.ts`, `carduploader-comps.ts`, `ebay-csv.ts`,
`cert-price.ts`, `lib/odds-config.ts` and `lib/price-confidence.ts` are copies
of files the app repository also has, and were identical on the day of the
split. When one changes there, it has to change here. Everything else moved
and is gone from the app.

## Running one

```
npm ci
npx playwright install chromium

npm run sniper -- --budget=250                 # plan only: scans, prices, bids nothing
npm run sniper -- --budget=250 --live          # real money
npm run sniper:alt -- --budget=250             # the same at Alt
npm run sold-report -- --fanatics=4 --alt=4    # what the tables should be
```

Nothing is bid without `--live`. Without it the run does everything except
send a bid, and needs no auction account at all.

## In Actions

Three workflows, all started by hand, never on a schedule:
`fanatics-sniper.yml`, `alt-sniper.yml`, `sold-report.yml`. Each one's header
comment is its documentation — the tier table, the budget, when to fire it.

Secrets the repository needs:

| secret | who needs it |
|---|---|
| `CARDUPLOADER_EMAIL`, `CARDUPLOADER_PASSWORD` | every run — pricing |
| `FANATICS_REFRESH_TOKEN` | a live Fanatics run; `npm run sniper -- --export-session` mints one |
| `ALT_SESSION_TOKEN` | a live Alt run; `npm run sniper:alt -- --login` then `--export-session` |

A live run holds its bids open through extended bidding, so the job is given
the full 360 minutes a hosted runner allows.

## Tests

```
npm test
npm run typecheck
```
