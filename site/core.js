// Economancer core: state, formatting, market data, player data and strategy engines.
// Views live in app.js. Everything here is plain functions over S.

export const ROLE_NAMES = ["Unknown", "Leveling", "Endgame crafting", "Endgame consumable"];
export const CONF_NAMES = ["low", "medium", "high"];
export const DEFAULTS = {
  factionCut: 5,
  neutralCut: 15,
  minSpd: 1,
  horizon: 2,
  minProfit: 1,
  flipDiscount: 20,
  budget: 0,
  profs: [],
};
const PROF_ALIASES = { Smelting: "Mining" };
const EMPTY_PROFILE = {
  imported: null,
  active: "all",
  manual: { items: {}, known: [], gold: null },
  useGold: true,
  knownOnly: true,
};

export const S = {
  meta: null,
  items: {},
  recipes: [],
  settings: { ...DEFAULTS },
  profile: structuredClone(EMPTY_PROFILE),
  region: null,
  ruleset: null,
  faction: "alliance",
  tab: "picks",
  houses: {},
  houseCache: new Map(),
  lists: new Map(),
  lookupQuery: "",
  forecastView: "up",
  recipeQuery: "",
  itemQuery: "",
  _memo: new Map(),
};

// ---------- storage (best effort) ----------
export function load(key, fallback) {
  try {
    const v = localStorage.getItem(`fg:${key}`);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
export function save(key, value) {
  try {
    localStorage.setItem(`fg:${key}`, JSON.stringify(value));
  } catch {
    // storage unavailable: data lasts for this visit only
  }
}
export function loadProfile() {
  const p = load("profile", null);
  S.profile = { ...structuredClone(EMPTY_PROFILE), ...(p ?? {}) };
  S.profile.manual = { ...EMPTY_PROFILE.manual, ...(p?.manual ?? {}) };
}
export function saveProfile() {
  save("profile", S.profile);
  invalidate();
}
export function resetProfile() {
  S.profile = structuredClone(EMPTY_PROFILE);
  saveProfile();
}
/** Clear memoized strategy results (call when market, settings or profile change). */
export function invalidate() {
  S._memo.clear();
}
function memo(name, fn) {
  if (!S._memo.has(name)) {
    S._memo.set(name, fn());
  }
  return S._memo.get(name);
}

// ---------- formatting ----------
export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}
export function money(copper) {
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
export function pct(x, digits = 0) {
  if (x == null || !isFinite(x)) {
    return "—";
  }
  return `${x > 0 ? "+" : ""}${(x * 100).toFixed(digits)}%`;
}
export function ago(epochSec) {
  const m = Math.round((Date.now() / 1000 - epochSec) / 60);
  if (m < 1) {
    return "just now";
  }
  if (m < 90) {
    return `${m} min ago`;
  }
  if (m < 60 * 48) {
    return `${Math.round(m / 60)} h ago`;
  }
  return `${Math.round(m / 1440)} days ago`;
}
export function fmtNum(n) {
  if (n == null) {
    return "—";
  }
  return n >= 100 ? Math.round(n).toLocaleString() : String(Math.round(n * 10) / 10);
}
export function factionLabel(f) {
  return { alliance: "Alliance", horde: "Horde", neutral: "Neutral", vendor: "Vendor" }[f] ?? f;
}

// ---------- items ----------
export function itemIdOf(key) {
  return Number(String(key).split(":")[0]);
}
export function itemName(key) {
  const id = itemIdOf(key);
  const meta = S.items[id];
  const base = meta ? meta[0] : `Item #${id}`;
  const variant = String(key).includes(":") ? ` (variant ${String(key).split(":")[1]})` : "";
  return base + variant;
}
export function nameHtml(key) {
  const meta = S.items[itemIdOf(key)];
  const q = meta ? meta[1] : "COMMON";
  return `<span class="q-${esc(q)}">${esc(itemName(key))}</span>`;
}
export function vendorPrice(id) {
  if (!S.meta?.vendorItems?.includes(id)) {
    return null;
  }
  const meta = S.items[id];
  return meta && meta[3] > 0 ? meta[3] : null;
}
export function vendorSell(id) {
  return S.items[id]?.[2] ?? 0;
}
let nameIndex = null;
export function idByName(name) {
  if (!nameIndex) {
    nameIndex = new Map();
    for (const [id, meta] of Object.entries(S.items)) {
      nameIndex.set(meta[0].toLowerCase(), Number(id));
    }
  }
  return nameIndex.get(String(name ?? "").toLowerCase()) ?? null;
}

// ---------- market data ----------
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
export async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) {
    throw new Error(`${url}: ${res.status}`);
  }
  return res.json();
}
function loadHouse(file) {
  if (!S.houseCache.has(file)) {
    S.houseCache.set(file, fetchJson(file).then(parseHouse));
  }
  return S.houseCache.get(file);
}
export function rulesetObj() {
  return S.meta.regions[S.region]?.rulesets.find((r) => String(r.id) === String(S.ruleset));
}
export async function loadMarket() {
  const rs = rulesetObj();
  S.houses = {};
  invalidate();
  if (!rs) {
    return;
  }
  await Promise.all(
    rs.houses.map(async (h) => {
      S.houses[h.faction] = await loadHouse(h.file);
    }),
  );
}
export const H = {
  mine: () => S.houses[S.faction],
  other: () => S.houses[S.faction === "alliance" ? "horde" : "alliance"],
  neutral: () => S.houses.neutral,
  byFaction: (f) => S.houses[f],
};

