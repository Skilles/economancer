// Economancer views. Strategy math lives in core.js.
import {
  S, DEFAULTS, ROLE_NAMES, CONF_NAMES, load, save, loadProfile, saveProfile, resetProfile, invalidate,
  esc, money, pct, ago, fmtNum, factionLabel, itemIdOf, itemName, nameHtml, vendorPrice, idByName,
  fetchJson, rulesetObj, loadMarket, H, importedChars, activeChars, hasImport, playerGold, budgetCopper,
  playerProfs, inventory, recipeSig, recipeStatus, arbitrage, flips, crafts, shuffles, forecasts, myStuff,
  plan, ledgerStats, parseExport,
} from "./core.js";

const PAGE = 30;

// ---------- small render helpers ----------
function spdChip(row, label = "sells") {
  if (!row || row.spd == null) {
    return '<span class="chip warn">no sales data yet</span>';
  }
  const cls = row.spd >= S.settings.minSpd ? "" : "warn";
  return `<span class="chip ${cls}">${label} ~${fmtNum(row.spd)}/day</span>`;
}
function houseChip(h) {
  return `<span class="chip ${h}">${factionLabel(h)}${h === "vendor" ? "" : " AH"}</span>`;
}
function card(title, profit, sub, body, chips, opts = {}) {
  return `
    <div class="card">
      <div class="row1"><span class="name${opts.wrap ? " wrap" : ""}">${title}</span><span class="profit ${opts.neg ? "neg" : "pos"}">${profit}</span></div>
      ${sub ? `<div class="sub">${sub}</div>` : ""}
      ${body ?? ""}
      ${chips ? `<div class="chips">${chips}</div>` : ""}
    </div>`;
}
function statusChip(st) {
  if (st === "unverified") {
    return '<span class="chip warn">recipe not confirmed — open the profession window in-game</span>';
  }
  if (st === "unknown") {
    return '<span class="chip bad">you don\'t know this recipe</span>';
  }
  return "";
}

function renderPick(p) {
  const d = p.data;
  switch (p.kind) {
    case "arb":
      return card(
        nameHtml(p.key),
        money(p.profit),
        `Buy ${d.units}× on ${factionLabel(d.buyHouse)} for ${money(d.cost / d.units)} each, sell on ${factionLabel(d.sellHouse)} at ${money(d.sell)}`,
        "",
        `<span class="chip">${esc(d.label)}</span><span class="chip good">ROI ${pct(d.roi)}</span><span class="chip">invest ${money(p.invest)}</span>${spdChip(d.sellRow)}${d.transferFee > 0 ? '<span class="chip warn">needs an alt on a 2nd account</span>' : ""}`,
      );
    case "flip": {
      const why = d.why === "gap" ? `next listing is ${pct(d.gap)} higher` : `below its typical ${money(d.row.base)}`;
      return card(
        nameHtml(p.key),
        money(p.profit),
        `Buy ${d.units}× at ${money(d.cost / d.units)} avg, relist at ${money(d.sell)}. Why: ${why}`,
        "",
        `<span class="chip good">ROI ${pct(p.profit / p.invest)}</span><span class="chip">invest ${money(p.invest)}</span>${spdChip(d.row)}<span class="chip">${d.row.histDays}d history</span>`,
      );
    }
    case "craft": {
      const r = d.r;
      const mats = d.mats.parts
        .map((m) => `<li>${m.q}× ${nameHtml(m.id)} @ ${money(m.u)}${m.src === "vendor" ? " (vendor)" : ""}${m.have > 0 ? ` <span class="pos">you have ${m.have}</span>` : ""}</li>`)
        .join("");
      return card(
        `${nameHtml(r.out)}${r.outQty !== 1 ? ` ×${r.outQty}` : ""}`,
        `${money(d.each)}<span class="sub"> /craft</span>`,
        `${esc(r.name)} · mats ${money(d.mats.value / d.n)} · sells ${money(d.sell)}${d.n > 1 ? ` · make ${d.n} ≈ ${money(p.profit)}` : ""}${d.mats.cash < d.mats.value ? ` · cash needed ${money(d.mats.cash)}` : ""}`,
        `<ul class="steps">${mats}</ul>`,
        `<span class="chip">${esc(r.prof ?? "")}</span><span class="chip good">margin ${pct(d.each / (d.mats.value / d.n))}</span>${spdChip(d.out)}${r.cd ? '<span class="chip warn">cooldown</span>' : ""}${r.note ? `<span class="chip warn">${esc(r.note)}</span>` : ""}${r.src === "curated" ? '<span class="chip">classic recipe, verify</span>' : ""}${statusChip(d.status)}${d.each7 != null ? `<span class="chip ${d.each7 >= d.each ? "good" : "bad"}">7-day forecast ${money(d.each7)}/craft</span>` : ""}`,
      );
    }
    case "shuffle":
      return card(
        d.chain.map((s) => esc(s.r.name)).join(" → "),
        `${money(d.profit)}<span class="sub"> /batch</span>`,
        `End with ${fmtNum(d.outQty)}× ${nameHtml(d.out)} · batch costs ${money(d.cost)} · ${isFinite(d.gainVsFirst) ? `${money(d.gainVsFirst)} more than selling after step 1` : "step 1's output doesn't sell on the AH"}`,
        `<ol class="steps">${d.chain.map((s) => `<li>${fmtNum(s.n)}× ${esc(s.r.name)} <span class="sub">(${s.r.mats.map(([id, q]) => `${q} ${esc(itemName(id))}`).join(", ")})</span></li>`).join("")}</ol>`,
        `<span class="chip good">ROI ${pct(d.profit / d.cost)}</span>${d.batches > 1 ? `<span class="chip">${d.batches} batches ≈ ${money(p.profit)}</span>` : ""}${spdChip(d.outRow, "end item sells")}${d.chain.some((s) => s.r.cd) ? '<span class="chip warn">has cooldown</span>' : ""}`,
        { wrap: true },
      );
    case "stock":
      return card(
        nameHtml(p.key),
        money(p.profit),
        `Buy ${d.b.units}× at up to ${money(d.b.maxPaid)}, hold about a week, sell near ${money(d.x.r.f7)}`,
        "",
        `<span class="chip">forecast ${pct(d.x.chg7)}</span><span class="chip">${CONF_NAMES[d.x.r.conf]} confidence</span><span class="chip">invest ${money(p.invest)}</span>`,
      );
    case "own":
      return stuffCard(d);
    default:
      return "";
  }
}

