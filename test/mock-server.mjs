// Mock of the Forever endpoints of the Battle.net API, for local testing.
// The simulated hour comes from test/.tick (an integer), so repeated collector runs see time pass.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const curated = JSON.parse(fs.readFileSync(path.join(DIR, "../collector/data/curated.json"), "utf8"));
const PORT = Number(process.env.PORT ?? 8787);
const T0 = Date.UTC(2026, 10, 12, 0, 0, 0) / 1000;

function tick() {
  try {
    return Number(fs.readFileSync(path.join(DIR, ".tick"), "utf8")) || 0;
  } catch {
    return 0;
  }
}

function rand(seed) {
  let x = Math.sin(seed * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}

const NAMES = {
  12360: "Arcanite Bar", 12359: "Thorium Bar", 12363: "Arcane Crystal", 10620: "Thorium Ore", 13510: "Flask of the Titans",
  8846: "Gromsblood", 13468: "Black Lotus", 13423: "Stonescale Oil", 13422: "Stonescale Eel", 14047: "Runecloth",
  14048: "Bolt of Runecloth", 16202: "Lesser Eternal Essence", 16203: "Greater Eternal Essence", 2589: "Linen Cloth",
  2770: "Copper Ore", 2840: "Copper Bar", 13463: "Dreamfoil", 13465: "Mountain Silversage", 8925: "Crystal Vial",
  90001: "Riverglade Silk", 90002: "Bolt of Riverglade Silk", 19019: "Thunderfury",
};

const ITEMS = [...new Set([
  ...Object.keys(curated.materialTags).filter((k) => !k.startsWith("_")).map(Number),
  ...curated.recipes.flatMap((r) => [r.out, ...r.mats.map((m) => m[0])]),
  90001, 90002,
])].filter((id) => !curated.vendorItems.includes(id));

// Like the live API: rulesets carry no names in the index, and every ruleset lists the
// same global houses whose names don't say which ruleset they belong to.
const RULESETS = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 15 }];
const HOUSES = [
  { id: 110, name: "Alliance Auction House", mult: 1.05 },
  { id: 111, name: "Alliance Auction House", mult: 1.0 },
  { id: 112, name: "Alliance Auction House", empty: true },
  { id: 113, name: "Horde Auction House", mult: 0.95 },
  { id: 114, name: "Horde Auction House", mult: 1.12 },
  { id: 115, name: "Horde Auction House", empty: true },
  { id: 116, name: "Blackwater Auction House", mult: 0.85 },
  { id: 117, name: "Blackwater Auction House", mult: 0.8 },
  { id: 118, name: "Blackwater Auction House", empty: true },
  { id: 119, name: "Alliance Auction House", mult: 1.2 },
  { id: 120, name: "Horde Auction House", mult: 1.1 },
  { id: 121, name: "Blackwater Auction House", mult: 0.9 },
];

function basePrice(id) {
  const tag = curated.materialTags[id];
  const tier = tag ? tag[0] : 40;
  return Math.round((200 + tier * tier * 12) * (0.5 + rand(id)));
}

function commodityAuctions(house, t) {
  const out = [];
  ITEMS.forEach((itemId, i) => {
    const r = rand(itemId * 7 + house.id);
    if (r < 0.08) {
      return; // not listed on this house
    }
    const drift = (rand(itemId) - 0.5) * 0.03; // per hour
    const neutralNoise = house.name.includes("Blackwater") ? 0.6 + rand(itemId + house.id) : 1;
    const p0 = basePrice(itemId) * house.mult * neutralNoise * (1 + drift * t);
    const listings = house.name.includes("Blackwater") ? 3 : 12;
    const soldPerHour = Math.floor(rand(itemId + 3) * 3);
    const firstAlive = soldPerHour * t;
    for (let j = firstAlive; j < firstAlive + listings; j++) {
      out.push({
        id: house.id * 1e7 + i * 1000 + j,
        item: { id: itemId },
        quantity: 1 + Math.floor(rand(itemId + j) * 20),
        unit_price: Math.max(1, Math.round(p0 * (1 + (j - firstAlive) * 0.04))),
        time_left: ["VERY_LONG", "LONG", "LONG", "MEDIUM"][j % 4],
      });
    }
  });
  return out;
}

function gearAuctions(house, t) {
  return [0, 1, 2].map((j) => ({
    id: house.id * 1e7 + 900000 + j + t * 3,
    item: { id: 19019, bonus_lists: j === 2 ? [101] : undefined },
    buyout: 50000000 * (j + 1),
    quantity: 1,
    time_left: "VERY_LONG",
  }));
}

