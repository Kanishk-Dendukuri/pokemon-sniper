# pokemon-sniper

The auction snipers and the report that sets their tier tables. Split out of
the trading-market app on 2026-09-16 so their runs bill against this account's
own GitHub Actions minutes; nothing here reads or writes the app's database.

## What is in it

| | |
|---|---|
| `scripts/sniper-core.ts` | everything both houses share: the chase list, the tier table, the sales rule, Card Uploader pricing and identification, the per-card cap, the CSV, the hold and the run itself |
| `scripts/sniper-book.ts` | the ceiling, the bid ladder, the fire, and the one rule with money behind it — the amount sent is never above the lot's max hammer |
| `scripts/fanatics-sniper.ts`, `scripts/fanatics-bidder.ts` | Fanatics Collect: the scan, the session, the bid |
| `scripts/alt-sniper.ts`, `scripts/alt-bidder.ts` | the same at alt.xyz |
| `scripts/sold-report.ts`, `scripts/*-sold.ts` | the backtest: what every sold lot went for, and therefore what the tier tables should be |
| `scripts/carduploader-batch.ts`, `scripts/carduploader-comps.ts` | the Card Uploader driver — the free per-cert price lookup and the paid identify batch |
| `scripts/cert-price.ts` | what a card is worth from its recent sales, and whether those sales are enough to say |
| `lib/odds-config.ts` | the pack odds ladder, read only to refuse a lot no pack could ever award |

`carduploader-batch.ts`, `carduploader-comps.ts`, `ebay-csv.ts`,
`cert-price.ts`, `lib/odds-config.ts` and `lib/price-confidence.ts` are copies
of files the app repository also has, and were identical on the day of the
split. When one changes there, it has to change here — with one deliberate
exception: since 2026-09-17 this copy of `cert-price.ts` lets a run choose how
a bid is priced off the recent sales — the second-lowest of five unless told
otherwise — where the app's still uses the lowest as its floor. Everything else moved and is gone from the app.

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

## How a live run spends the evening

It prices the whole list first and bids on nothing. A bid placed hours early
is a bid the other bidder has hours to answer: on 13 Sep 2026 at Fanatics,
433 bids went on from 4 PM, 189 were beaten by someone coming back later in
the afternoon, and 28 were won. So the run holds, re-scans the house every
five minutes from half an hour out to see which lots the room has already
taken past our max, and at the fire bids on everything left, eight lots at a
time. Then it watches until the auction is over. One bid per lot, at the max,
never raised.

The fire is `--fire-after` (the "fire after" box), minutes after extended
bidding opens, and each house has its own rule:

| house | extended bidding | how it closes | fire |
|---|---|---|---|
| Fanatics Collect | 7:00 PM PT Sunday | lot by lot: no bid 7:00–7:30 closes it at 7:30 sharp; then 5 min after the last bid; after 8:00, 1 min | 27 min in, 7:27 PM |
| Alt | 9:00 PM ET Thursday | all together: any bid extends every lot by the window of the hour (2 min, 1 min, 30 s, 15 s); ends after one quiet window; runs to 12–2:30 AM | 100 min in, 10:40 PM, or sooner if the clock reads seconds from the end |

Alt keeps two or three auctions open at once, a week apart, and every one of
them takes bids. A run scans only the auction closing first — the one whose
extended bidding the fire is timed to — and leaves the cycle behind it alone,
since a bid put on next week's lots tonight would stand there all week for
anyone to answer. `--auction` overrides that: an auction's id, or any part of
its name, or several separated by commas (`--auction="Sep 04"`, or the AUCTION
environment variable). An auction that matches nothing open stops the run
before the scan and names the ones there are.

`--budget` is a ceiling on what the run may hold at once, all-in — $10,000
unless told — and not a target: how many lots are won is the tier table's
and the per-card cap's doing.

The tier table's shares multiply the card's **bid basis**: its recent sales
boiled down to one price. `--value-basis` (the value basis box) says how, and
`--sales-rule` says which sales:

| `--value-basis` | the bid basis |
|---|---|
| `lowest` | the cheapest of the sales |
| `2nd lowest` *(default)* | the cheapest with the worst comp thrown out |
| `3rd lowest` | and so on |
| `average of the 2 lowest`, `average of the 3 lowest` | the cheap end, smoothed |
| `drop the lowest and the highest, average the rest` | the trimmed mean |
| `median`, `average` | near what the card really goes for |

A basis that runs off the end of a short list takes what there is. The default
is the second-lowest of the five sales Card Uploader returns, all inside 60
days (`--sales-rule="5 sales in 60 days"`); it was the lowest until 2026-09-17,
when one bad comp on the low side sank the bid on a card the other four agreed
about. Market value — what a won lot's price is measured against — stays the
median of the same sales whatever the basis.

The sold report takes both boxes too, and that is the way to try a basis: run
it on one, run it again on another, and compare the tables it recommends. A
tier table fitted on one basis is only right for a sniper run set to the same
one, so change both together.

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
the full 360 minutes a hosted runner allows. Start Fanatics around 4 PM PT on
the Sunday and Alt around 8:30 PM ET on the Thursday; the workflow headers say
why.

## Tests

```
npm test
npm run typecheck
```