function forecastCard(x) {
  const r = x.r;
  return card(
    nameHtml(x.key),
    pct(x.chg7),
    `Now ${money(r.market)} → 3d ${money(r.f3)} → 7d ${money(r.f7)}`,
    "",
    `<span class="chip">${ROLE_NAMES[r.role] ?? "Unknown"}${r.tier ? ` · tier ${r.tier}` : ""}</span><span class="chip ${r.conf >= 2 ? "good" : r.conf === 1 ? "" : "warn"}">${CONF_NAMES[r.conf] ?? "low"} confidence</span><span class="chip">longevity <span class="bar"><i style="width:${r.lon ?? 0}%"></i></span></span>${r.trend != null ? `<span class="chip">trend ${pct(Math.exp(r.trend) - 1, 1)}/day</span>` : ""}${spdChip(r)}`,
    { neg: x.chg7 < 0 },
  );
}

function stuffCard(s) {
  const b = s.best;
  const alts = s.opts
    .slice(1, 4)
    .map((o) => `<span class="chip">${esc(o.label)} ${money(o.perUnit)}</span>`)
    .join("");
  let action = "No market for this item";
  if (b) {
    action = `${esc(b.label)} — ${money(b.perUnit)} each`;
    if (b.type === "sell" && b.row) {
      const cap = b.row.spd != null ? Math.floor(b.row.spd * S.settings.horizon) : null;
      if (cap != null && cap < s.count) {
        action += ` <span class="warn">(market takes ~${cap} in ${S.settings.horizon}d)</span>`;
      }
    }
  }
  return card(`${nameHtml(s.key)} ×${s.count}`, money(s.total), action, "", alts);
}

function list(id, picks, empty, renderer = renderPick) {
  S.lists.set(id, { picks, shown: PAGE, renderer });
  if (picks.length === 0) {
    return `<p class="empty">${empty}</p>`;
  }
  const first = picks.slice(0, PAGE).map(renderer).join("");
  const more = picks.length > PAGE ? `<button class="more" data-more="${id}">Show more (${picks.length - PAGE} left)</button>` : "";
  return `<div class="cards" id="list-${id}">${first}</div>${more}`;
}
function onMore(btn) {
  const L = S.lists.get(btn.dataset.more);
  const next = L.picks.slice(L.shown, L.shown + PAGE);
  L.shown += next.length;
  document.getElementById(`list-${btn.dataset.more}`).insertAdjacentHTML("beforeend", next.map(L.renderer).join(""));
  const left = L.picks.length - L.shown;
  if (left <= 0) {
    btn.remove();
  } else {
    btn.textContent = `Show more (${left} left)`;
  }
}
function noMarket() {
  return '<p class="empty">No auction data for this ruleset and faction yet. The collector may still be on its first run.</p>';
}
function budgetLabel() {
  const b = budgetCopper();
  if (!isFinite(b)) {
    return "no budget limit";
  }
  const src = S.profile.useGold && playerGold() != null ? "your gold" : "budget";
  return `${src}: ${money(b)}`;
}

// ---------- views ----------
function viewPicks() {
  if (!H.mine()) {
    return noMarket();
  }
  const own = myStuff().filter((s) => s.best && s.best.type !== "vendor").slice(0, 3);
  const sections = [
    ["Arbitrage", arbitrage().slice(0, 3), "arbitrage"],
    ["Flips", flips().slice(0, 3), "flips"],
    ["Crafts", crafts().picks.slice(0, 3), "crafts"],
    ["Shuffles", shuffles().slice(0, 2), "shuffles"],
  ];
  return `
    <p class="explain">The best few ideas from each strategy for <b>${esc(rulesetObj()?.name ?? "")} · ${factionLabel(S.faction)}</b>, ranked by expected profit within ${S.settings.horizon} days (${budgetLabel()}). For a full shopping list, see <a href="#plan">Plan</a>.</p>
    ${own.length ? `<h2 class="section">Your items</h2>${list("pick-own", own, "", stuffCard)}<button class="more" data-goto="stuff">See all your items</button>` : ""}
    ${sections
      .map(([title, picks, tab]) => `
        <h2 class="section">${title}</h2>
        ${list(`pick-${tab}`, picks, "Nothing worth doing right now.")}
        ${picks.length ? `<button class="more" data-goto="${tab}">See all ${title.toLowerCase()}</button>` : ""}`)
      .join("")}
    <h2 class="section">Stock up before prices rise</h2>
    ${list("pick-fc", forecasts().up.slice(0, 3), "Nothing is forecast to rise.", forecastCard)}`;
}

