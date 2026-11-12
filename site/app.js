// Economancer — static frontend. All recommendations are computed in the browser
// from the hourly JSON the collector publishes under data/.

const ROLE_NAMES = ["Unknown", "Leveling", "Endgame crafting", "Endgame consumable"];
const CONF_NAMES = ["low", "medium", "high"];
const DEFAULTS = {
  factionCut: 5,
  neutralCut: 15,
  minSpd: 1,
  horizon: 2,
  minProfit: 1,
  flipDiscount: 20,
  budget: 0,
  profs: [],
};
const PAGE = 30;

const S = {
  meta: null,
  items: {},
  recipes: [],
  settings: { ...DEFAULTS },
  region: null,
  ruleset: null,
  faction: "alliance",
  tab: "picks",
  houses: {},
  houseCache: new Map(),
  lists: new Map(),
  lookupQuery: "",
  forecastView: "up",
};

// ---------- storage (best effort) ----------
function load(key, fallback) {
  try {
    const v = localStorage.getItem(`fg:${key}`);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(`fg:${key}`, JSON.stringify(value));
  } catch {
    // storage unavailable (private mode, embedded view): settings just won't persist
  }
}

// ---------- formatting ----------
function esc(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

function money(copper) {
  if (copper == null || !isFinite(copper)) {
    return '<span class="money">—</span>';
  }
  const neg = copper < 0;
  let c = Math.round(Math.abs(copper));
  const g = Math.floor(c / 10000);
  const s = Math.floor((c % 10000) / 100);
  c = c % 100;
  let out;
  if (g >= 100) {
    out = `<span class="g">${g.toLocaleString()}g</span>`;
  } else if (g > 0) {
    out = `<span class="g">${g}g</span> <span class="s">${s}s</span>`;
  } else if (s > 0) {
    out = `<span class="s">${s}s</span> <span class="c">${c}c</span>`;
  } else {
    out = `<span class="c">${c}c</span>`;
  }
  return `<span class="money">${neg ? "−" : ""}${out}</span>`;
}

function pct(x, digits = 0) {
  if (x == null || !isFinite(x)) {
    return "—";
  }
  const v = (x * 100).toFixed(digits);
  return `${x > 0 ? "+" : ""}${v}%`;
}

function ago(epochSec) {
  const m = Math.round((Date.now() / 1000 - epochSec) / 60);
  if (m < 1) {
    return "just now";
  }
  if (m < 90) {
    return `${m} min ago`;
  }
  return `${Math.round(m / 60)} h ago`;
}

function fmtNum(n) {
  if (n == null) {
    return "—";
  }
  return n >= 100 ? Math.round(n).toLocaleString() : String(Math.round(n * 10) / 10);
}

// ---------- items ----------
function itemIdOf(key) {
  return Number(String(key).split(":")[0]);
}
function itemName(key) {
  const id = itemIdOf(key);
  const meta = S.items[id];
  const base = meta ? meta[0] : `Item #${id}`;
  const variant = String(key).includes(":") ? ` (variant ${String(key).split(":")[1]})` : "";
  return base + variant;
}
function nameHtml(key) {
  const meta = S.items[itemIdOf(key)];
  const q = meta ? meta[1] : "COMMON";
  return `<span class="q-${esc(q)}">${esc(itemName(key))}</span>`;
}
function vendorPrice(id) {
  if (!S.meta?.vendorItems?.includes(id)) {
    return null;
  }
  const meta = S.items[id];
  return meta && meta[3] > 0 ? meta[3] : null;
}

// ---------- house data ----------
function parseHouse(json) {
  const idx = Object.fromEntries(json.cols.map((c, i) => [c, i]));
  const rows = new Map();
  for (const r of json.rows) {
    const flat = r[idx.levels] ?? [];
    const levels = [];
    for (let i = 0; i < flat.length; i += 2) {
      levels.push([flat[i], flat[i + 1]]);
    }
    rows.set(r[idx.key], {
      key: r[idx.key],
      min: r[idx.min],
      market: r[idx.market],
      qty: r[idx.qty],
      n: r[idx.n],
      levels,
      base: r[idx.base],
      histDays: r[idx.histDays],
      spd: r[idx.spd],
      f3: r[idx.f3],
      f7: r[idx.f7],
      conf: r[idx.conf],
      lon: r[idx.lon],
      role: r[idx.role],
      tier: r[idx.tier],
      trend: r[idx.trend],
    });
  }
  return { ...json, rows };
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) {
    throw new Error(`${url}: ${res.status}`);
  }
  return res.json();
}

