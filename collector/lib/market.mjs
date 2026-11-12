import { dayOf, bucketOf, median } from "./util.mjs";

const TL = { SHORT: 0, MEDIUM: 1, LONG: 2, VERY_LONG: 3 };
// Probability that a vanished auction was a sale rather than an expiry.
// SHORT (<30m left) most likely expired; MEDIUM (30m-2h) could go either way.
const SOLD_WEIGHT = [0, 0.5, 1, 1];
const MAX_GAP_SEC = 3 * 3600;
const DAILY_KEEP = 30;
const BUCKET_KEEP = 56; // 7 days of 3h buckets
const SALES_WINDOW_DAYS = 7;

function keyOf(item, isCommodity) {
  if (isCommodity) {
    return String(item.id);
  }
  const bl = item.bonus_lists;
  if (Array.isArray(bl) && bl.length > 0) {
    return `${item.id}:${[...bl].sort((a, b) => a - b).join(".")}`;
  }
  return String(item.id);
}

/**
 * Turn raw auctions into per-item price summaries plus a flat auction list
 * (used next run to detect sales).
 */
export function summarize(auctions, commodities) {
  const groups = new Map();
  const flat = [];
  const commodityKeys = new Set();

  function add(a, isCommodity) {
    const qty = a.quantity ?? 1;
    let unit;
    if (isCommodity) {
      unit = a.unit_price;
    } else if (a.buyout) {
      unit = Math.round(a.buyout / qty);
    } else if (a.unit_price) {
      unit = a.unit_price;
    } else {
      unit = null; // bid-only auction: tracked for sales, not for price
    }
    const key = keyOf(a.item, isCommodity);
    if (isCommodity) {
      commodityKeys.add(key);
    }
    flat.push([a.id, key, qty, TL[a.time_left] ?? 3]);
    if (unit == null || unit <= 0) {
      return;
    }
    let g = groups.get(key);
    if (!g) {
      g = [];
      groups.set(key, g);
    }
    g.push([unit, qty]);
  }

  for (const a of auctions ?? []) {
    add(a, false);
  }
  for (const a of commodities ?? []) {
    add(a, true);
  }

  const summary = new Map();
  for (const [key, list] of groups) {
    list.sort((a, b) => a[0] - b[0]);
    let qty = 0;
    for (const [, q] of list) {
      qty += q;
    }
    // Market price: quantity-weighted mean of the cheapest 15% of units.
    const target = Math.max(1, Math.ceil(qty * 0.15));
    let taken = 0;
    let cost = 0;
    for (const [p, q] of list) {
      const t = Math.min(q, target - taken);
      cost += t * p;
      taken += t;
      if (taken >= target) {
        break;
      }
    }
    // First 5 distinct price levels.
    const levels = [];
    for (const [p, q] of list) {
      const last = levels[levels.length - 1];
      if (last && last[0] === p) {
        last[1] += q;
      } else if (levels.length < 5) {
        levels.push([p, q]);
      } else {
        break;
      }
    }
    summary.set(key, {
      min: list[0][0],
      market: Math.round(cost / taken),
      qty,
      n: list.length,
      levels,
      commodity: commodityKeys.has(key),
    });
  }
  return { summary, flat };
}

/**
 * Merge a new snapshot into a house's persistent state.
 * state = { snap, prev:{ids,keys,qty,tl}, keys:{ key:{d,s,h} }, cov:[[day,hours]] }
 */