function aggregate(entries, keyFn) {
  const m = new Map();
  for (const e of entries) {
    const k = keyFn(e);
    const cur = m.get(k);
    if (cur) {
      cur.qty += e.qty;
      cur.max = Math.max(cur.max ?? 0, e.max ?? 0);
    } else {
      m.set(k, { ...e });
    }
  }
  return [...m.values()];
}
function lineTable(rows, cols) {
  if (rows.length === 0) {
    return '<p class="empty">Nothing.</p>';
  }
  return `<div class="panel table-wrap"><table class="prices"><tr>${cols.map((c) => `<th>${c[0]}</th>`).join("")}</tr>${rows.map((r) => `<tr>${cols.map((c) => `<td>${c[1](r)}</td>`).join("")}</tr>`).join("")}</table></div>`;
}

function viewPlan() {
  if (!H.mine()) {
    return noMarket();
  }
  const P = plan();
  const order = ["neutral", S.faction === "alliance" ? "horde" : "alliance", S.faction, "vendor"];
  const buys = aggregate(P.chosen.flatMap((p) => p.buys), (b) => `${b.h}:${b.key}`).sort((a, b) => order.indexOf(a.h) - order.indexOf(b.h));
  const crafts = aggregate(
    P.chosen.flatMap((p) => p.crafts.map((c) => ({ ...c, qty: c.n }))),
    (c) => c.name,
  );
  const posts = P.chosen.flatMap((p) => p.posts);
  const sells = posts.filter((x) => !x.hold);
  const holds = posts.filter((x) => x.hold);
  const ownPosts = P.own.flatMap((p) => p.posts);
  const noPlayer = !hasImport() && inventory().size === 0;
  return `
    <div class="panel">
      <div class="stats">
        <div class="stat"><div class="k">Budget</div><div class="v">${isFinite(P.budget) ? money(P.budget) : "∞"}</div></div>
        <div class="stat"><div class="k">Cash used</div><div class="v">${money(P.spent)}</div></div>
        <div class="stat"><div class="k">Expected profit</div><div class="v pos">${money(P.profit)}</div></div>
        <div class="stat"><div class="k">Selling your items</div><div class="v">${money(P.ownValue)}</div></div>
      </div>
      <p class="explain" style="margin:8px 0 0">Picks are ranked by return on cash, never buy the same item from the same AH twice, and stay within ${budgetLabel()}. Sales counted within ${S.settings.horizon} days.</p>
    </div>
    ${noPlayer ? '<p class="explain">Tip: import your character on the <a href="#character">Character</a> tab, or add your gold and items manually, so the plan uses your real budget, items and recipes.</p>' : ""}
    <h2 class="section">1 · Post what you already own</h2>
    ${lineTable(ownPosts, [["Item", (r) => nameHtml(r.key)], ["Qty", (r) => r.qty], ["Where", (r) => factionLabel(r.h)], ["Price", (r) => money(r.price)]])}
    <h2 class="section">2 · Buy</h2>
    ${lineTable(buys, [["Item", (r) => nameHtml(r.key)], ["Qty", (r) => fmtNum(r.qty)], ["Where", (r) => factionLabel(r.h)], ["Pay up to", (r) => money(r.max)]])}
    <h2 class="section">3 · Craft</h2>
    ${lineTable(crafts, [["Recipe", (r) => esc(r.name)], ["Times", (r) => fmtNum(r.qty)]])}
    <h2 class="section">4 · Post</h2>
    ${lineTable(sells, [["Item", (r) => nameHtml(r.key)], ["Qty", (r) => fmtNum(r.qty)], ["Where", (r) => factionLabel(r.h)], ["Price", (r) => money(r.price)]])}
    ${holds.length ? `<h2 class="section">Hold for about a week</h2>${lineTable(holds, [["Item", (r) => nameHtml(r.key)], ["Qty", (r) => fmtNum(r.qty)], ["Target", (r) => money(r.price)]])}` : ""}
    <h2 class="section">Why these picks</h2>
    ${list("plan", P.chosen, "Nothing fits your budget right now.")}`;
}

function viewStuff() {
  const rows = myStuff();
  if (rows.length === 0) {
    return '<p class="empty">No items yet. Import from the addon or add items on the <a href="#character">Character</a> tab.</p>';
  }
  if (!H.mine()) {
    return noMarket();
  }
  const total = rows.reduce((s, r) => s + r.total, 0);
  const valued = rows.filter((r) => r.total >= 10000);
  const small = rows.length - valued.length;
  return `
    <div class="panel"><div class="stats">
      <div class="stat"><div class="k">Items owned</div><div class="v">${rows.length}</div></div>
      <div class="stat"><div class="k">Best-case value</div><div class="v">${money(total)}</div></div>
      <div class="stat"><div class="k">Gold</div><div class="v">${money(playerGold())}</div></div>
    </div></div>
    <p class="explain">For each item: sell on your AH or the neutral AH, craft it into something (recipes you know), vendor it, or hold it if the forecast says it'll rise. Biggest value first.</p>
    ${list("stuff", valued, "Nothing worth more than 1g.", stuffCard)}
    ${small ? `<p class="explain">${small} more items worth under 1g each are hidden.</p>` : ""}`;
}

function viewArbitrage() {
  if (!H.mine()) {
    return noMarket();
  }
  return `
    <p class="explain">Price gaps between your faction's AH, the neutral AH (Booty Bay, Gadgetzan, Everlook) and the other faction. Includes the ${S.settings.factionCut}% faction cut and ${S.settings.neutralCut}% neutral cut. Cross-faction moves go through the neutral AH, where you can't buy your own account's listings, so they need a second account or a friend.</p>
    ${H.neutral() ? "" : '<p class="empty">No neutral auction house found in the data for this ruleset.</p>'}
    ${list("arb", arbitrage(), "No profitable gaps right now. Try a lower minimum profit or sales-per-day in settings.")}`;
}