async function loadHouse(file) {
  if (!S.houseCache.has(file)) {
    S.houseCache.set(file, fetchJson(file).then(parseHouse));
  }
  return S.houseCache.get(file);
}

function rulesetObj() {
  return S.meta.regions[S.region]?.rulesets.find((r) => String(r.id) === String(S.ruleset));
}

async function loadMarket() {
  const rs = rulesetObj();
  S.houses = {};
  if (!rs) {
    return;
  }
  const jobs = rs.houses.map(async (h) => {
    S.houses[h.faction] = await loadHouse(h.file);
  });
  await Promise.all(jobs);
}

const H = {
  mine: () => S.houses[S.faction],
  other: () => S.houses[S.faction === "alliance" ? "horde" : "alliance"],
  neutral: () => S.houses.neutral,
};

// ---------- pricing helpers ----------
function fees() {
  return { fc: S.settings.factionCut / 100, nc: S.settings.neutralCut / 100 };
}
function budgetCopper() {
  return S.settings.budget > 0 ? S.settings.budget * 10000 : Infinity;
}
function demandCap(row) {
  if (!row || row.spd == null) {
    return null;
  }
  return Math.max(1, Math.floor(row.spd * S.settings.horizon));
}
/** Realistic resale price: current lowest listing, but not wildly above typical. */
function sellRef(row) {
  if (!row) {
    return null;
  }
  if (row.base && row.histDays >= 1) {
    return Math.min(row.min, Math.round(row.base * 1.5));
  }
  return row.min;
}
function unitCost(house, id) {
  const v = vendorPrice(id);
  const row = house?.rows.get(String(id));
  const ah = row ? row.market : null;
  if (v != null && ah != null) {
    return Math.min(v, ah);
  }
  return v ?? ah;
}
/** Walk price levels buying everything at or under maxPrice. */
function buyLevels(levels, maxPrice, capUnits, capCost) {
  let units = 0;
  let cost = 0;
  for (const [p, q] of levels) {
    if (p > maxPrice) {
      break;
    }
    let take = Math.min(q, capUnits - units);
    take = Math.min(take, Math.floor((capCost - cost) / p));
    if (take <= 0) {
      break;
    }
    units += take;
    cost += take * p;
  }
  return { units, cost };
}
function spdChip(row, label = "sells") {
  if (!row || row.spd == null) {
    return '<span class="chip warn">no sales data yet</span>';
  }
  const cls = row.spd >= S.settings.minSpd ? "" : "warn";
  return `<span class="chip ${cls}">${label} ~${fmtNum(row.spd)}/day</span>`;
}
function factionLabel(f) {
  return { alliance: "Alliance", horde: "Horde", neutral: "Neutral" }[f] ?? f;
}
function houseChip(f) {
  return `<span class="chip ${f}">${factionLabel(f)} AH</span>`;
}
function rankWeight(row) {
  if (!row || row.spd == null) {
    return 0.5;
  }
  return row.spd >= S.settings.minSpd ? 1 : 0.25;
}