// ---------- player data ----------
export function importedChars() {
  return S.profile.imported?.chars ?? {};
}
export function activeChars() {
  const all = importedChars();
  const a = S.profile.active;
  if (a && a !== "all" && all[a]) {
    return [[a, all[a]]];
  }
  return Object.entries(all);
}
export function hasImport() {
  return Object.keys(importedChars()).length > 0;
}
export function playerGold() {
  const mg = S.profile.manual.gold;
  if (mg != null && mg !== "" && isFinite(mg)) {
    return Number(mg) * 10000;
  }
  const chars = activeChars();
  if (chars.length === 0) {
    return null;
  }
  return chars.reduce((sum, [, c]) => sum + (c.g ?? 0), 0);
}
export function budgetCopper() {
  if (S.profile.useGold) {
    const g = playerGold();
    if (g != null) {
      return g;
    }
  }
  return S.settings.budget > 0 ? S.settings.budget * 10000 : Infinity;
}
function normProf(p) {
  return PROF_ALIASES[p] ?? p;
}
/** Professions from the import (active characters), else from settings. */
export function playerProfs() {
  const set = new Set();
  for (const [, c] of activeChars()) {
    for (const p of Object.keys(c.p ?? {})) {
      set.add(normProf(p));
    }
  }
  if (set.size === 0) {
    for (const p of S.settings.profs ?? []) {
      set.add(p);
    }
  }
  return set;
}
/** Owned item counts (bags + bank of active characters + manual entries). */
export function inventory() {
  return memo("inventory", () => {
    const inv = new Map();
    const add = (id, n) => {
      id = Number(id);
      if (n > 0) {
        inv.set(id, (inv.get(id) ?? 0) + n);
      }
    };
    for (const [, c] of activeChars()) {
      for (const [id, n] of Object.entries(c.bags ?? {})) {
        add(id, n);
      }
      for (const [id, n] of Object.entries(c.bank ?? {})) {
        add(id, n);
      }
    }
    for (const [id, n] of Object.entries(S.profile.manual.items ?? {})) {
      add(id, Number(n));
    }
    return inv;
  });
}
export function recipeSig(r) {
  return `${r.out}|${r.name}`;
}
function knowledge() {
  return memo("knowledge", () => {
    const items = new Set();
    const recipes = new Set();
    const scanned = new Set();
    for (const [, c] of activeChars()) {
      for (const [prof, k] of Object.entries(c.k ?? {})) {
        if (!k || Array.isArray(k)) {
          continue;
        }
        scanned.add(normProf(prof));
        for (const id of k.i ?? []) {
          items.add(id);
        }
        for (const id of k.r ?? []) {
          recipes.add(id);
        }
      }
    }
    return { items, recipes, scanned, manual: new Set(S.profile.manual.known ?? []) };
  });
}
/** known | unknown | unverified | noprof */
export function recipeStatus(r) {
  if (r.anyone) {
    return "known";
  }
  const profs = playerProfs();
  if (profs.size > 0 && !profs.has(r.prof)) {
    return "noprof";
  }
  const K = knowledge();
  if (K.manual.has(recipeSig(r))) {
    return "known";
  }
  if (r.src === "api" && r.id != null && K.recipes.has(r.id)) {
    return "known";
  }
  if (K.scanned.has(r.prof)) {
    return K.items.has(r.out) ? "known" : "unknown";
  }
  return "unverified";
}
export function recipeAllowed(r) {
  const st = recipeStatus(r);
  if (st === "noprof") {
    return false;
  }
  if (st === "unknown" && S.profile.knownOnly) {
    return false;
  }
  return true;
}

