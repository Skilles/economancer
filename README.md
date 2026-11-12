# Economancer

Gold-making planner for **World of Warcraft: Forever**. It pulls every Forever auction house from the Blizzard API each hour and recommends:

- **Arbitrage**: neutral AH ↔ faction AH gaps, and cross-faction moves through the neutral AH (those need a second account)
- **Flips**: listings well under the item's typical price, or far under the next listing
- **Crafts**: recipe profit using AH or vendor material prices
- **Shuffles**: 2–3 step chains (smelt → transmute, essence split/combine, cloth → bolts…)
- **Forecast**: 3- and 7-day price estimates, each material's tier and longevity, and a population "progression index"

- **Plan**: a buy, craft and post list for your gold, with no double-spending
- **My stuff**: the best thing to do with each item you own (sell here or on neutral, craft, hold, vendor)
- **Character**: import from the companion addon or enter things by hand. Includes profit tracking from your AH mail.

It's a static site on GitHub Pages. A scheduled GitHub Action does all the data work, so there's no server.

## How it works

```
GitHub Actions (hourly)
  └─ collector/collect.mjs
       ├─ GET /data/wow/ruleset/index               (dynamic-forever-{region})
       ├─ GET /data/wow/ruleset/{id}/auctions/      → house list
       ├─ GET …/auctions/{house} + …/commodities    → listings (If-Modified-Since)
       ├─ estimate sales: auctions that vanish with >30 min left = sold
       ├─ daily + 3-hour price history, 14-day typical price
       ├─ item names (static-forever) and recipes (weekly)
       ├─ forecasts (collector/lib/forecast.mjs)
       └─ writes public/data/*.json  →  deployed to GitHub Pages
  state/  ←→  Actions cache (history between runs; never committed)
```

The browser loads the JSON for the chosen region, ruleset and faction (your faction's AH, the other faction's, and the neutral one) and computes every recommendation on the page. Settings (AH cuts, budget, horizon, professions) stay in your browser.

## Setup

1. Create a client at https://develop.battle.net/access/clients
2. Add repo secrets `BLIZZARD_CLIENT_ID` and `BLIZZARD_CLIENT_SECRET`
3. Under Settings → Pages, set **Source: GitHub Actions**
4. Optional: add a repo variable `REGIONS` (default `us,eu`)

GitHub turns off scheduled workflows after 60 days with no repo activity. If that happens, re-enable the workflow from the Actions tab.

## Companion addon

`addon/Economancer` is a small in-game addon. The workflow zips it and publishes it as `Economancer-addon.zip` on the site. It records:

- gold, bags, and bank (bank only while the bank window is open)
- professions with skill levels, and known recipes (recorded when you open each profession window)
- auction sales and purchases, from mailbox invoices

`/econ` opens an export window. Press Ctrl+C and paste into the site's Character tab. Addons can't access the internet, so it's copy and paste by design. Data stays in your browser's localStorage. `/econ forget` clears the current character and `/econ reset` clears everything.

If the client says the addon is out of date, tick "Load out of date AddOns" or update the `## Interface:` line in `Economancer.toc` to the version shown in-game. The addon tries the modern APIs first and falls back to the classic ones, because Forever's client API isn't fully documented.

## Forecast model

Each tradeable material gets a **tier** (level band) and a **role**: `leveling`, `endgame-crafting` or `endgame-consumable`. These come from hand-made tags in `collector/data/curated.json`, or are inferred from item level and what the item crafts into (which covers Forever's new materials).

The **front** is an estimate of where most players are:
- by default, the progression index: the log-quantity-weighted average tier of gathered materials on the AH, which rises as players level
- if `collector/data/population-seeds.json` lists guilds or characters, the median level sampled from guild rosters

The forecast blends the item's own damped trend (a Theil–Sen slope on log price) with a prior based on role and front. For example, leveling materials fade once the front passes their band, and endgame consumables hold their value. Trend weight grows with days of history. All weights are in `forecastModel` in `curated.json`.

Population seeds example:

```json
{ "us": { "guilds": ["some-guild-slug"], "characters": ["somechar"] }, "eu": { "guilds": [] } }
```

## Local testing

```
./test/run.sh 30                    # simulate 30 hourly runs against a mock API
cd test/public && python3 -m http.server 8099
```

## Caveats

- The Forever API isn't officially documented yet. Endpoints were mapped by the community after launch (Nov 6, 2026).
- Sell rates count cancellations as sales, so treat them as an upper bound.
- Curated recipes are classic (1.12) recipes. Forever may change some of them; edit `curated.json` if so.
