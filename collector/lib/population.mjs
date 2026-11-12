import { median, pool } from "./util.mjs";

/**
 * Optional: sample character levels from guild rosters to estimate the leveling curve.
 * Seeds come from collector/data/population-seeds.json:
 *   { "us": { "characters": ["name"], "guilds": ["guild-slug"] }, "eu": {...} }
 * Biased toward guilded players, but a real signal. Fails quietly if endpoints differ.
 */
export async function samplePopulation(api, region, seeds, log) {
  const s = seeds?.[region];
  if (!s || ((s.characters ?? []).length === 0 && (s.guilds ?? []).length === 0)) {
    return null;
  }
  const rosterUrls = new Set();
  const levels = new Map();

  for (const slug of s.guilds ?? []) {
    rosterUrls.add(`/data/wow/guild/${encodeURIComponent(slug.toLowerCase())}/roster`);
  }
  await pool(s.characters ?? [], 4, async (name) => {
    const res = await api.get(region, `/profile/wow/character/${encodeURIComponent(name.toLowerCase())}`, "profile");
    const c = res.data;
    if (!c) {
      log(`population: character ${name} -> ${res.status}`);
      return;
    }
    if (c.level) {
      levels.set(`c:${c.name ?? name}`, c.level);
    }
    const href = c.guild?.key?.href;
    if (href) {
      const u = new URL(href);
      u.pathname = `${u.pathname.replace(/\/$/, "")}/roster`;
      rosterUrls.add(u.toString());
    }
  });

  const urls = [...rosterUrls].slice(0, 40);
  await pool(urls, 4, async (url) => {
    const res = await api.get(region, url, "profile");
    for (const m of res.data?.members ?? []) {
      const ch = m.character ?? {};
      if (ch.level) {
        levels.set(`c:${ch.name ?? ch.id}`, ch.level);
      }
    }
    if (!res.data) {
      log(`population: roster ${url} -> ${res.status}`);
    }
  });

  const values = [...levels.values()];
  if (values.length < 10) {
    log(`population: only ${values.length} characters sampled, ignoring`);
    return null;
  }
  const hist = new Array(61).fill(0);
  for (const lv of values) {
    hist[Math.min(60, Math.max(1, lv))]++;
  }
  return {
    sampled: values.length,
    median: median(values),
    pct60: Math.round((hist[60] / values.length) * 1000) / 10,
    hist: hist.slice(1),
  };
}