// ---------- strategies ----------
function arbitrage() {
  const F = H.mine();
  const N = H.neutral();
  const O = H.other();
  const { fc, nc } = fees();
  const minProfit = S.settings.minProfit * 10000;
  const picks = [];

  function route(key, buyHouse, buyRow, sellHouse, sellRow, sellCut, transferFee, label) {
    const sell = sellRef(sellRow);
    if (!sell || !buyRow.levels.length) {
      return;
    }
    if (sellRow.spd != null && sellRow.spd < S.settings.minSpd) {
      return;
    }
    const sellNet = sell * (1 - sellCut);
    const maxBuy = Math.floor(sellNet / (1 + transferFee)) - 1;
    const cap = demandCap(sellRow) ?? 5;
    const { units, cost } = buyLevels(buyRow.levels, maxBuy, cap, budgetCopper() / (1 + transferFee));
    if (units <= 0) {
      return;
    }
    const totalCost = cost * (1 + transferFee);
    const profit = units * sellNet - totalCost;
    const roi = profit / totalCost;
    if (profit < minProfit || roi < 0.08) {
      return;
    }
    picks.push({
      kind: "arb",
      key,
      profit,
      score: profit * rankWeight(sellRow),
      invest: cost,
      html: () => `
        <div class="card">
          <div class="row1"><span class="name">${nameHtml(key)}</span><span class="profit pos">${money(profit)}</span></div>
          <div class="sub">Buy ${units}× on ${factionLabel(buyHouse.faction)} for ${money(cost / units)} each, sell on ${factionLabel(sellHouse.faction)} at ${money(sell)}</div>
          <div class="chips">
            <span class="chip">${esc(label)}</span>
            <span class="chip good">ROI ${pct(roi)}</span>
            <span class="chip">invest ${money(cost)}</span>
            ${spdChip(sellRow)}
            ${transferFee > 0 ? '<span class="chip warn">needs an alt on a 2nd account</span>' : ""}
          </div>
        </div>`,
    });
  }

  if (F && N) {
    for (const [k, n] of N.rows) {
      const f = F.rows.get(k);
      if (f) {
        route(k, N, n, F, f, fc, 0, "Neutral → faction");
        route(k, F, f, N, n, nc, 0, "Faction → Neutral");
      }
    }
  }
  if (F && O) {
    for (const [k, o] of O.rows) {
      const f = F.rows.get(k);
      if (f) {
        route(k, O, o, F, f, fc, nc, "Cross-faction via Neutral");
      }
    }
  }
  return picks.sort((a, b) => b.score - a.score);
}

function flips() {
  const F = H.mine();
  if (!F) {
    return [];
  }
  const { fc } = fees();
  const minProfit = S.settings.minProfit * 10000;
  const disc = S.settings.flipDiscount / 100;
  const picks = [];
  for (const [k, r] of F.rows) {
    if (!r.levels.length) {
      continue;
    }
    if (r.spd != null && r.spd < S.settings.minSpd) {
      continue;
    }
    const cap = demandCap(r) ?? 3;
    let best = null;
    if (r.base && r.histDays >= 2) {
      const { units, cost } = buyLevels(r.levels, r.base * (1 - disc), cap, budgetCopper());
      if (units > 0) {
        const profit = units * r.base * (1 - fc) - cost;
        best = { units, cost, profit, sell: r.base, why: `below its typical ${money(r.base)}` };
      }
    }
    if (r.levels.length >= 2) {
      const [p0, q0] = r.levels[0];
      const p1 = r.levels[1][0];
      if (p1 >= p0 * 1.25) {
        let sell = p1 - 1;
        if (r.base) {
          sell = Math.min(sell, Math.round(r.base * 1.3));
        }
        const units = Math.min(q0, cap, Math.floor(budgetCopper() / p0));
        const profit = units * sell * (1 - fc) - units * p0;
        if (units > 0 && (!best || profit > best.profit)) {
          best = { units, cost: units * p0, profit, sell, why: `next listing is ${pct(p1 / p0 - 1)} higher` };
        }
      }
    }
    if (!best || best.profit < minProfit || best.profit / best.cost < 0.1) {
      continue;
    }
    const b = best;
    picks.push({
      kind: "flip",
      key: k,
      profit: b.profit,
      score: b.profit * rankWeight(r),
      invest: b.cost,
      html: () => `
        <div class="card">
          <div class="row1"><span class="name">${nameHtml(k)}</span><span class="profit pos">${money(b.profit)}</span></div>
          <div class="sub">Buy ${b.units}× at up to ${money(b.cost / b.units)} avg, relist at ${money(b.sell)} — ${b.why}</div>
          <div class="chips">
            <span class="chip good">ROI ${pct(b.profit / b.cost)}</span>
            <span class="chip">invest ${money(b.cost)}</span>
            ${spdChip(r)}
            <span class="chip">${r.histDays}d history</span>
          </div>
        </div>`,
    });
  }
  return picks.sort((a, b) => b.score - a.score);
}

