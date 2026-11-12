#!/usr/bin/env node
/**
 * Hourly collector for WoW: Forever auction data.
 * Reads state/ (persisted between runs via the Actions cache), writes public/ (deployed to Pages).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Blizzard, findIndexArray, nameOf } from "./lib/blizzard.mjs";
import { summarize, updateHouseState, deriveStats } from "./lib/market.mjs";
import { discoverRecipes, mergeRecipes } from "./lib/recipes.mjs";
import { samplePopulation } from "./lib/population.mjs";
import { buildUsage, classify, progressionIndex, forecastItem, ROLES } from "./lib/forecast.mjs";
import { readJson, writeJson, ensureDir, pool, dayOf, bucketOf } from "./lib/util.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE = path.resolve(process.env.STATE_DIR ?? path.join(ROOT, "state"));
const OUT = path.resolve(process.env.OUT_DIR ?? path.join(ROOT, "public"));
const SITE = path.join(ROOT, "site");
const REGIONS = (process.env.REGIONS ?? "us,eu").split(",").map((r) => r.trim()).filter(Boolean);
const MAX_ITEM_FETCH = Number(process.env.MAX_ITEM_FETCH ?? 4000);
const RECIPE_REFRESH_DAYS = 7;
const POP_REFRESH_HOURS = 6;

const errors = [];
function log(msg) {
  console.log(msg);
}
function fail(msg) {
  console.warn(`ERROR: ${msg}`);
  errors.push(msg);
}

function factionOf(name, id) {
  const n = (name ?? "").toLowerCase();
  if (n.includes("alliance")) {
    return "alliance";
  }
  if (n.includes("horde")) {
    return "horde";
  }
  if (/neutral|blackwater|steamwheedle|goblin|booty|gadgetzan|everlook|cartel/.test(n)) {
    return "neutral";
  }
  return { 2: "alliance", 6: "horde", 7: "neutral" }[id] ?? "other";
}

async function copySite() {
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.cp(SITE, OUT, { recursive: true });
  await ensureDir(path.join(OUT, "data"));
}

async function main() {
  const started = Date.now();
  await copySite();
  const curated = JSON.parse(await fs.readFile(path.join(ROOT, "collector/data/curated.json"), "utf8"));
  const seeds = await readJson(path.join(ROOT, "collector/data/population-seeds.json"), {});
  const meta = await readJson(path.join(STATE, "meta.json"), { v: 1 });
  const items = await readJson(path.join(STATE, "items.json.gz"), {});
  let recipes = await readJson(path.join(STATE, "recipes.json.gz"), null);
  const population = await readJson(path.join(STATE, "population.json"), {});

  const clientId = process.env.BLIZZARD_CLIENT_ID;
  const clientSecret = process.env.BLIZZARD_CLIENT_SECRET;
  const publicMeta = { v: 1, generated: Math.floor(Date.now() / 1000), regions: {}, errors };

  if (!clientId || !clientSecret) {
    fail("BLIZZARD_CLIENT_ID / BLIZZARD_CLIENT_SECRET are not set. Add them as repository secrets.");
    await writeJson(path.join(OUT, "data/meta.json"), publicMeta);
    return;
  }

  const api = new Blizzard({
    clientId,
    clientSecret,
    apiBase: process.env.BLIZZARD_API_BASE ?? "https://{region}.api.blizzard.com",
    oauthUrl: process.env.BLIZZARD_OAUTH_URL,
  });

  meta.houses ??= {};
  const seenItems = new Map(); // itemId -> listings count (for fetch priority)
  const houseJobs = []; // { region, house, summary, state, out }

  // ---------- 1. fetch every auction house ----------
  for (const region of REGIONS) {
    let rulesets;
    try {
      const res = await api.get(region, "/data/wow/ruleset/index");
      rulesets = findIndexArray(res.data);
      if (rulesets.length === 0) {
        fail(`${region}: ruleset index empty (${res.status})`);
        continue;
      }
    } catch (err) {
      fail(`${region}: ruleset index failed: ${err.message}`);
      continue;
    }
    const houses = new Map();
    for (const rs of rulesets) {
      const res = await api.get(region, `/data/wow/ruleset/${rs.id}/auctions/`);
      for (const h of res.data?.auctions ?? []) {
        // The index may list the same (global) houses under every ruleset; the house's
        // canonical href tells us where it really lives, so prefer that path.
        let entry = houses.get(h.id);
        if (!entry) {
          entry = { id: h.id, name: nameOf(h.name), rulesetId: rs.id, rulesetName: nameOf(rs.name), paths: [] };
          houses.set(h.id, entry);
        }
        if (h.key?.href) {
          const p = new URL(h.key.href).pathname.replace(/\/$/, "");
          if (!entry.paths.includes(p)) {
            entry.paths.unshift(p);
          }
        }
        const p = `/data/wow/ruleset/${rs.id}/auctions/${h.id}`;
        if (!entry.paths.includes(p)) {
          entry.paths.push(p);
        }
      }
    }
    log(`${region}: ${rulesets.length} rulesets, ${houses.size} auction houses`);

    await pool([...houses.values()], 3, async (h) => {
      const hk = `${region}:${h.id}`;
      const hm = (meta.houses[hk] ??= {});
      const stateFile = path.join(STATE, `house-${region}-${h.id}.json.gz`);
      const outFile = path.join(STATE, `out-${region}-${h.id}.json.gz`);
      try {
        let base = hm.path ?? h.paths[0];
        let res = await api.get(region, base, "dynamic", { ifModifiedSince: hm.lm });
        for (const alt of h.paths) {
          if (res.status !== 404 && res.status !== 403) {
            break;
          }
          if (alt !== base) {
            base = alt;
            res = await api.get(region, base, "dynamic");
          }
        }
        hm.path = base;
        let commodities = null;
        let cres = { status: 304 };
        if (res.status === 200 && Array.isArray(res.data?.commodities)) {
          commodities = res.data.commodities;
          cres = { status: 200, lastModified: res.lastModified };
        } else {
          cres = await api.get(region, `${base}/commodities`, "dynamic", { ifModifiedSince: hm.clm });
          commodities = cres.data?.auctions ?? null;
        }
        if (res.status === 304 && cres.status === 304) {
          const prevOut = await readJson(outFile, null);
          if (prevOut) {
            log(`${hk}: unchanged, reusing last output`);
            houseJobs.push({ region, house: h, reuse: prevOut });
          }
          return;
        }
        if (res.status !== 200 && res.status !== 304) {
          fail(`${hk}: auctions -> ${res.status}`);
          return;
        }
        const data = res.data ?? {};
        const rsName = nameOf(data.ruleset?.name) || h.rulesetName;
        const rsId = data.ruleset?.id ?? h.rulesetId;
        const name = nameOf(data.name) || h.name;
        const lm = res.lastModified ?? cres.lastModified;
        const snapTime = lm ? Math.floor(new Date(lm).getTime() / 1000) : Math.floor(Date.now() / 1000);

        // If only one half changed we still need both halves for a consistent snapshot.
        let auctions = data.auctions;
        if (res.status === 304) {
          const full = await api.get(region, base, "dynamic");
          auctions = full.data?.auctions ?? [];
        }
        if (commodities === null && cres.status === 304) {
          const full = await api.get(region, `${base}/commodities`, "dynamic");
          commodities = full.data?.auctions ?? [];
        }

        const { summary, flat } = summarize(auctions ?? [], commodities ?? []);
        const state = await readJson(stateFile, {});
        updateHouseState(state, snapTime, summary, flat);
        hm.lm = res.lastModified ?? hm.lm;
        hm.clm = cres.lastModified ?? hm.clm;
        for (const [k, s] of summary) {
          const id = Number(k.split(":")[0]);
          seenItems.set(id, (seenItems.get(id) ?? 0) + s.n);
        }
        log(`${hk} (${name}): ${flat.length} auctions, ${summary.size} items`);
        houseJobs.push({
          region,
          house: { ...h, name, rulesetId: rsId, rulesetName: rsName, faction: factionOf(name, h.id) },
          summary,
          state,
          snapTime,
          auctions: flat.length,
          stateFile,
          outFile,
        });
      } catch (err) {
        fail(`${hk}: ${err.message}`);
      }
    });
  }

  // ---------- 2. recipes (weekly) ----------
  const now = Math.floor(Date.now() / 1000);
  if (!recipes || !meta.recipesAt || now - meta.recipesAt > RECIPE_REFRESH_DAYS * 86400) {
    let apiRecipes = [];
    try {
      apiRecipes = await discoverRecipes(api, REGIONS[0], log);
    } catch (err) {
      fail(`recipe discovery failed: ${err.message}`);
    }
    recipes = mergeRecipes(apiRecipes, curated.recipes);
    meta.recipesAt = now;
    meta.recipeApiCount = apiRecipes.length;
    log(`recipes: ${apiRecipes.length} from API, ${recipes.length} total`);
  } else {
    // Curated edits apply immediately even between API refreshes.
    recipes = mergeRecipes(recipes.filter((r) => r.src === "api"), curated.recipes);
  }

  // ---------- 3. item metadata ----------
  const wanted = new Map(seenItems);
  for (const r of recipes) {
    wanted.set(r.out, (wanted.get(r.out) ?? 0) + 1e6);
    for (const [m] of r.mats) {
      wanted.set(m, (wanted.get(m) ?? 0) + 1e6);
    }
  }
  for (const id of curated.vendorItems) {
    wanted.set(id, 1e7);
  }
  const missing = [...wanted.entries()]
    .filter(([id]) => !items[id])
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_ITEM_FETCH)
    .map(([id]) => id);
  if (missing.length) {
    log(`items: fetching ${missing.length} new item records`);
    let failed = 0;
    await pool(missing, 16, async (id) => {
      try {
        const res = await api.get(REGIONS[0], `/data/wow/item/${id}`, "static");
        const d = res.data;
        if (!d) {
          failed++;
          return;
        }
        items[id] = [
          nameOf(d.name),
          d.quality?.type ?? "COMMON",
          d.sell_price ?? 0,
          d.purchase_price ?? 0,
          d.item_class?.id ?? -1,
          d.item_subclass?.id ?? -1,
          d.level ?? 0,
          d.required_level ?? 0,
        ];
      } catch {
        failed++;
      }
    });
    if (failed) {
      log(`items: ${failed} lookups failed`);
    }
  }

  // ---------- 4. population sample (optional) ----------
  for (const region of REGIONS) {
    const p = population[region];
    if (p && now - (p.at ?? 0) < POP_REFRESH_HOURS * 3600) {
      continue;
    }
    try {
      const sample = await samplePopulation(api, region, seeds, log);
      if (sample) {
        population[region] = { ...sample, at: now };
      }
    } catch (err) {
      log(`population ${region}: ${err.message}`);
    }
  }

  // ---------- 5. derive stats + forecasts, write outputs ----------
  const usage = buildUsage(recipes);
  const tags = curated.materialTags;
  const model = curated.forecastModel;
  const clsCache = new Map();
  const classOf = (id) => {
    let c = clsCache.get(id);
    if (!c) {
      c = classify(id, items, tags, usage);
      clsCache.set(id, c);
    }
    return c;
  };

  const cols = ["key", "min", "market", "qty", "n", "levels", "base", "histDays", "spd", "f3", "f7", "conf", "lon", "role", "tier", "trend"];
  for (const job of houseJobs) {
    const { region } = job;
    const reg = (publicMeta.regions[region] ??= { rulesets: {}, population: population[region] ?? null });
    let out;
    if (job.reuse) {
      out = job.reuse;
    } else {
      const { house, summary, state, snapTime } = job;
      const today = dayOf(snapTime);
      const { stats, covHours } = deriveStats(state, today);
      const prog = progressionIndex(summary, tags, curated.gatheredMaterials);
      state.prog ??= [];
      if (prog != null) {
        const b = bucketOf(snapTime);
        state.prog = state.prog.filter((p) => p[0] !== b && p[0] > b - 8 * 56);
        state.prog.push([b, prog]);
      }
      const popFront = population[region]?.median ?? null;
      const front = popFront ?? prog;
      const rows = [];
      for (const [k, s] of summary) {
        const st = stats.get(k) ?? {};
        const itemId = Number(k.split(":")[0]);
        let f = null;
        let cls = null;
        if (s.commodity || tags[itemId]) {
          cls = classOf(itemId);
          if (cls.role !== "unknown" || s.commodity) {
            f = forecastItem(state.keys[k], s.market, cls, front, model, items[itemId]?.[2] ?? 0);
          }
        }
        rows.push([
          k, s.min, s.market, s.qty, s.n, s.levels.flat(),
          st.baseline ?? null, st.histDays ?? 0, st.soldPerDay ?? null,
          f?.f3 ?? null, f?.f7 ?? null, f?.conf ?? null, f?.longevity ?? null,
          cls ? ROLES.indexOf(cls.role) : null, cls?.tier ?? null, f?.trend ?? null,
        ]);
      }
      out = {
        v: 1,
        region,
        id: house.id,
        name: house.name,
        faction: house.faction,
        ruleset: { id: house.rulesetId, name: house.rulesetName },
        snap: snapTime,
        auctions: job.auctions,
        covHours: Math.round(covHours * 10) / 10,
        progression: { current: prog, front, frontSource: popFront != null ? "population" : "auction-house", history: state.prog },
        cols,
        rows,
      };
      await writeJson(job.stateFile, state);
      await writeJson(job.outFile, out);
    }
    const file = `data/${region}/${out.id}.json`;
    await writeJson(path.join(OUT, file), out);
    const rs = (reg.rulesets[out.ruleset.id] ??= { id: out.ruleset.id, name: out.ruleset.name, houses: [] });
    rs.houses.push({ id: out.id, name: out.name, faction: out.faction, file, snap: out.snap, auctions: out.auctions });
  }
  for (const reg of Object.values(publicMeta.regions)) {
    reg.rulesets = Object.values(reg.rulesets).sort((a, b) => a.id - b.id);
  }

  // Items: only those relevant (seen on AH or used in recipes) to keep the file small.
  const pubItems = {};
  for (const id of wanted.keys()) {
    if (items[id]) {
      pubItems[id] = items[id];
    }
  }
  publicMeta.itemCount = Object.keys(pubItems).length;
  publicMeta.recipeCount = recipes.length;
  publicMeta.recipeApiCount = meta.recipeApiCount ?? 0;
  publicMeta.vendorItems = curated.vendorItems;
  publicMeta.forecastModel = model;
  await writeJson(path.join(OUT, "data/items.json"), pubItems);
  await writeJson(path.join(OUT, "data/recipes.json"), recipes);
  await writeJson(path.join(OUT, "data/meta.json"), publicMeta);

  meta.lastRun = now;
  await writeJson(path.join(STATE, "meta.json"), meta);
  await writeJson(path.join(STATE, "items.json.gz"), items);
  await writeJson(path.join(STATE, "recipes.json.gz"), recipes);
  await writeJson(path.join(STATE, "population.json"), population);
  log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s, ${api.requests} API requests, ${errors.length} errors`);
}

main().catch(async (err) => {
  console.error(err);
  process.exitCode = 1;
});