function viewFlips() {
  if (!H.mine()) {
    return noMarket();
  }
  return `
    <p class="explain">Listings priced well below the item's typical price (median of daily prices, needs 2+ days of history) or far below the next listing. Buy, then relist. Profit counts only units the market should absorb within ${S.settings.horizon} days.</p>
    ${list("flips", flips(), "No flips right now. These need a couple of days of history, so check back.")}`;
}

function viewCrafts() {
  if (!H.mine()) {
    return noMarket();
  }
  const { picks, learnable } = crafts();
  const profs = [...playerProfs()];
  const scope = profs.length ? profs.join(", ") : "all professions (set yours on the Character tab)";
  return `
    <p class="explain">Craft with materials from the AH or a vendor (whichever's cheaper), using items you own first, then sell. Showing ${esc(scope)}${S.profile.knownOnly ? ", recipes you know only" : ""}. Profit counts your own materials at market value.</p>
    ${list("crafts", picks, "No profitable crafts with current prices.")}
    ${learnable.length ? `<h2 class="section">Worth learning</h2><p class="explain">Profitable recipes in your professions that you don't know yet.</p>${list("learn", learnable.map((l) => ({ ...l })), "", (l) => card(nameHtml(l.r.out), `${money(l.each)}<span class="sub"> /craft</span>`, `${esc(l.r.name)} · sells ${money(l.sell)}`, "", `<span class="chip">${esc(l.r.prof)}</span>${spdChip(l.out)}`))}` : ""}`;
}

function viewShuffles() {
  if (!H.mine()) {
    return noMarket();
  }
  return `
    <p class="explain">Chains of 2–3 crafts or conversions (smelt → transmute, split/combine essences, cloth → bolts → …) that make more than selling after the first step. Only recipes you can use.</p>
    ${list("shuffles", shuffles(), "No profitable chains right now.")}`;
}

function sparkline(points) {
  if (!points || points.length < 2) {
    return "";
  }
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys) - 0.5;
  const y1 = Math.max(...ys) + 0.5;
  const d = points
    .map((p, i) => `${i ? "L" : "M"}${(((p[0] - x0) / (x1 - x0 || 1)) * 300).toFixed(1)},${(44 - ((p[1] - y0) / (y1 - y0 || 1)) * 40).toFixed(1)}`)
    .join(" ");
  return `<svg class="spark" viewBox="0 0 300 46" preserveAspectRatio="none" aria-label="Progression index over time"><path d="${d}" fill="none" stroke="#e5b94e" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
}

function viewForecast() {
  const F = H.mine();
  if (!F) {
    return noMarket();
  }
  const pr = F.progression ?? {};
  const pop = S.meta.regions[S.region]?.population;
  const { up, down, all } = forecasts();
  if (S.forecastView === "up" && up.length === 0 && down.length > 0 && !S.forecastViewChosen) {
    S.forecastView = "down";
  }
  const tabs = [["up", `Stock up (${up.length})`], ["down", `Sell now (${down.length})`], ["tiers", "By tier"]];
  let body;
  if (S.forecastView === "up") {
    body = `<p class="explain">Expected to rise over the next week. Ranked by expected gain × longevity × confidence × how easily it sells.</p>${list("fc-up", up, "Nothing is forecast to rise more than 5%.", forecastCard)}`;
  } else if (S.forecastView === "down") {
    body = `<p class="explain">Expected to fall. If you're holding these, sell sooner rather than later. If you craft with them, waiting may cut your costs.</p>${list("fc-down", down, "Nothing is forecast to fall more than 5%.", forecastCard)}`;
  } else {
    body =
      [3, 2, 1, 0]
        .map((role) => {
          const rows = all.filter((x) => (x.r.role ?? 0) === role).sort((a, b) => (a.r.tier ?? 99) - (b.r.tier ?? 99) || a.chg7 - b.chg7);
          if (rows.length === 0) {
            return "";
          }
          return `<h2 class="section">${ROLE_NAMES[role]} (${rows.length})</h2>
            <div class="panel"><table class="prices"><tr><th>Item</th><th>Tier</th><th>Now</th><th>7d</th><th>Change</th></tr>
            ${rows.slice(0, 80).map((x) => `<tr><td>${nameHtml(x.key)}</td><td>${x.r.tier ?? "—"}</td><td>${money(x.r.market)}</td><td>${money(x.r.f7)}</td><td class="${x.chg7 >= 0 ? "pos" : "neg"}">${pct(x.chg7)}</td></tr>`).join("")}
            </table></div>`;
        })
        .join("") || '<p class="empty">No forecasts yet.</p>';
  }
  const popHtml = pop
    ? `<div class="stat"><div class="k">Sampled characters</div><div class="v">${pop.sampled}</div></div>
       <div class="stat"><div class="k">Median level</div><div class="v">${pop.median}</div></div>
       <div class="stat"><div class="k">At level 60</div><div class="v">${pop.pct60}%</div></div>`
    : "";
  const hist = pop?.hist ? `<div class="hist" title="Level distribution 1–60">${pop.hist.map((n) => `<span style="height:${(n / Math.max(...pop.hist)) * 100}%"></span>`).join("")}</div>` : "";
  return `
    <div class="panel">
      <div class="stats">
        <div class="stat"><div class="k">Progression index</div><div class="v">${pr.current ?? "—"}</div></div>
        <div class="stat"><div class="k">Population front (est. level)</div><div class="v">${pr.front != null ? Math.round(pr.front) : "—"}</div></div>
        ${popHtml}
      </div>
      ${sparkline(pr.history)}
      ${hist}
      <details class="how"><summary>How forecasts work</summary><p>${
        pr.frontSource === "population"
          ? "Front comes from sampled guild rosters. "
          : "Front is estimated from the auction house: the average tier of gathered materials on sale, which rises as players level up. "
      }Forecasts blend each item's own (damped) price trend with what its tier and role predict for a fresh economy: leveling materials fade once the population passes their level band, while endgame consumables hold up best. The weights are in <code>collector/data/curated.json</code>.</p></details>
    </div>
    <div class="seg">${tabs.map(([k, label]) => `<button data-fview="${k}" class="${S.forecastView === k ? "active" : ""}">${label}</button>`).join("")}</div>
    ${body}`;
}

