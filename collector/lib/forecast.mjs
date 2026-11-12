import { BUCKET, DAY } from "./util.mjs";

export const ROLES = ["unknown", "leveling", "endgame-crafting", "endgame-consumable"];

/** Build itemId -> [productItemIds] from recipes. */
export function buildUsage(recipes) {
  const usage = new Map();
  for (const r of recipes) {
    for (const [mat] of r.mats) {
      let list = usage.get(mat);
      if (!list) {
        list = [];
        usage.set(mat, list);
      }
      list.push(r.out);
    }
  }
  return usage;
}

/**
 * Tier (level band) and longevity role for an item.
 * Curated tags win; otherwise inferred from item level and what the item is used to craft.
 * items[id] = [name, quality, sell, buy, classId, subclassId, level, reqLevel]
 */
export function classify(itemId, items, tags, usage) {
  const tag = tags[itemId];
  if (Array.isArray(tag)) {
    return { tier: tag[0], role: tag[1], src: "tag" };
  }
  const meta = items[itemId];
  if (!meta) {
    return { tier: null, role: "unknown", src: null };
  }
  const [, , , , classId, , level, reqLevel] = meta;
  const products = usage.get(Number(itemId)) ?? [];
  const isTradeGood = classId === 7;
  if (!isTradeGood && products.length === 0 && classId !== 0) {
    return { tier: null, role: "unknown", src: null };
  }
  const tier = Math.max(1, Math.min(60, reqLevel || level || 0)) || null;
  if (classId === 0 && (reqLevel >= 50 || level >= 55)) {
    return { tier, role: "endgame-consumable", src: "auto" };
  }
  let endgame = null;
  for (const p of products) {
    const pm = items[p];
    if (!pm) {
      continue;
    }
    const pLevel = Math.max(pm[6] || 0, pm[7] || 0);
    if (pLevel >= 55 || (pm[7] || 0) >= 50) {
      if (pm[4] === 0) {
        endgame = "endgame-consumable";
        break;
      }
      endgame = "endgame-crafting";
    }
  }
  if (endgame) {
    return { tier, role: endgame, src: "auto" };
  }
  if (isTradeGood || products.length > 0) {
    return { tier, role: "leveling", src: "auto" };
  }
  return { tier, role: "unknown", src: null };
}

/**
 * Progression index: average tier of gathered materials currently listed,
 * weighted by log(quantity). Rises as the population levels up and
 * high-tier gatherers flood the market.
 */
export function progressionIndex(summary, tags, gathered) {
  let num = 0;
  let den = 0;
  for (const id of gathered) {
    const s = summary.get(String(id));
    const tag = tags[id];
    if (!s || !tag) {
      continue;
    }
    const w = Math.log1p(s.qty);
    num += tag[0] * w;
    den += w;
  }
  return den > 0 ? Math.round((num / den) * 10) / 10 : null;
}

function theilSen(xs, ys) {
  const slopes = [];
  const n = xs.length;
  const step = n > 40 ? 2 : 1;
  for (let i = 0; i < n; i += step) {
    for (let j = i + 1; j < n; j += step) {
      const dx = xs[j] - xs[i];
      if (dx > 0) {
        slopes.push((ys[j] - ys[i]) / dx);
      }
    }
  }
  if (slopes.length === 0) {
    return { slope: 0, noise: 0 };
  }
  slopes.sort((a, b) => a - b);
  const slope = slopes[slopes.length >> 1];
  // Residual spread (median absolute deviation around the fitted line).
  const intercepts = ys.map((y, i) => y - slope * xs[i]).sort((a, b) => a - b);
  const b = intercepts[intercepts.length >> 1];
  const res = ys.map((y, i) => Math.abs(y - (b + slope * xs[i]))).sort((a, c) => a - c);
  return { slope, noise: res[res.length >> 1] };
}

function stageOf(role, tier, front, bands) {
  if (role === "leveling") {
    if (tier == null || front == null) {
      return "inBand";
    }
    if (front < tier - bands.aheadBy) {
      return "ahead";
    }
    if (front > tier + bands.behindBy) {
      return "behind";
    }
    return "inBand";
  }
  if (front == null || front < bands.earlyBelow) {
    return "early";
  }
  if (front > bands.lateAbove) {
    return "late";
  }
  return "mid";
}

/**
 * Forecast price at +3d and +7d for one item in one house.
 * Blends the item's own (damped) trend with a role/tier prior for a fresh economy.
 */
export function forecastItem(rec, current, cls, front, model, vendorSell) {
  const pts = [];
  if (rec?.h && rec.h.length >= 4) {
    for (const [b, p] of rec.h) {
      if (p > 0) {
        pts.push([(b * BUCKET) / DAY, Math.log(p)]);
      }
    }
  } else if (rec?.d) {
    for (const [d, sum, n] of rec.d) {
      if (sum > 0) {
        pts.push([d, Math.log(sum / n)]);
      }
    }
  }
  let slope = 0;
  let noise = 0;
  let span = 0;
  if (pts.length >= 3) {
    const fit = theilSen(pts.map((p) => p[0]), pts.map((p) => p[1]));
    slope = fit.slope;
    noise = fit.noise;
    span = pts[pts.length - 1][0] - pts[0][0];
  }

  const stage = stageOf(cls.role, cls.tier, front, model.bands);
  const priorTable = model.priorPerDay[cls.role];
  const prior = typeof priorTable === "number" ? priorTable : (priorTable?.[stage] ?? 0);
  const wTrend = Math.min(model.maxTrendWeight, (model.maxTrendWeight * span) / model.trendFullDays);
  const maxLog = Math.log(1 + model.maxMovePct / 100);

  function project(h) {
    let lc = wTrend * slope * model.trendDamping * h + (1 - wTrend) * prior * h;
    lc = Math.max(-maxLog, Math.min(maxLog, lc));
    let p = current * Math.exp(lc);
    if (vendorSell > 0) {
      p = Math.max(p, vendorSell);
    }
    return Math.round(p);
  }

  let score = 0;
  if (cls.role !== "unknown") {
    score += 1;
  }
  if (span >= 2) {
    score += 1;
  }
  if (span >= 5) {
    score += 1;
  }
  if (noise > 0.15) {
    score -= 1;
  }
  const conf = score >= 3 ? 2 : score >= 2 ? 1 : 0;

  const lonTable = model.longevity[cls.role];
  const longevity = typeof lonTable === "number" ? lonTable : (lonTable?.[stage] ?? 30);

  return {
    f3: project(3),
    f7: project(7),
    conf,
    longevity,
    stage,
    trend: Math.round(slope * 1000) / 1000,
  };
}