// ---------- pricing helpers ----------
export function fees() {
  return { fc: S.settings.factionCut / 100, nc: S.settings.neutralCut / 100 };
}
export function demandCap(row) {
  if (!row || row.spd == null) {
    return null;
  }
  return Math.max(1, Math.floor(row.spd * S.settings.horizon));
}
/** Realistic resale price: current lowest listing, but not wildly above typical. */
export function sellRef(row) {
  if (!row) {
    return null;
  }
  if (row.base && row.histDays >= 1) {
    return Math.min(row.min, Math.round(row.base * 1.5));
  }
  return row.min;
}
export function unitCost(house, id) {
  const v = vendorPrice(id);
  const row = house?.rows.get(String(id));
  const ah = row ? row.market : null;
  if (v != null && ah != null) {
    return Math.min(v, ah);
  }
  return v ?? ah;
}
function costSource(house, id) {
  const v = vendorPrice(id);
  const row = house?.rows.get(String(id));
  if (v != null && (!row || v <= row.market)) {
    return "vendor";
  }
  return house?.faction ?? "vendor";
}
function buyLevels(levels, maxPrice, capUnits, capCost) {
  let units = 0;
  let cost = 0;
  let maxPaid = 0;
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
    maxPaid = p;
  }
  return { units, cost, maxPaid };
}
export function rankWeight(row) {
  if (!row || row.spd == null) {
    return 0.5;
  }
  return row.spd >= S.settings.minSpd ? 1 : 0.25;
}

// ---------- strategies ----------
// Each pick: { kind, key, profit, score, invest (cash), buys:[{h,key,qty,max}], crafts:[{name,n}],
//              posts:[{h,key,qty,price}], data } — rendering is done in app.js.

export function arbitrage() {
  return memo("arb", () => {
    const F = H.mine();
    const N = H.neutral();
    const O = H.other();
    const { fc, nc } = fees();
    const minProfit = S.settings.minProfit * 10000;
    const picks = [];
    const route = (key, buyHouse, buyRow, sellHouse, sellRow, sellCut, transferFee, label) => {
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
      const { units, cost, maxPaid } = buyLevels(buyRow.levels, maxBuy, cap, budgetCopper() / (1 + transferFee));
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
        invest: totalCost,
        buys: [{ h: buyHouse.faction, key, qty: units, max: maxPaid }],
        crafts: [],
        posts: [{ h: sellHouse.faction, key, qty: units, price: sell }],
        data: { units, cost, sell, roi, label, transferFee, buyHouse: buyHouse.faction, sellHouse: sellHouse.faction, sellRow },
      });
    };
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
  });
}

