import { findIndexArray, nameOf } from "./blizzard.mjs";
import { pool } from "./util.mjs";

/**
 * Discover profession recipes from the static-forever namespace.
 * Returns [] if the endpoints are missing or empty (Classic APIs have been patchy).
 */
export async function discoverRecipes(api, region, log) {
  const idx = await api.get(region, "/data/wow/profession/index", "static");
  const professions = findIndexArray(idx.data);
  if (professions.length === 0) {
    log(`recipes: no profession index (${idx.status})`);
    return [];
  }
  const recipeRefs = [];
  for (const p of professions) {
    const prof = await api.get(region, `/data/wow/profession/${p.id}`, "static");
    const tiers = prof.data?.skill_tiers ?? [];
    for (const t of tiers) {
      const tier = await api.get(region, `/data/wow/profession/${p.id}/skill-tier/${t.id}`, "static");
      for (const cat of tier.data?.categories ?? []) {
        for (const r of cat.recipes ?? []) {
          recipeRefs.push({ id: r.id, prof: nameOf(p.name) });
        }
      }
    }
  }
  log(`recipes: ${recipeRefs.length} recipe refs across ${professions.length} professions`);

  const out = [];
  await pool(recipeRefs, 12, async (ref) => {
    try {
      const res = await api.get(region, `/data/wow/recipe/${ref.id}`, "static");
      const r = res.data;
      if (!r) {
        return;
      }
      const item = r.crafted_item ?? r.alliance_crafted_item ?? r.horde_crafted_item;
      const reagents = (r.reagents ?? [])
        .filter((x) => x.reagent?.id && x.quantity > 0)
        .map((x) => [x.reagent.id, x.quantity]);
      if (!item?.id || reagents.length === 0) {
        return;
      }
      const cq = r.crafted_quantity ?? {};
      const outQty = cq.value ?? (cq.minimum && cq.maximum ? (cq.minimum + cq.maximum) / 2 : 1);
      const names = { [item.id]: nameOf(item.name) };
      for (const x of r.reagents ?? []) {
        if (x.reagent?.id) {
          names[x.reagent.id] = nameOf(x.reagent.name);
        }
      }
      out.push({ id: r.id, name: nameOf(r.name), prof: ref.prof, out: item.id, outQty, mats: reagents, names, src: "api" });
    } catch (err) {
      log(`recipes: ${ref.id} failed: ${err.message}`);
    }
  });
  return out;
}

export function mergeRecipes(apiRecipes, curated) {
  const seen = new Set();
  const all = [];
  const sig = (r) => `${r.out}|${[...r.mats].sort((a, b) => a[0] - b[0]).map((m) => m.join("x")).join(",")}`;
  for (const r of apiRecipes) {
    seen.add(sig(r));
    all.push(r);
  }
  for (const r of curated) {
    if (!seen.has(sig(r))) {
      all.push({ ...r, src: "curated" });
    }
  }
  return all;
}