function profFilter(r) {
  const profs = S.settings.profs;
  return !profs || profs.length === 0 || profs.includes(r.prof);
}

function craftCost(F, r, exclude) {
  let cost = 0;
  const parts = [];
  for (const [id, q] of r.mats) {
    if (id === exclude) {
      continue;
    }
    const u = unitCost(F, id);
    if (u == null) {
      return null;
    }
    cost += u * q;
    parts.push([id, q, u]);
  }
  return { cost, parts };
}

function crafts() {
  const F = H.mine();
  if (!F) {
    return [];
  }
  const { fc } = fees();
  const minProfit = S.settings.minProfit * 10000;
  const picks = [];
  for (const r of S.recipes) {
    if (!profFilter(r)) {
      continue;
    }
    const out = F.rows.get(String(r.out));
    const sell = sellRef(out);
    if (!sell) {
      continue;
    }
    if (out.spd != null && out.spd < S.settings.minSpd) {
      continue;
    }
    const cc = craftCost(F, r);
    if (!cc || cc.cost <= 0) {
      continue;
    }
    const revenue = sell * r.outQty * (1 - fc);
    const each = revenue - cc.cost;
    if (each <= 0) {
      continue;
    }
    let n = out.spd != null ? Math.max(1, Math.floor((out.spd * S.settings.horizon) / r.outQty)) : 1;
    n = Math.min(n, 50, Math.max(1, Math.floor(budgetCopper() / cc.cost)));
    if (r.cd) {
      n = 1;
    }
    const profit = each * n;
    if (profit < minProfit || each / cc.cost < 0.05) {
      continue;
    }
    // Forecast: same craft priced with 7-day forecasts where available.
    let each7 = null;
    if (out.f7) {
      let c7 = 0;
      let ok = true;
      for (const [id, q] of r.mats) {
        const m = F.rows.get(String(id));
        const u = vendorPrice(id) ?? m?.f7 ?? unitCost(F, id);
        if (u == null) {
          ok = false;
          break;
        }
        c7 += u * q;
      }
      if (ok) {
        each7 = out.f7 * r.outQty * (1 - fc) - c7;
      }
    }
    picks.push({
      kind: "craft",
      key: String(r.out),
      profit,
      score: profit * rankWeight(out),
      invest: cc.cost * n,
      html: () => `
        <div class="card">
          <div class="row1"><span class="name">${nameHtml(r.out)}${r.outQty !== 1 ? ` ×${r.outQty}` : ""}</span><span class="profit pos">${money(each)}<span class="sub"> /craft</span></span></div>
          <div class="sub">${esc(r.name)} · costs ${money(cc.cost)} · sells ${money(sell)}${n > 1 ? ` · make ${n} ≈ ${money(profit)}` : ""}</div>
          <ul class="steps">${cc.parts.map(([id, q, u]) => `<li>${q}× ${nameHtml(id)} @ ${money(u)}${vendorPrice(id) != null && u === vendorPrice(id) ? " (vendor)" : ""}</li>`).join("")}</ul>
          <div class="chips">
            <span class="chip">${esc(r.prof ?? "")}</span>
            <span class="chip good">margin ${pct(each / cc.cost)}</span>
            ${spdChip(out)}
            ${r.cd ? '<span class="chip warn">cooldown</span>' : ""}
            ${r.note ? `<span class="chip warn">${esc(r.note)}</span>` : ""}
            ${r.src === "curated" ? '<span class="chip">classic recipe, verify</span>' : ""}
            ${each7 != null ? `<span class="chip ${each7 >= each ? "good" : "bad"}">7-day forecast ${money(each7)}/craft</span>` : ""}
          </div>
        </div>`,
    });
  }
  return picks.sort((a, b) => b.score - a.score);
}