function viewLookup() {
  const q = S.lookupQuery.trim().toLowerCase();
  const houses = [H.mine(), H.other(), H.neutral()].filter(Boolean);
  let results = [];
  if (q.length >= 2) {
    const keys = new Set();
    for (const h of houses) {
      for (const k of h.rows.keys()) {
        keys.add(k);
      }
    }
    results = [...keys].filter((k) => itemName(k).toLowerCase().includes(q) || String(k) === q).slice(0, 25);
  }
  const inv = inventory();
  const cardFor = (k) => {
    const id = itemIdOf(k);
    const makes = S.recipes.filter((r) => r.out === id);
    const uses = S.recipes.filter((r) => r.mats.some((m) => m[0] === id));
    const mine = H.mine()?.rows.get(k);
    return `
      <div class="card">
        <div class="row1"><span class="name">${nameHtml(k)}</span><span class="sub">${inv.get(id) ? `you have ${inv.get(id)} · ` : ""}#${esc(k)}</span></div>
        <div class="table-wrap"><table class="prices">
          <tr><th>AH</th><th>Lowest</th><th>Market</th><th>Typical</th><th>Qty</th><th>Sold/day</th></tr>
          ${houses
            .map((h) => {
              const r = h.rows.get(k);
              if (!r) {
                return `<tr><td>${factionLabel(h.faction)}</td><td colspan="5" class="sub">not listed</td></tr>`;
              }
              return `<tr><td>${factionLabel(h.faction)}</td><td>${money(r.min)}</td><td>${money(r.market)}</td><td>${money(r.base)}</td><td>${fmtNum(r.qty)}</td><td>${fmtNum(r.spd)}</td></tr>`;
            })
            .join("")}
        </table></div>
        ${mine?.f7 != null ? `<div class="sub" style="margin-top:6px">Forecast on your AH: 3d ${money(mine.f3)}, 7d ${money(mine.f7)} (${CONF_NAMES[mine.conf]} confidence, ${ROLE_NAMES[mine.role] ?? "unknown"})</div>` : ""}
        ${makes.length ? `<div class="sub">Made by: ${makes.map((r) => esc(r.name)).join(", ")}</div>` : ""}
        ${uses.length ? `<div class="sub">Used in: ${uses.slice(0, 8).map((r) => esc(r.name)).join(", ")}${uses.length > 8 ? "…" : ""}</div>` : ""}
      </div>`;
  };
  return `
    <input id="lookupInput" data-live="lookupQuery" class="search" type="search" placeholder="Search an item, e.g. Thorium" value="${esc(S.lookupQuery)}" autocomplete="off">
    ${q.length < 2 ? '<p class="empty">Type at least 2 letters.</p>' : results.length ? `<div class="cards">${results.map(cardFor).join("")}</div>` : '<p class="empty">No matching items on these auction houses.</p>'}`;
}

