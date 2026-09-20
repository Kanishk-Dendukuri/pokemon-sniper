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
| `scripts/ebay-sniper.ts`, `scripts/ebay-search.ts`, `scripts/ebay-bidder.ts`, `scripts/set-dates.ts` | eBay: the daemon that runs all day, the Browse API it finds auctions with, the signed-in browser it bids through, and the set release dates behind the new-set guardrail |
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
npm run sniper:ebay -- --once                  # eBay: one scan and one plan, nothing sent
npm run sniper:ebay -- --live                  # eBay: the daemon, real money (see below)
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

## eBay

The third sniper is a different shape. Fanatics and Alt close one auction a
week and the run is one evening; eBay is a stream of auctions from a few
chosen sellers, each ending on its own fixed clock with no extension, so
`sniper:ebay` is a daemon that runs all day on the PC: a hosted runner stops
at six hours and has no signed-in eBay session, so bidding happens there and
nowhere else. `ebay-sniper.yml` runs the planning half in Actions — one scan,
the prices, and the list of lots it would have bid on — and that is where the
postcode postage is quoted to is a box on the form.

What it does, every `--scan-every` minutes (10 by default): asks eBay for
every live auction the sellers have in the trading-card category, reads the
new ones, keeps **PSA 1–10 and CGC 7–10**
Pokémon slabs with a cert number, prices them exactly as the other snipers do
(Card Uploader, the tier tables, `--value-basis`, `--sales-rule`), and puts
the ones worth a bid on a schedule. Each scheduled lot is bid on once, at its
max, `--fire-before` seconds before its end (5 by default) — eBay's proxy
bidding takes the max as a ceiling and bids up to it on the account's behalf
— and how it closed is read back afterwards. When the lots actually won add
up to `--budget` ($10,000 by default), the daemon stops. Bids in flight are
held against the budget at their max, so it never bids past it. `--max-wins`
stops it on a count of lots instead, whichever comes first; 0, the default,
is as many lots as the budget stretches to. What is bid on and not yet
settled counts against that limit, since two standing bids can both land.

**Two pools, not one.** Every live Pokémon auction eBay runs under
**Authenticity Guarantee**, whoever is selling — 5,894 of them, across 142+
sellers, of which about 47% are PSA/CGC in range — because the programme is
eBay's own promise that the slab is what the label says. And everything the
**named sellers** list, guaranteed or not, because those four are known by
name: 31,707 auctions between them. A lot that is neither is passed over.
That split matters because the programme does not cover the named sellers
evenly — PSA's own store has 26,579 live Pokémon auctions and not one of them
under the guarantee, so an AG-only run would never bid there.
`--sellers-only` drops the wider pool and buys from the four alone.

eBay's `sellers` filter is not trusted on its own, either: given a username
nobody has it drops the filter and answers with **everyone's** listings
(`collectpsa` does this — 264,772 hits from strangers). Every listing's seller
is checked again after it is read, and `--check-sellers` says which of the
names it was given are real.

**The cert number is read off the slab.** None of these sellers publish one —
not in the title, not in eBay's item specifics, not in the description; 400
listings were sampled and not one carried it. Every listing does photograph
the slab label first, so the number is read from there with **Tesseract** —
free, offline, no account and no API key. That keeps eBay on exactly the same
pricing as Fanatics and Alt — Card Uploader prices nothing but a cert — rather
than a second, incomparable source.

Nine passes per photograph (the whole frame, and the two bands at the top
where the label sits, enlarged, at three page-segmentation modes), and the
digit runs are voted on. Only runs the right length for the grader count,
which throws out the card number, the year and the copyright line, and the
winner has to beat the runner-up outright — a tie is no answer rather than a
guess. On a sample of seven live listings across all four sellers it read
every cert exactly, winning by 8 to 13 votes, at about 4 seconds a label.

It wants the real Tesseract, not the WASM build: `tesseract.js` cannot crop
and its model misreads digits the binary reads cleanly. One line to install —
`winget install UB-Mannheim.TesseractOCR` on Windows, `brew install
tesseract` on a Mac — and the run stops at start-up with that line if it is
missing. `TESSERACT_PATH` points at it if it is somewhere unusual.

Reading takes a few seconds per listing, so it is spent late and sparingly:
only on lots that have already passed every free filter (right seller, a grade
the run buys, a set old enough) and are within `--ocr-before` minutes of
closing, 120 by default, at most `--ocr-per-day` a day. A label is read once
and kept in `state.json`. `--no-ocr` turns it off, which schedules nothing.

**A cert that does not answer to its listing is dropped.** Once Card Uploader
says what the number really is, that is checked against what the listing
claims and what the label was read as: grader, grade, year, card number. Any
disagreement and the lot is passed over with the disagreement written into the
CSV — a misread digit prices a different card, and a slab listed as a 10 whose
cert is a 9 is not the slab that was priced. The CSV's `cert_from` column says
whether a cert came from the listing or the label.

One guardrail the others do not have: **nothing from a set released in the
last six months** (`--new-set-months`). A new set's comps are hype prices.
Release dates come from Limitless TCG, which names Japanese sets in English
the way Card Uploader does, read once a day into `ebay-sniper-runs/sets.json`.
A set the list does not know is refused when the card's own year could put it
inside the window — the guardrail fails closed.