export function flips() {
  return memo("flips", () => {
    const F = H.mine();
    if (!F) {
      return [];
    }
    const { fc } = fees();
    const minProfit = S.settings.minProfit * 10000;
    const disc = S.settings.flipDiscount / 100;
    const picks = [];
    for (const [k, r] of F.rows) {
      if (!r.levels.length || (r.spd != null && r.spd < S.settings.minSpd)) {
        continue;
      }
      const cap = demandCap(r) ?? 3;
      let best = null;
      if (r.base && r.histDays >= 2) {
        const b = buyLevels(r.levels, r.base * (1 - disc), cap, budgetCopper());
        if (b.units > 0) {
          best = { ...b, profit: b.units * r.base * (1 - fc) - b.cost, sell: r.base, why: "under" };
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
            best = { units, cost: units * p0, maxPaid: p0, profit, sell, why: "gap", gap: p1 / p0 - 1 };
          }
        }
      }
      if (!best || best.profit < minProfit || best.profit / best.cost < 0.1) {
        continue;
      }
      picks.push({
        kind: "flip",
        key: k,
        profit: best.profit,
        score: best.profit * rankWeight(r),
        invest: best.cost,
        buys: [{ h: F.faction, key: k, qty: best.units, max: best.maxPaid }],
        crafts: [],
        posts: [{ h: F.faction, key: k, qty: best.units, price: best.sell }],
        data: { ...best, row: r },
      });
    }
    return picks.sort((a, b) => b.score - a.score);
  });
}

/** Cost of the mats for n crafts, using owned items first (owned still counts at market value). */
function matsFor(F, r, n, exclude, ownedLeft) {
  let value = 0;
  let cash = 0;
  const parts = [];
  const buys = [];
  for (const [id, q] of r.mats) {
    if (id === exclude) {
      continue;
    }
    const u = unitCost(F, id);
    if (u == null) {
      return null;
    }
    const need = q * n;
    const have = Math.min(need, ownedLeft?.get(id) ?? 0);
    if (ownedLeft && have > 0) {
      ownedLeft.set(id, ownedLeft.get(id) - have);
    }
    value += u * need;
    cash += u * (need - have);
    parts.push({ id, q, u, have, src: costSource(F, id) });
    if (need - have > 0) {
      buys.push({ h: costSource(F, id), key: String(id), qty: need - have, max: u });
    }
  }
  return { value, cash, parts, buys };
}

function craftOne(F, r, fc) {
  const out = F.rows.get(String(r.out));
  const sell = sellRef(out);
  if (!sell || (out.spd != null && out.spd < S.settings.minSpd)) {
    return null;
  }
  const one = matsFor(F, r, 1, null, null);
  if (!one || one.value <= 0) {
    return null;
  }
  const each = sell * r.outQty * (1 - fc) - one.value;
  return { out, sell, each, one };
}

export function crafts() {
  return memo("crafts", () => {
    const F = H.mine();
    if (!F) {
      return { picks: [], learnable: [] };
    }
    const { fc } = fees();
    const minProfit = S.settings.minProfit * 10000;
    const picks = [];
    const learnable = [];
    for (const r of S.recipes) {
      const status = recipeStatus(r);
      if (status === "noprof") {
        continue;
      }
      const c = craftOne(F, r, fc);
      if (!c || c.each <= 0 || c.each / c.one.value < 0.05) {
        continue;
      }
      const { out, sell, each } = c;
      if (status === "unknown" && S.profile.knownOnly) {
        if (each >= minProfit) {
          learnable.push({ r, each, sell, out });
        }
        continue;
      }
      let n = out.spd != null ? Math.max(1, Math.floor((out.spd * S.settings.horizon) / r.outQty)) : 1;
      n = Math.min(n, 50);
      if (r.cd) {
        n = 1;
      }
      let m = matsFor(F, r, n, null, new Map(inventory()));
      while (n > 1 && m && m.cash > budgetCopper()) {
        n = Math.max(1, Math.floor(n / 2));
        m = matsFor(F, r, n, null, new Map(inventory()));
      }
      if (!m) {
        continue;
      }
      const profit = each * n;
      if (profit < minProfit) {
        continue;
      }
      let each7 = null;
      if (out.f7) {
        let c7 = 0;
        let ok = true;
        for (const [id, q] of r.mats) {
          const u = vendorPrice(id) ?? F.rows.get(String(id))?.f7 ?? unitCost(F, id);
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
        invest: m.cash,
        buys: m.buys,
        crafts: [{ name: r.name, n }],
        posts: [{ h: F.faction, key: String(r.out), qty: n * r.outQty, price: sell }],
        data: { r, n, each, sell, out, mats: m, status, each7 },
      });
    }
    picks.sort((a, b) => b.score - a.score);
    learnable.sort((a, b) => b.each - a.each);
    return { picks, learnable };
  });
}