function shuffles() {
  const F = H.mine();
  if (!F) {
    return [];
  }
  const { fc } = fees();
  const minProfit = S.settings.minProfit * 10000;
  const byMat = new Map();
  for (const r of S.recipes) {
    if (!profFilter(r)) {
      continue;
    }
    for (const [id] of r.mats) {
      if (!byMat.has(id)) {
        byMat.set(id, []);
      }
      byMat.get(id).push(r);
    }
  }
  const sellNet = (id) => {
    const row = F.rows.get(String(id));
    if (!row || (row.spd != null && row.spd < S.settings.minSpd)) {
      return null;
    }
    const s = sellRef(row);
    return s ? s * (1 - fc) : null;
  };
  const results = [];

  function dfs(chain, item, qty, cost, visited, firstSell) {
    if (chain.length >= 3) {
      return;
    }
    for (const r of byMat.get(item) ?? []) {
      if (visited.has(r.out)) {
        continue;
      }
      const need = r.mats.find((m) => m[0] === item)[1];
      const n = qty / need;
      const other = craftCost(F, r, item);
      if (!other) {
        continue;
      }
      const newCost = cost + other.cost * n;
      const outQty = r.outQty * n;
      const step = { r, n };
      const next = [...chain, step];
      const sn = sellNet(r.out);
      if (sn != null) {
        const profit = outQty * sn - newCost;
        results.push({ chain: next, profit, cost: newCost, out: r.out, outQty, gainVsFirst: profit - firstSell });
      }
      const v = new Set(visited);
      v.add(r.out);
      dfs(next, r.out, outQty, newCost, v, firstSell);
    }
  }

  for (const r1 of S.recipes) {
    if (!profFilter(r1)) {
      continue;
    }
    const cc = craftCost(F, r1);
    if (!cc || cc.cost <= 0) {
      continue;
    }
    const sn = sellNet(r1.out);
    const firstSell = sn != null ? sn * r1.outQty - cc.cost : -Infinity;
    const visited = new Set(r1.mats.map((m) => m[0]));
    visited.add(r1.out);
    dfs([{ r: r1, n: 1 }], r1.out, r1.outQty, cc.cost, visited, firstSell);
  }

  const best = new Map();
  for (const res of results) {
    if (res.profit <= 0 || res.gainVsFirst <= 0 || res.cost <= 0) {
      continue;
    }
    const sig = res.chain.map((s) => s.r.name).join(">");
    if (!best.has(sig) || best.get(sig).profit < res.profit) {
      best.set(sig, res);
    }
  }
  const picks = [];
  for (const res of best.values()) {
    const outRow = F.rows.get(String(res.out));
    let batches = outRow?.spd != null ? Math.max(1, Math.floor((outRow.spd * S.settings.horizon) / res.outQty)) : 1;
    batches = Math.min(batches, 50, Math.max(1, Math.floor(budgetCopper() / res.cost)));
    if (res.chain.some((s) => s.r.cd)) {
      batches = 1;
    }
    const profit = res.profit * batches;
    if (profit < minProfit) {
      continue;
    }
    picks.push({
      kind: "shuffle",
      key: String(res.out),
      profit,
      score: profit * rankWeight(outRow),
      invest: res.cost * batches,
      html: () => `
        <div class="card">
          <div class="row1"><span class="name wrap">${res.chain.map((s) => esc(s.r.name)).join(" → ")}</span><span class="profit pos">${money(res.profit)}<span class="sub"> /batch</span></span></div>
          <div class="sub">End with ${fmtNum(res.outQty)}× ${nameHtml(res.out)} · batch costs ${money(res.cost)} · ${isFinite(res.gainVsFirst) ? `${money(res.gainVsFirst)} more than selling after step 1` : "step 1's output doesn't sell on the AH"}</div>
          <ol class="steps">${res.chain.map((s) => `<li>${fmtNum(s.n)}× ${esc(s.r.name)} <span class="sub">(${s.r.mats.map(([id, q]) => `${q} ${esc(itemName(id))}`).join(", ")})</span></li>`).join("")}</ol>
          <div class="chips">
            <span class="chip good">ROI ${pct(res.profit / res.cost)}</span>
            ${batches > 1 ? `<span class="chip">${batches} batches ≈ ${money(profit)}</span>` : ""}
            ${spdChip(outRow, "end item sells")}
            ${res.chain.some((s) => s.r.cd) ? '<span class="chip warn">has cooldown</span>' : ""}
          </div>
        </div>`,
    });
  }
  return picks.sort((a, b) => b.score - a.score);
}