There is no buyer's premium at eBay, but postage is the buyer's and it is
money out of the same budget, so the all-in is the hammer plus what the
listing charges to post it. The sniper takes that off the bid: a $200 all-in
max on a lot that posts for $6 is bid to $194, not $200. eBay quotes a
calculated postage rate only when it is told where the buyer is — and it
refuses the Authenticity Guarantee filter outright without one — so
`--zip=<postcode>` (or `EBAY_ZIP` in `.env.local`) is required for anything
that searches. Where eBay
quotes nothing, `--shipping-unknown` stands in, $15 by default, and the CSV
marks the figure "assumed"; an unquoted rate is never read as free postage,
since a guess of zero is a guess in the wrong direction. Sales tax is not
counted.

### Setting it up on the PC

1. Node 20+, then in this folder: `npm ci` and `npx playwright install chromium`.
2. A developer.ebay.com application, production keyset — the search runs on
   an application token and needs no approval beyond the keys. Put them in
   `.env.local` as `EBAY_CLIENT_ID` and `EBAY_CLIENT_SECRET`, with
   `CARDUPLOADER_EMAIL` and `CARDUPLOADER_PASSWORD` beside them.
3. `npm run sniper:ebay -- --check-sellers` — how many live auctions each
   seller has, and how many under Authenticity Guarantee. A seller with none
   is a misspelt username. The defaults are `zandgemporium`,
   `ryans_cardhouse`, `probstein123`, `psa`; `--sellers=a,b,c` changes them.
4. `npm run sniper:ebay -- --login` — sign in to eBay by hand, once, in the
   window that opens. The session lives in `.ebay-session/` and is never
   committed. Set `EBAY_ACCOUNT` (or `--account`) to the name eBay greets
   you by, so any other account's session is refused.
5. `npm run sniper:ebay -- --once` — one scan and one plan: what it found,
   what it priced, what it would bid on. Nothing is sent.
6. `npm run sniper:ebay -- --rehearse=<item number> --max=1` — walks the bid
   flow on one real listing up to the Confirm button, screenshots every
   step under `ebay-sniper-runs/`, and stops. eBay's bid API is closed to
   new applications and its licence forbids snipers, so the bid goes
   through the browser the way a person places one; the flow in
   `scripts/ebay-bidder.ts` was written against eBay's bid layer without a
   signed-in session to check it on, and `BID_FLOW_VERIFIED` holds `--live`
   off until a rehearsal has been read against it. Use a listing you would
   not mind bidding on.
7. Once that is verified: `npm run sniper:ebay -- --live --budget=10000`.
   Leave the terminal open. Ctrl+C stops it cleanly — armed bids are let go,
   bids already confirmed stay on eBay's books. A restart picks up
   `ebay-sniper-runs/state.json`: the schedule, the bids on, the wins.

Keep the PC awake (power settings: never sleep) and its clock synced —
though the fire itself is timed on eBay's clock, read off every API
response, not the PC's.

eBay's user agreement prohibits automated access to the site. Sniping is
allowed; a bot on the account is a grey area, and the account could be
flagged. That risk is the account holder's.

### Reading a run

The console is the log. Two files under `ebay-sniper-runs/` are kept current:
`state.json`, which a restart reads, and `ebay-bids.csv` — every listing seen,
with its grade, cert, set, the price it was worked from, the max, what was bid,
what it went for, what was paid and as what share of market, and for every
listing passed over, why.

Flags, beyond the shared ones: `--fire-before=5`, `--arm-before=60` (when the
page is opened and walked to Confirm), `--scan-every=10`, `--sellers`,
`--psa-grades=1-10`, `--cgc-grades=7-10`, `--new-set-months=6`, `--once`,
`--max-wins=0`, `--sellers-only`, `--ocr-before=120`, `--ocr-per-day=1500`,
`--no-ocr`,
`--zip=<postcode>` (required), `--shipping-unknown=15`,
`--headless` (not advised: eBay draws a headless browser a different page),
`--headed` (show the Card Uploader browser), `--out`. The header of
`scripts/ebay-sniper.ts` has the full list.

The Browse API allows 5,000 calls a day to a new application. A scan is a
few calls plus one per new listing (150 per scan at most, soonest-ending
first); each fire is one, each outcome one. The heartbeat prints the day's
count, and a scan is skipped near the allowance so the fires never are.

## In Actions

Four workflows, all started by hand, never on a schedule:
`fanatics-sniper.yml`, `alt-sniper.yml`, `ebay-sniper.yml`, `sold-report.yml`.
The eBay one plans only — it never bids, since the bid needs the signed-in
browser on the PC; its boxes include the postcode postage is quoted to and
what to assume where eBay quotes none. Each workflow's header comment is its
documentation — the tier table, the budget, when to fire it.

Secrets the repository needs:

| secret | who needs it |
|---|---|
| `CARDUPLOADER_EMAIL`, `CARDUPLOADER_PASSWORD` | every run — pricing |
| `FANATICS_REFRESH_TOKEN` | a live Fanatics run; `npm run sniper -- --export-session` mints one |
| `ALT_SESSION_TOKEN` | a live Alt run; `npm run sniper:alt -- --login` then `--export-session` |
| `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET` | the eBay scan; a developer.ebay.com **production** keyset, not the sandbox one |

A live run holds its bids open through extended bidding, so the job is given
the full 360 minutes a hosted runner allows. Start Fanatics around 4 PM PT on
the Sunday and Alt around 8:30 PM ET on the Thursday; the workflow headers say
why.

## Tests

```
npm test
npm run typecheck
```