export function shuffles() {
  return memo("shuffles", () => {
    const F = H.mine();
    if (!F) {
      return [];
    }
    const { fc } = fees();
    const minProfit = S.settings.minProfit * 10000;
    const allowed = S.recipes.filter(recipeAllowed);
    const byMat = new Map();
    for (const r of allowed) {
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
    const dfs = (chain, item, qty, cost, visited, firstSell) => {
      if (chain.length >= 3) {
        return;
      }
      for (const r of byMat.get(item) ?? []) {
        if (visited.has(r.out)) {
          continue;
        }
        const need = r.mats.find((m) => m[0] === item)[1];
        const n = qty / need;
        const other = matsFor(F, r, n, item, null);
        if (!other) {
          continue;
        }
        const newCost = cost + other.value;
        const outQty = r.outQty * n;
        const next = [...chain, { r, n, buys: other.buys }];
        const sn = sellNet(r.out);
        if (sn != null) {
          results.push({ chain: next, profit: outQty * sn - newCost, cost: newCost, out: r.out, outQty, gainVsFirst: outQty * sn - newCost - firstSell });
        }
        const v = new Set(visited);
        v.add(r.out);
        dfs(next, r.out, outQty, newCost, v, firstSell);
      }
    };
    for (const r1 of allowed) {
      const cc = matsFor(F, r1, 1, null, null);
      if (!cc || cc.value <= 0) {
        continue;
      }
      const sn = sellNet(r1.out);
      const firstSell = sn != null ? sn * r1.outQty - cc.value : -Infinity;
      const visited = new Set(r1.mats.map((m) => m[0]));
      visited.add(r1.out);
      dfs([{ r: r1, n: 1, buys: cc.buys }], r1.out, r1.outQty, cc.value, visited, firstSell);
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
      const buys = [];
      for (const s of res.chain) {
        for (const b of s.buys) {
          buys.push({ ...b, qty: Math.ceil(b.qty * batches) });
        }
      }
      picks.push({
        kind: "shuffle",
        key: String(res.out),
        profit,
        score: profit * rankWeight(outRow),
        invest: res.cost * batches,
        buys,
        crafts: res.chain.map((s) => ({ name: s.r.name, n: Math.round(s.n * batches * 10) / 10 })),
        posts: [{ h: F.faction, key: String(res.out), qty: Math.round(res.outQty * batches), price: sellRef(outRow) }],
        data: { ...res, batches, outRow },
      });
    }
    return picks.sort((a, b) => b.score - a.score);
  });
}

export function forecasts() {
  return memo("forecasts", () => {
    const F = H.mine();
    if (!F) {
      return { up: [], down: [], all: [] };
    }
    const all = [];
    for (const [k, r] of F.rows) {
      if (r.f7 == null || !r.market) {
        continue;
      }
      all.push({ key: k, r, chg7: r.f7 / r.market - 1, chg3: r.f3 / r.market - 1 });
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
  });
}

/** Buy-and-hold picks from the forecast, for the plan. */
function stockPicks() {
  const F = H.mine();
  if (!F) {
    return [];
  }
  const { fc } = fees();
  const minProfit = S.settings.minProfit * 10000;
  const out = [];
  for (const x of forecasts().up) {
    const r = x.r;
    if (r.conf < 1 || (r.lon ?? 0) < 50 || !r.levels.length) {
      continue;
    }
    const target = r.f7 * (1 - fc);
    const cap = demandCap(r) ?? 5;
    const b = buyLevels(r.levels, target * 0.92, cap, budgetCopper());
    if (b.units <= 0) {
      continue;
    }
    const profit = b.units * target - b.cost;
    if (profit < minProfit) {
      continue;
    }
    out.push({
      kind: "stock",
      key: x.key,
      profit,
      score: profit * 0.6, // forecasts are less certain than live price gaps
      invest: b.cost,
      buys: [{ h: F.faction, key: x.key, qty: b.units, max: b.maxPaid }],
      crafts: [],
      posts: [{ h: F.faction, key: x.key, qty: b.units, price: r.f7, hold: true }],
      data: { x, b },
    });
  }
  return out;
}

/** What to do with each owned item. */
export function myStuff() {
  return memo("mystuff", () => {
    const F = H.mine();
    const N = H.neutral();
    const { fc, nc } = fees();
    const inv = inventory();
    const recipes = S.recipes.filter(recipeAllowed);
    const usedIn = new Map();
    for (const r of recipes) {
      for (const [id] of r.mats) {
        if (!usedIn.has(id)) {
          usedIn.set(id, []);
        }
        usedIn.get(id).push(r);
      }
    }
    const rows = [];
    for (const [id, count] of inv) {
      const opts = [];
      const fr = F?.rows.get(String(id));
      const nr = N?.rows.get(String(id));
      if (fr) {
        const p = sellRef(fr);
        opts.push({ type: "sell", h: F.faction, perUnit: p * (1 - fc), price: p, row: fr, label: `Sell on ${factionLabel(F.faction)} AH` });
      }
      if (nr && F) {
        const p = sellRef(nr);
        opts.push({ type: "sell", h: "neutral", perUnit: p * (1 - nc), price: p, row: nr, label: "Sell on Neutral AH" });
      }
      const vs = vendorSell(id);
      if (vs > 0) {
        opts.push({ type: "vendor", perUnit: vs, label: "Vendor it" });
      }
      if (F) {
        for (const r of usedIn.get(id) ?? []) {
          const out = F.rows.get(String(r.out));
          const sell = sellRef(out);
          if (!sell) {
            continue;
          }
          const need = r.mats.find((m) => m[0] === id)[1];
          const other = matsFor(F, r, 1, id, null);
          if (!other) {
            continue;
          }
          const perUnit = (sell * r.outQty * (1 - fc) - other.value) / need;
          opts.push({ type: "craft", perUnit, recipe: r, out, sell, label: `Craft ${r.name}` });
        }
        if (fr?.f7 && fr.market && fr.f7 / fr.market - 1 >= 0.05 && (fr.lon ?? 0) >= 50) {
          opts.push({ type: "hold", h: F.faction, perUnit: fr.f7 * (1 - fc), price: fr.f7, row: fr, label: "Hold ~7 days, then sell" });
        }
      }
      opts.sort((a, b) => b.perUnit - a.perUnit);
      const best = opts[0] ?? null;
      rows.push({ id, key: String(id), count, best, opts, total: best ? best.perUnit * count : 0 });
    }
    return rows.sort((a, b) => b.total - a.total);
  });
}

function sellOwnPicks() {
  const picks = [];
  for (const s of myStuff()) {
    const b = s.best;
    if (!b || b.type === "vendor" || b.type === "hold") {
      continue;
    }
    if (b.type === "sell") {
      const cap = demandCap(b.row) ?? s.count;
      const qty = Math.min(s.count, cap);
      picks.push({
        kind: "own",
        key: s.key,
        profit: b.perUnit * qty,
        score: b.perUnit * qty,
        invest: 0,
        buys: [],
        crafts: [],
        posts: [{ h: b.h, key: s.key, qty, price: b.price }],
        data: s,
      });
    }
  }
  return picks;
}

/**
 * Daily plan: greedily fill the budget with the best return-on-cash picks,
 * never buying the same item from the same AH twice.
 */
export function plan() {
  return memo("plan", () => {
    const budget = budgetCopper();
    const minProfit = S.settings.minProfit * 10000;
    const own = sellOwnPicks();
    const candidates = [
      ...arbitrage(),
      ...flips(),
      ...crafts().picks,
      ...shuffles(),
      ...stockPicks(),
    ].filter((p) => p.profit >= minProfit && p.invest > 0);
    candidates.sort((a, b) => b.profit / b.invest - a.profit / a.invest);
    const chosen = [];
    const usedBuys = new Set();
    const usedPosts = new Set(own.map((p) => `${p.posts[0].h}:${p.key}`));
    let left = budget;
    for (const p of candidates) {
      if (p.invest > left) {
        continue;
      }
      const buyKeys = p.buys.filter((b) => b.h !== "vendor").map((b) => `${b.h}:${b.key}`);
      const postKeys = p.posts.map((x) => `${x.h}:${x.key}`);
      if (buyKeys.some((k) => usedBuys.has(k)) || postKeys.some((k) => usedPosts.has(k))) {
        continue;
      }
      chosen.push(p);
      left -= p.invest;
      for (const k of buyKeys) {
        usedBuys.add(k);
      }
      for (const k of postKeys) {
        usedPosts.add(k);
      }
      if (chosen.length >= 25) {
        break;
      }
    }
    const spent = chosen.reduce((s, p) => s + p.invest, 0);
    const profit = chosen.reduce((s, p) => s + p.profit, 0);
    const ownValue = own.reduce((s, p) => s + p.profit, 0);
    return { budget, spent, profit, own, chosen, ownValue };
  });
}

/** Ledger stats from the addon's mail invoices. */
export function ledgerStats(days) {
  const ledger = S.profile.imported?.ledger ?? [];
  const since = Date.now() / 1000 - days * 86400;
  const byItem = new Map();
  let sales = 0;
  let gross = 0;
  let cut = 0;
  let buys = 0;
  let spent = 0;
  for (const [t, k, name, qty, amount, consignment] of ledger) {
    if (t < since) {
      continue;
    }
    const rec = byItem.get(name) ?? { name, sold: 0, income: 0, bought: 0, spent: 0 };
    if (k === "s") {
      sales++;
      gross += amount;
      cut += consignment ?? 0;
      rec.sold += qty ?? 1;
      rec.income += amount - (consignment ?? 0);
    } else {
      buys++;
      spent += amount;
      rec.bought += qty ?? 1;
      rec.spent += amount;
    }
    byItem.set(name, rec);
  }
  const items = [...byItem.values()].map((r) => ({ ...r, net: r.income - r.spent })).sort((a, b) => b.net - a.net);
  return { sales, gross, cut, income: gross - cut, buys, spent, net: gross - cut - spent, items };
}

/** Parse an addon export string. Throws on invalid input. */
export function parseExport(text) {
  const t = String(text ?? "").trim();
  const i = t.indexOf("ECON1:");
  if (i < 0) {
    throw new Error("That doesn't look like an Economancer export (it should start with ECON1:).");
  }
  const obj = JSON.parse(t.slice(i + 6));
  if (!obj || typeof obj.chars !== "object") {
    throw new Error("Export is missing character data.");
  }
  for (const c of Object.values(obj.chars)) {
    for (const f of ["bags", "bank", "p", "k"]) {
      if (Array.isArray(c[f])) {
        c[f] = {}; // empty Lua tables export as []
      }
    }
  }
  obj.ledger = Array.isArray(obj.ledger) ? obj.ledger : [];
  return obj;
}