function viewCharacter() {
  const chars = importedChars();
  const keys = Object.keys(chars);
  const P = S.profile;
  const imported = P.imported;
  let charsHtml = "";
  if (keys.length) {
    const sel = `<label class="inline">Use data from <select data-action="active"><option value="all"${P.active === "all" ? " selected" : ""}>All characters</option>${keys.map((k) => `<option value="${esc(k)}"${P.active === k ? " selected" : ""}>${esc(k)}</option>`).join("")}</select></label>`;
    const cards = keys
      .map((k) => {
        const c = chars[k];
        const profs = Object.entries(c.p ?? {})
          .map(([name, [rank, max]]) => {
            const kn = c.k?.[name] ?? (name === "Mining" ? c.k?.Smelting : null);
            const count = kn && !Array.isArray(kn) ? Math.max((kn.i ?? []).length, (kn.r ?? []).length, (kn.s ?? []).length) : null;
            const known = count != null ? `${count} recipes` : "open window in-game";
            return `<span class="chip">${esc(name)} ${rank}/${max} · ${known}</span>`;
          })
          .join("");
        return card(
          esc(k),
          money(c.g),
          `${c.f ? esc(c.f) : ""}${c.l ? ` · level ${c.l}` : ""} · bags ${c.ts ? ago(c.ts) : "—"} · bank ${c.tb ? ago(c.tb) : "never scanned — open your bank"}`,
          "",
          profs || '<span class="chip">no professions</span>',
        );
      })
      .join("");
    charsHtml = `
      <div class="panel">
        <h2 class="section" style="margin-top:0">Your characters</h2>
        <p class="explain">Imported ${imported?.at ? ago(imported.at) : ""}. Re-import any time to refresh.</p>
        ${sel}
        <div class="cards" style="margin-top:8px">${cards}</div>
      </div>`;
  }

  // Manual items
  const mItems = Object.entries(P.manual.items ?? {});
  const iq = S.itemQuery.trim().toLowerCase();
  let suggestions = "";
  if (iq.length >= 2) {
    const matches = Object.entries(S.items)
      .filter(([, m]) => m[0].toLowerCase().includes(iq))
      .slice(0, 8);
    suggestions = matches.length
      ? `<div class="suggest">${matches.map(([id]) => `<button data-action="add-item" data-id="${id}">+ ${nameHtml(id)}</button>`).join("")}</div>`
      : '<p class="sub">No matching items.</p>';
  }

  // Manual recipes
  const profs = [...playerProfs()];
  const rq = S.recipeQuery.trim().toLowerCase();
  const recipeList = S.recipes
    .filter((r) => !r.anyone && (profs.length === 0 || profs.includes(r.prof)) && (!rq || r.name.toLowerCase().includes(rq) || (r.prof ?? "").toLowerCase().includes(rq)))
    .slice(0, 60);
  const ls7 = ledgerStats(7);
  const ls30 = ledgerStats(30);
  const hasLedger = (imported?.ledger ?? []).length > 0;

  return `
    <div class="panel">
      <h2 class="section" style="margin-top:0">Import from the addon</h2>
      <ol class="howto">
        <li>Download the <a href="Economancer-addon.zip" download>Economancer addon</a> and unzip it into <code>World of Warcraft/_forever_/Interface/AddOns</code> (or whichever folder your Forever client uses).</li>
        <li>Log in to each character. Open your bank and each profession window once so they're recorded. Opening your mailbox records auction sales.</li>
        <li>Type <code>/econ</code>, press Ctrl+C, and paste below.</li>
      </ol>
      <textarea id="importText" rows="3" placeholder="ECON1:{…}"></textarea>
      <div class="row-actions">
        <button class="btn primary" data-action="import">Import</button>
        ${hasImport() ? '<button class="btn" data-action="clear">Remove my data</button>' : ""}
      </div>
      <p id="importMsg" class="sub"></p>
      <p class="sub">Your data stays in this browser. Nothing is uploaded.</p>
    </div>
    ${charsHtml}
    <div class="panel">
      <h2 class="section" style="margin-top:0">Options</h2>
      <label class="check"><input type="checkbox" data-action="useGold" ${P.useGold ? "checked" : ""}> Use my gold as the budget</label>
      <label class="check"><input type="checkbox" data-action="knownOnly" ${P.knownOnly ? "checked" : ""}> Only suggest recipes I know</label>
      <label class="inline">Gold override <input type="number" min="0" step="1" data-action="gold" value="${P.manual.gold ?? ""}" placeholder="${hasImport() ? "from import" : "gold"}"></label>
      <p class="sub">Professions come from the import. Without one, set them in ⚙ settings.</p>
    </div>
    <div class="panel">
      <h2 class="section" style="margin-top:0">Items (manual)</h2>
      <p class="explain">Add things you own that the addon didn't record, e.g. on an alt without the addon.</p>
      <input class="search" type="search" data-live="itemQuery" id="itemSearch" placeholder="Search an item to add" value="${esc(S.itemQuery)}" autocomplete="off">
      ${suggestions}
      ${mItems.length ? `<div class="table-wrap"><table class="prices"><tr><th>Item</th><th>Qty</th><th></th></tr>${mItems.map(([id, n]) => `<tr><td>${nameHtml(id)}</td><td><input type="number" min="0" class="qty" data-action="item-qty" data-id="${id}" value="${n}"></td><td><button class="x" data-action="remove-item" data-id="${id}" aria-label="Remove">✕</button></td></tr>`).join("")}</table></div>` : ""}
    </div>
    <div class="panel">
      <h2 class="section" style="margin-top:0">Known recipes (manual)</h2>
      <p class="explain">The addon fills this in when you open a profession window. Tick recipes here to mark them known by hand. ${profs.length ? `Showing ${esc(profs.join(", "))}.` : "Showing all professions."}</p>
      <input class="search" type="search" data-live="recipeQuery" id="recipeSearch" placeholder="Filter recipes" value="${esc(S.recipeQuery)}" autocomplete="off">
      <div class="recipe-list">${recipeList
        .map((r) => {
          const st = recipeStatus(r);
          const manual = (P.manual.known ?? []).includes(recipeSig(r));
          return `<label class="check"><input type="checkbox" data-action="known" data-sig="${esc(recipeSig(r))}" ${st === "known" ? "checked" : ""} ${st === "known" && !manual ? "disabled" : ""}> ${esc(r.name)} <span class="sub">${esc(r.prof ?? "")}${st === "known" && !manual ? " · from addon" : ""}</span></label>`;
        })
        .join("") || '<p class="sub">No recipes match.</p>'}</div>
    </div>
    <div class="panel">
      <h2 class="section" style="margin-top:0">Profit tracking</h2>
      ${
        hasLedger
          ? `<div class="stats">
              <div class="stat"><div class="k">Net, 7 days</div><div class="v ${ls7.net >= 0 ? "pos" : "neg"}">${money(ls7.net)}</div></div>
              <div class="stat"><div class="k">Net, 30 days</div><div class="v ${ls30.net >= 0 ? "pos" : "neg"}">${money(ls30.net)}</div></div>
              <div class="stat"><div class="k">Sales (30d)</div><div class="v">${ls30.sales}</div></div>
              <div class="stat"><div class="k">AH cut paid (30d)</div><div class="v">${money(ls30.cut)}</div></div>
            </div>
            <p class="explain" style="margin-top:8px">Income is sales after the AH cut. Spending is everything you bought on the AH, including things for your own use.</p>
            <div class="table-wrap"><table class="prices"><tr><th>Item (30d)</th><th>Sold</th><th>Income</th><th>Spent</th><th>Net</th></tr>
            ${ls30.items.slice(0, 40).map((r) => { const id = idByName(r.name); return `<tr><td>${id ? nameHtml(id) : esc(r.name)}</td><td>${r.sold}</td><td>${money(r.income)}</td><td>${money(r.spent)}</td><td class="${r.net >= 0 ? "pos" : "neg"}">${money(r.net)}</td></tr>`; }).join("")}
            </table></div>`
          : '<p class="explain">The addon records auction sales and purchases from your mailbox invoices. Open your mailbox in-game, then re-import.</p>'
      }
    </div>`;
}