export function updateHouseState(state, snapTime, summary, flat) {
  state.keys ??= {};
  state.cov ??= [];
  const today = dayOf(snapTime);
  const bucket = bucketOf(snapTime);
  const gap = state.snap ? snapTime - state.snap : null;

  // ---- sales estimate from vanished / shrunk auctions ----
  if (state.prev && gap && gap > 0 && gap <= MAX_GAP_SEC) {
    const cur = new Map();
    for (const [id, , qty] of flat) {
      cur.set(id, qty);
    }
    const sold = new Map();
    const { ids, keys, qty, tl } = state.prev;
    for (let i = 0; i < ids.length; i++) {
      const nowQty = cur.get(ids[i]);
      let s = 0;
      if (nowQty === undefined) {
        s = qty[i] * SOLD_WEIGHT[tl[i]];
      } else if (nowQty < qty[i]) {
        s = qty[i] - nowQty;
      }
      if (s > 0) {
        const k = state.prev.keyTable[keys[i]];
        sold.set(k, (sold.get(k) ?? 0) + s);
      }
    }
    for (const [k, s] of sold) {
      const rec = (state.keys[k] ??= {});
      rec.s ??= [];
      const last = rec.s[rec.s.length - 1];
      if (last && last[0] === today) {
        last[1] += s;
      } else {
        rec.s.push([today, s]);
      }
    }
    const lastCov = state.cov[state.cov.length - 1];
    if (lastCov && lastCov[0] === today) {
      lastCov[1] += gap / 3600;
    } else {
      state.cov.push([today, gap / 3600]);
    }
  }

  // ---- price history ----
  for (const [k, s] of summary) {
    const rec = (state.keys[k] ??= {});
    rec.d ??= [];
    const last = rec.d[rec.d.length - 1];
    if (last && last[0] === today) {
      last[1] += s.market;
      last[2] += 1;
      last[3] = Math.min(last[3], s.min);
      last[4] = Math.max(last[4], s.qty);
    } else {
      rec.d.push([today, s.market, 1, s.min, s.qty]);
    }
    if (s.commodity) {
      rec.h ??= [];
      const lb = rec.h[rec.h.length - 1];
      if (lb && lb[0] === bucket) {
        lb[1] = s.market;
        lb[2] = s.qty;
      } else {
        rec.h.push([bucket, s.market, s.qty]);
      }
    }
    rec.seen = today;
  }

  // ---- prune ----
  const minDay = today - DAILY_KEEP;
  const minBucket = bucket - BUCKET_KEEP;
  for (const [k, rec] of Object.entries(state.keys)) {
    if ((rec.seen ?? 0) < today - 14 && !(rec.s && rec.s.length && rec.s[rec.s.length - 1][0] >= today - 14)) {
      delete state.keys[k];
      continue;
    }
    if (rec.d) {
      rec.d = rec.d.filter((r) => r[0] > minDay);
    }
    if (rec.s) {
      rec.s = rec.s.filter((r) => r[0] > minDay);
    }
    if (rec.h) {
      rec.h = rec.h.filter((r) => r[0] > minBucket);
    }
  }
  state.cov = state.cov.filter((r) => r[0] > minDay);

  // ---- remember this snapshot's auctions ----
  const keyTable = [];
  const keyIdx = new Map();
  const ids = new Array(flat.length);
  const keys = new Array(flat.length);
  const qty = new Array(flat.length);
  const tl = new Array(flat.length);
  for (let i = 0; i < flat.length; i++) {
    const [id, k, q, t] = flat[i];
    let ki = keyIdx.get(k);
    if (ki === undefined) {
      ki = keyTable.length;
      keyTable.push(k);
      keyIdx.set(k, ki);
    }
    ids[i] = id;
    keys[i] = ki;
    qty[i] = q;
    tl[i] = t;
  }
  state.prev = { ids, keys, qty, tl, keyTable };
  state.snap = snapTime;
  return state;
}

/** Derived per-item stats from history: baseline price, days of history, sold/day. */
export function deriveStats(state, today) {
  const covSince = today - SALES_WINDOW_DAYS;
  let covHours = 0;
  for (const [d, h] of state.cov ?? []) {
    if (d > covSince) {
      covHours += h;
    }
  }
  const out = new Map();
  for (const [k, rec] of Object.entries(state.keys ?? {})) {
    let baseline = null;
    let histDays = 0;
    if (rec.d && rec.d.length) {
      const recent = rec.d.filter((r) => r[0] > today - 14);
      histDays = recent.length;
      baseline = Math.round(median(recent.map((r) => r[1] / r[2])));
    }
    let soldPerDay = null;
    if (covHours >= 2) {
      let s = 0;
      for (const [d, v] of rec.s ?? []) {
        if (d > covSince) {
          s += v;
        }
      }
      soldPerDay = Math.round((s / (covHours / 24)) * 10) / 10;
    }
    out.set(k, { baseline, histDays, soldPerDay });
  }
  return { stats: out, covHours };
}