function forecasts() {
  const F = H.mine();
  if (!F) {
    return { up: [], down: [], all: [] };
  }
  const all = [];
  for (const [k, r] of F.rows) {
    if (r.f7 == null || !r.market) {
      continue;
    }
    const chg7 = r.f7 / r.market - 1;
    const chg3 = r.f3 / r.market - 1;
    all.push({ key: k, r, chg7, chg3 });
  }
  const liq = (r) => Math.log1p(r.spd ?? Math.min(r.qty, 20) / 4);
  const up = all
    .filter((x) => x.chg7 >= 0.05)
    .map((x) => ({ ...x, score: x.chg7 * ((x.r.lon ?? 30) / 100) * (x.r.conf + 1) * liq(x.r) }))
    .sort((a, b) => b.score - a.score);
  const down = all
    .filter((x) => x.chg7 <= -0.05)
    .map((x) => ({ ...x, score: -x.chg7 * (x.r.conf + 1) * Math.log1p(x.r.qty) }))
    .sort((a, b) => b.score - a.score);
  return { up, down, all };
}

function forecastCard(x) {
  const r = x.r;
  const conf = CONF_NAMES[r.conf] ?? "low";
  return `
    <div class="card">
      <div class="row1"><span class="name">${nameHtml(x.key)}</span><span class="profit ${x.chg7 >= 0 ? "pos" : "neg"}">${pct(x.chg7)}</span></div>
      <div class="sub">Now ${money(r.market)} → 3d ${money(r.f3)} → 7d ${money(r.f7)}</div>
      <div class="chips">
        <span class="chip">${ROLE_NAMES[r.role] ?? "Unknown"}${r.tier ? ` · tier ${r.tier}` : ""}</span>
        <span class="chip ${r.conf >= 2 ? "good" : r.conf === 1 ? "" : "warn"}">${conf} confidence</span>
        <span class="chip">longevity <span class="bar"><i style="width:${r.lon ?? 0}%"></i></span></span>
        ${r.trend != null ? `<span class="chip">trend ${pct(Math.exp(r.trend) - 1, 1)}/day</span>` : ""}
        ${spdChip(r)}
      </div>
    </div>`;
}

// ---------- rendering ----------
function list(id, picks, empty) {
  S.lists.set(id, { picks, shown: PAGE });
  if (picks.length === 0) {
    return `<p class="empty">${empty}</p>`;
  }
  const first = picks.slice(0, PAGE).map((p) => (p.html ? p.html() : forecastCard(p))).join("");
  const more = picks.length > PAGE ? `<button class="more" data-more="${id}">Show more (${picks.length - PAGE} left)</button>` : "";
  return `<div class="cards" id="list-${id}">${first}</div>${more}`;
}