const VIEWS = {
  picks: viewPicks,
  plan: viewPlan,
  stuff: viewStuff,
  arbitrage: viewArbitrage,
  flips: viewFlips,
  crafts: viewCrafts,
  shuffles: viewShuffles,
  forecast: viewForecast,
  lookup: viewLookup,
  character: viewCharacter,
};

function renderStatus() {
  const el = document.getElementById("status");
  const parts = [];
  const F = H.mine();
  if (F) {
    parts.push(`${esc(F.name)} · snapshot ${ago(F.snap)} · ${F.auctions.toLocaleString()} auctions`);
    if (F.covHours < 12) {
      parts.push(`<span class="warn">sales estimates warming up (${F.covHours}h of data)</span>`);
    }
  }
  const rs = S.meta ? rulesetObj() : null;
  if (rs && rs.verified === false) {
    parts.push(`<span class="warn">ruleset label unverified (houses ${esc(rs.houseIds)}) — <a href="#lookup">check a price in-game</a></span>`);
  }
  if (hasImport()) {
    const ac = activeChars();
    parts.push(`using ${ac.length === 1 ? esc(ac[0][0]) : `${ac.length} characters`}`);
  }
  for (const e of S.meta?.errors ?? []) {
    parts.push(`<span class="err">${esc(e)}</span>`);
  }
  el.innerHTML = parts.join(" · ");
}

function render() {
  for (const b of document.querySelectorAll("#tabs button")) {
    b.classList.toggle("active", b.dataset.tab === S.tab);
  }
  for (const b of document.querySelectorAll(".faction button")) {
    b.setAttribute("aria-checked", String(b.dataset.faction === S.faction));
  }
  renderStatus();
  const view = document.getElementById("view");
  try {
    view.innerHTML = (VIEWS[S.tab] ?? viewPicks)();
  } catch (err) {
    console.error(err);
    view.innerHTML = `<p class="empty">Something went wrong: ${esc(err.message)}</p>`;
  }
}

// ---------- pickers & settings ----------
function fillPickers() {
  const regionSel = document.getElementById("region");
  const rsSel = document.getElementById("ruleset");
  const regions = Object.keys(S.meta.regions);
  regionSel.innerHTML = regions.map((r) => `<option value="${r}">${r.toUpperCase()}</option>`).join("");
  if (!regions.includes(S.region)) {
    S.region = regions[0];
  }
  regionSel.value = S.region;
  const rulesets = S.meta.regions[S.region]?.rulesets ?? [];
  rsSel.innerHTML = rulesets.map((r) => `<option value="${r.id}">${esc(r.name)}${r.verified === false ? " (?)" : ""}</option>`).join("");
  if (!rulesets.some((r) => String(r.id) === String(S.ruleset))) {
    S.ruleset = rulesets.find((r) => /normal/i.test(r.name))?.id ?? rulesets[0]?.id;
  }
  rsSel.value = S.ruleset;
}

async function changeMarket() {
  save("pick", { region: S.region, ruleset: S.ruleset, faction: S.faction });
  document.getElementById("view").innerHTML = '<p class="loading">Loading auction data…</p>';
  try {
    await loadMarket();
  } catch (err) {
    console.error(err);
  }
  render();
}

function openSettings() {
  const form = document.getElementById("settingsForm");
  for (const [k, v] of Object.entries(S.settings)) {
    if (form.elements[k] && k !== "profs") {
      form.elements[k].value = v;
    }
  }
  const profs = [...new Set(S.recipes.filter((r) => !r.anyone).map((r) => r.prof).filter(Boolean))].sort();
  document.getElementById("profList").innerHTML = profs
    .map((p) => `<label><input type="checkbox" name="prof" value="${esc(p)}" ${S.settings.profs?.includes(p) ? "checked" : ""}> ${esc(p)}</label>`)
    .join("");
  document.getElementById("profNote").textContent = hasImport() ? "Your imported characters' professions take priority over these." : "";
  document.getElementById("settings").showModal();
}

function saveSettings() {
  const form = document.getElementById("settingsForm");
  for (const k of Object.keys(DEFAULTS)) {
    if (k === "profs") {
      continue;
    }
    const v = Number(form.elements[k].value);
    if (isFinite(v) && form.elements[k].value !== "") {
      S.settings[k] = v;
    }
  }
  S.settings.profs = [...form.querySelectorAll('input[name="prof"]:checked')].map((i) => i.value);
  save("settings", S.settings);
  invalidate();
  render();
}

// ---------- character actions ----------
function applyImportedDefaults() {
  const ac = activeChars();
  if (ac.length === 0) {
    return false;
  }
  const [key, c] = ac[0];
  let changed = false;
  const f = (c.f ?? "").toLowerCase();
  if ((f === "alliance" || f === "horde") && f !== S.faction) {
    S.faction = f;
    changed = true;
  }
  const realm = key.split("-").slice(1).join("-").toLowerCase();
  const rs = (S.meta.regions[S.region]?.rulesets ?? []).find((r) => r.name.toLowerCase() === realm);
  if (rs && String(rs.id) !== String(S.ruleset)) {
    S.ruleset = rs.id;
    fillPickers();
    changed = true;
  }
  return changed;
}