function json(res, code, body, headers = {}) {
  res.writeHead(code, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname.replace(/\/+$/, "") || "/";
  const t = tick();
  const lm = new Date((T0 + t * 3600) * 1000).toUTCString();
  let m;

  if (req.method === "POST" && p === "/token") {
    return json(res, 200, { access_token: "mock", expires_in: 86400 });
  }
  if (p === "/data/wow/ruleset/index") {
    return json(res, 200, { _links: {}, rulesets: RULESETS.map((r) => ({ key: { href: "x" }, ...r })) });
  }
  if ((m = p.match(/^\/data\/wow\/ruleset\/(\d+)\/auctions$/))) {
    // Like the live API: every ruleset lists the same global houses.
    return json(res, 200, {
      auctions: HOUSES.map((h) => ({
        key: { href: `https://us.api.blizzard.com/data/wow/ruleset/${m[1]}/auctions/${h.id}?namespace=dynamic-forever-us` },
        name: h.name,
        id: h.id,
      })),
    });
  }
  if ((m = p.match(/^\/data\/wow\/ruleset\/(\d+)\/auctions\/(\d+)(\/commodities)?$/))) {
    const h = HOUSES.find((x) => x.id === Number(m[2]));
    if (!h || !RULESETS.some((r) => r.id === Number(m[1]))) {
      return json(res, 404, { code: 404 });
    }
    if (h.empty) {
      return m[3] ? json(res, 200, {}, { "Last-Modified": lm }) : json(res, 200, { id: h.id, name: h.name, ruleset: { key: { href: "x" }, id: Number(m[1]) } }, { "Last-Modified": lm });
    }
    if (req.headers["if-modified-since"] === lm) {
      res.writeHead(304);
      return res.end();
    }
    if (m[3]) {
      return json(res, 200, { auctions: commodityAuctions(h, t) }, { "Last-Modified": lm });
    }
    return json(res, 200, {
      id: h.id, name: h.name, ruleset: { key: { href: "x" }, id: Number(m[1]) },
      auctions: gearAuctions(h, t), commodities: { href: "x" },
    }, { "Last-Modified": lm });
  }
  if ((m = p.match(/^\/data\/wow\/item\/(\d+)$/))) {
    const id = Number(m[1]);
    // Like the live API, Forever's item endpoint misses many ids; Classic Era has them.
    if (id % 3 === 0 && !(u.searchParams.get("namespace") ?? "").includes("classic")) {
      return json(res, 404, { code: 404 });
    }
    const tag = curated.materialTags[id];
    const isPotion = tag && tag[1] === "endgame-consumable" && id > 13000 && id < 13600;
    return json(res, 200, {
      id,
      name: NAMES[id] ?? `Item ${id}`,
      quality: { type: id === 19019 ? "LEGENDARY" : "COMMON" },
      sell_price: Math.round(basePrice(id) * 0.1),
      purchase_price: curated.vendorItems.includes(id) ? 2000 : basePrice(id) * 4,
      item_class: { id: id === 19019 ? 2 : isPotion ? 0 : 7 },
      item_subclass: { id: 0 },
      level: tag ? tag[0] : 50,
      required_level: id === 90002 ? 58 : 0,
    });
  }
  if (p === "/data/wow/profession/index") {
    return json(res, 200, { professions: [{ id: 197, name: "Tailoring" }] });
  }
  if (p === "/data/wow/profession/197") {
    return json(res, 200, { skill_tiers: [{ id: 1, name: "Tailoring" }] });
  }
  if (p === "/data/wow/profession/197/skill-tier/1") {
    return json(res, 200, { categories: [{ name: "Cloth", recipes: [{ id: 5001, name: "Bolt of Riverglade Silk" }, { id: 5002, name: "Bolt of Runecloth" }] }] });
  }
  if (p === "/data/wow/recipe/5001") {
    return json(res, 200, { id: 5001, name: "Bolt of Riverglade Silk", crafted_item: { id: 90002 }, crafted_quantity: { value: 1 }, reagents: [{ reagent: { id: 90001 }, quantity: 4 }, { reagent: { id: 14341 }, quantity: 1 }] });
  }
  if (p === "/data/wow/recipe/5002") {
    return json(res, 200, { id: 5002, name: "Bolt of Runecloth", crafted_item: { id: 14048 }, crafted_quantity: { value: 1 }, reagents: [{ reagent: { id: 14047 }, quantity: 5 }] });
  }
  return json(res, 404, { code: 404, path: p });
});

server.listen(PORT, () => console.log(`mock api on :${PORT}`));