function onMore(btn) {
  const id = btn.dataset.more;
  const L = S.lists.get(id);
  const next = L.picks.slice(L.shown, L.shown + PAGE);
  L.shown += next.length;
  document.getElementById(`list-${id}`).insertAdjacentHTML("beforeend", next.map((p) => (p.html ? p.html() : forecastCard(p))).join(""));
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

function viewPicks() {
  if (!H.mine()) {
    return noMarket();
  }
  const sections = [
    ["Arbitrage", arbitrage().slice(0, 3), "arbitrage"],
    ["Flips", flips().slice(0, 3), "flips"],
    ["Crafts", crafts().slice(0, 3), "crafts"],
    ["Shuffles", shuffles().slice(0, 2), "shuffles"],
    ["Stock up before prices rise", forecasts().up.slice(0, 3), "forecast"],
  ];
  return `
    <p class="explain">The best few ideas from each strategy for <b>${esc(rulesetObj()?.name ?? "")} · ${factionLabel(S.faction)}</b>, ranked by expected profit within your sell horizon (${S.settings.horizon} days)${S.settings.budget > 0 ? ` and budget (${S.settings.budget}g)` : ""}.</p>
    ${sections
      .map(([title, picks, tab]) => `
        <h2 class="section">${title}</h2>
        ${list(`pick-${tab}`, picks, "Nothing worth doing right now.")}
        ${picks.length ? `<button class="more" data-goto="${tab}">See all ${title.toLowerCase()}</button>` : ""}`)
      .join("")}`;
}

function viewArbitrage() {
  if (!H.mine()) {
    return noMarket();
  }
  const hasN = !!H.neutral();
  return `
    <p class="explain">Price gaps between your faction's AH, the neutral AH (Booty Bay, Gadgetzan, Everlook) and the other faction. Includes the ${S.settings.factionCut}% faction cut and ${S.settings.neutralCut}% neutral cut. Cross-faction moves go through the neutral AH, where you can't buy your own account's listings, so they need a second account or a friend.</p>
    ${hasN ? "" : '<p class="empty">No neutral auction house found in the data for this ruleset.</p>'}
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
  const profs = S.settings.profs?.length ? S.settings.profs.join(", ") : "all professions";
  return `
    <p class="explain">Craft with materials bought on the AH (or from a vendor when cheaper) and sell the result. Showing ${esc(profs)} — change this in ⚙ settings. Recipes come from the Blizzard API (${S.meta.recipeApiCount ?? 0}) plus a hand-made list of classic recipes.</p>
    ${list("crafts", crafts(), "No profitable crafts with current prices.")}`;
}

function viewShuffles() {
  if (!H.mine()) {
    return noMarket();
  }
  return `
    <p class="explain">Chains of 2–3 crafts or conversions (smelt → transmute, split/combine essences, cloth → bolts → …) that make more than selling after the first step.</p>
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
  const tabs = [
    ["up", `Stock up (${up.length})`],
    ["down", `Sell now (${down.length})`],
    ["tiers", "By tier"],
  ];
  let body;
  if (S.forecastView === "up") {
    body = `<p class="explain">Expected to rise over the next week. Ranked by expected gain × longevity × confidence × how easily it sells.</p>${list("fc-up", up, "Nothing is forecast to rise more than 5%.")}`;
  } else if (S.forecastView === "down") {
    body = `<p class="explain">Expected to fall. If you're holding these, sell sooner rather than later. If you craft with them, waiting may cut your costs.</p>${list("fc-down", down, "Nothing is forecast to fall more than 5%.")}`;
  } else {
    const groups = [3, 2, 1, 0].map((role) => {
      const rows = all.filter((x) => (x.r.role ?? 0) === role).sort((a, b) => (a.r.tier ?? 99) - (b.r.tier ?? 99) || a.chg7 - b.chg7);
      if (rows.length === 0) {
        return "";
      }
      return `
        <h2 class="section">${ROLE_NAMES[role]} (${rows.length})</h2>
        <div class="panel"><table class="prices">
          <tr><th>Item</th><th>Tier</th><th>Now</th><th>7d</th><th>Change</th></tr>
          ${rows.slice(0, 80).map((x) => `<tr><td>${nameHtml(x.key)}</td><td>${x.r.tier ?? "—"}</td><td>${money(x.r.market)}</td><td>${money(x.r.f7)}</td><td class="${x.chg7 >= 0 ? "pos" : "neg"}">${pct(x.chg7)}</td></tr>`).join("")}
        </table></div>`;
    });
    body = groups.join("") || '<p class="empty">No forecasts yet.</p>';
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
  const houses = [["mine", H.mine()], ["other", H.other()], ["neutral", H.neutral()]].filter(([, h]) => h);
  let results = [];
  if (q.length >= 2) {
    const keys = new Set();
    for (const [, h] of houses) {
      for (const k of h.rows.keys()) {
        keys.add(k);
      }
    }
    results = [...keys].filter((k) => itemName(k).toLowerCase().includes(q) || String(k) === q).slice(0, 25);
  }
  const card = (k) => {
    const id = itemIdOf(k);
    const makes = S.recipes.filter((r) => r.out === id);
    const uses = S.recipes.filter((r) => r.mats.some((m) => m[0] === id));
    const mine = H.mine()?.rows.get(k);
    return `
      <div class="card">
        <div class="row1"><span class="name">${nameHtml(k)}</span><span class="sub">#${esc(k)}</span></div>
        <table class="prices">
          <tr><th>AH</th><th>Lowest</th><th>Market</th><th>Typical</th><th>Qty</th><th>Sold/day</th></tr>
          ${houses
            .map(([, h]) => {
              const r = h.rows.get(k);
              if (!r) {
                return `<tr><td>${factionLabel(h.faction)}</td><td colspan="5" class="sub">not listed</td></tr>`;
              }
              return `<tr><td>${factionLabel(h.faction)}</td><td>${money(r.min)}</td><td>${money(r.market)}</td><td>${money(r.base)}</td><td>${fmtNum(r.qty)}</td><td>${fmtNum(r.spd)}</td></tr>`;
            })
            .join("")}
        </table>
        ${mine?.f7 != null ? `<div class="sub" style="margin-top:6px">Forecast on your AH: 3d ${money(mine.f3)}, 7d ${money(mine.f7)} (${CONF_NAMES[mine.conf]} confidence, ${ROLE_NAMES[mine.role] ?? "unknown"})</div>` : ""}
        ${makes.length ? `<div class="sub">Made by: ${makes.map((r) => esc(r.name)).join(", ")}</div>` : ""}
        ${uses.length ? `<div class="sub">Used in: ${uses.slice(0, 8).map((r) => esc(r.name)).join(", ")}${uses.length > 8 ? "…" : ""}</div>` : ""}
      </div>`;
  };
  return `
    <input id="lookupInput" class="search" type="search" placeholder="Search an item, e.g. Thorium" value="${esc(S.lookupQuery)}" autocomplete="off">
    ${q.length < 2 ? '<p class="empty">Type at least 2 letters.</p>' : results.length ? `<div class="cards">${results.map(card).join("")}</div>` : '<p class="empty">No matching items on these auction houses.</p>'}`;
}

const VIEWS = {
  picks: viewPicks,
  arbitrage: viewArbitrage,
  flips: viewFlips,
  crafts: viewCrafts,
  shuffles: viewShuffles,
  forecast: viewForecast,
  lookup: viewLookup,
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
  if (S.tab === "lookup") {
    const input = document.getElementById("lookupInput");
    input.addEventListener("input", () => {
      S.lookupQuery = input.value;
      const pos = input.selectionStart;
      render();
      const again = document.getElementById("lookupInput");
      again.focus();
      again.setSelectionRange(pos, pos);
    });
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
  rsSel.innerHTML = rulesets.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join("");
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
  const profs = [...new Set(S.recipes.map((r) => r.prof).filter(Boolean))].sort();
  document.getElementById("profList").innerHTML = profs
    .map((p) => `<label><input type="checkbox" name="prof" value="${esc(p)}" ${S.settings.profs?.includes(p) ? "checked" : ""}> ${esc(p)}</label>`)
    .join("");
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
  render();
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
  document.getElementById("view").addEventListener("click", (e) => {
    const more = e.target.closest("[data-more]");
    if (more) {
      onMore(more);
      return;
    }
    const go = e.target.closest("[data-goto]");
    if (go) {
      S.tab = go.dataset.goto;
      history.replaceState(null, "", `#${S.tab}`);
      render();
      window.scrollTo({ top: 0 });
      return;
    }
    const fv = e.target.closest("[data-fview]");
    if (fv) {
      S.forecastView = fv.dataset.fview;
      render();
    }
  });
  window.addEventListener("hashchange", () => {
    const t = location.hash.slice(1);
    if (VIEWS[t] && t !== S.tab) {
      S.tab = t;
      if (S.meta) {
        render();
      }
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
  const pick = load("pick", {});
  S.region = pick.region ?? null;
  S.ruleset = pick.ruleset ?? null;
  S.faction = pick.faction ?? "alliance";
  const hashTab = location.hash.slice(1);
  if (VIEWS[hashTab]) {
    S.tab = hashTab;
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
    document.getElementById("view").innerHTML = '<p class="empty">No auction data yet. See the errors above. Once the collector runs with valid Blizzard API credentials, data appears here within the hour.</p>';
    return;
  }
  fillPickers();
  await changeMarket();
}

init();