async function onAction(el, event) {
  const a = el.dataset.action;
  const P = S.profile;
  if (a === "import") {
    const msg = document.getElementById("importMsg");
    try {
      const obj = parseExport(document.getElementById("importText").value);
      P.imported = obj;
      const keys = Object.keys(obj.chars);
      P.active = keys.length === 1 ? keys[0] : "all";
      saveProfile();
      const moved = applyImportedDefaults();
      if (moved) {
        await changeMarket();
      } else {
        render();
      }
      const m = document.getElementById("importMsg");
      if (m) {
        m.innerHTML = `<span class="pos">Imported ${keys.length} character${keys.length === 1 ? "" : "s"}.</span> <a href="#plan">See your plan →</a>`;
      }
    } catch (err) {
      msg.innerHTML = `<span class="neg">${esc(err.message)}</span>`;
    }
    return;
  }
  if (a === "clear") {
    if (event.type === "click") {
      resetProfile();
      render();
    }
    return;
  }
  if (a === "active") {
    P.active = el.value;
    saveProfile();
    if (applyImportedDefaults()) {
      await changeMarket();
    } else {
      render();
    }
    return;
  }
  if (a === "useGold" || a === "knownOnly") {
    P[a] = el.checked;
    saveProfile();
    render();
    return;
  }
  if (a === "gold") {
    P.manual.gold = el.value === "" ? null : Number(el.value);
    saveProfile();
    render();
    return;
  }
  if (a === "add-item") {
    P.manual.items[el.dataset.id] = (Number(P.manual.items[el.dataset.id]) || 0) + 1;
    S.itemQuery = "";
    saveProfile();
    render();
    return;
  }
  if (a === "remove-item") {
    delete P.manual.items[el.dataset.id];
    saveProfile();
    render();
    return;
  }
  if (a === "item-qty") {
    const n = Number(el.value);
    if (n > 0) {
      P.manual.items[el.dataset.id] = n;
    } else {
      delete P.manual.items[el.dataset.id];
    }
    saveProfile();
    render();
    return;
  }
  if (a === "known") {
    const set = new Set(P.manual.known ?? []);
    if (el.checked) {
      set.add(el.dataset.sig);
    } else {
      set.delete(el.dataset.sig);
    }
    P.manual.known = [...set];
    saveProfile();
    render();
  }
}

function bind() {
  document.getElementById("tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (b) {
      S.tab = b.dataset.tab;
      history.replaceState(null, "", `#${S.tab}`);
      render();
      b.scrollIntoView({ block: "nearest", inline: "center" });
    }
  });
  window.addEventListener("hashchange", () => {
    const t = location.hash.slice(1);
    if (VIEWS[t] && t !== S.tab) {
      S.tab = t;
      if (S.meta) {
        render();
        window.scrollTo({ top: 0 });
      }
    }
  });
  document.querySelector(".faction").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-faction]");
    if (b && b.dataset.faction !== S.faction) {
      S.faction = b.dataset.faction;
      changeMarket();
    }
  });
  document.getElementById("region").addEventListener("change", (e) => {
    S.region = e.target.value;
    fillPickers();
    changeMarket();
  });
  document.getElementById("ruleset").addEventListener("change", (e) => {
    S.ruleset = e.target.value;
    changeMarket();
  });
  const view = document.getElementById("view");
  view.addEventListener("click", (e) => {
    const more = e.target.closest("[data-more]");
    if (more) {
      onMore(more);
      return;
    }
    const go = e.target.closest("[data-goto]");
    if (go) {
      location.hash = go.dataset.goto;
      return;
    }
    const fv = e.target.closest("[data-fview]");
    if (fv) {
      S.forecastView = fv.dataset.fview;
      S.forecastViewChosen = true;
      render();
      return;
    }
    const act = e.target.closest("button[data-action]");
    if (act) {
      onAction(act, e);
    }
  });
  view.addEventListener("change", (e) => {
    const el = e.target.closest("input[data-action], select[data-action]");
    if (el) {
      onAction(el, e);
    }
  });
  // Live search inputs re-render but keep focus and caret.
  view.addEventListener("input", (e) => {
    const el = e.target.closest("input[data-live]");
    if (!el) {
      return;
    }
    S[el.dataset.live] = el.value;
    const pos = el.selectionStart;
    const id = el.id;
    render();
    const again = document.getElementById(id);
    if (again) {
      again.focus();
      again.setSelectionRange(pos, pos);
    }
  });
  document.getElementById("settingsBtn").addEventListener("click", openSettings);
  document.getElementById("settings").addEventListener("close", (e) => {
    if (e.target.returnValue === "save") {
      saveSettings();
    }
  });
}

async function init() {
  S.settings = { ...DEFAULTS, ...load("settings", {}) };
  loadProfile();
  const pick = load("pick", {});
  S.region = pick.region ?? null;
  S.ruleset = pick.ruleset ?? null;
  S.faction = pick.faction ?? "alliance";
  const hashTab = location.hash.slice(1);
  if (VIEWS[hashTab]) {
    S.tab = hashTab;
  } else if (hasImport()) {
    S.tab = "plan";
  }
  bind();
  try {
    const [meta, items, recipes] = await Promise.all([
      fetchJson("data/meta.json"),
      fetchJson("data/items.json").catch(() => ({})),
      fetchJson("data/recipes.json").catch(() => []),
    ]);
    S.meta = meta;
    S.items = items;
    S.recipes = recipes;
  } catch (err) {
    document.getElementById("view").innerHTML = `<p class="empty">No data published yet. The hourly collector hasn't finished a run. (${esc(err.message)})</p>`;
    return;
  }
  if (Object.keys(S.meta.regions ?? {}).length === 0) {
    renderStatus();
    if (S.tab === "character") {
      render();
      return;
    }
    document.getElementById("view").innerHTML = '<p class="empty">No auction data yet. See the errors above. Once the collector runs with valid Blizzard API credentials, data appears here within the hour. You can already set up your character on the <a href="#character">Character</a> tab.</p>';
    return;
  }
  fillPickers();
  await changeMarket();
}

init();
