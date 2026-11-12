import { promises as fs } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export const DAY = 86400;
export const BUCKET = 3 * 3600;

export function dayOf(epochSec) {
  return Math.floor(epochSec / DAY);
}

export function bucketOf(epochSec) {
  return Math.floor(epochSec / BUCKET);
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function readJson(file, fallback) {
  try {
    let buf = await fs.readFile(file);
    if (file.endsWith(".gz")) {
      buf = await gunzip(buf);
    }
    return JSON.parse(buf.toString("utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(`warn: could not read ${file}: ${err.message}`);
    }
    return fallback;
  }
}

export async function writeJson(file, data) {
  await ensureDir(path.dirname(file));
  let buf = Buffer.from(JSON.stringify(data));
  if (file.endsWith(".gz")) {
    buf = await gzip(buf);
  }
  await fs.writeFile(file, buf);
}

/** Run async fn over items with limited concurrency. */
export async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) {
        return;
      }
      results[i] = await fn(items[i], i);
    }
  }
  const workers = [];
  for (let w = 0; w < Math.min(limit, items.length); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

export function median(values) {
  if (values.length === 0) {
    return null;
  }
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
