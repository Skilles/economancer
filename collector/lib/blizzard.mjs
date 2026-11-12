import { sleep } from "./util.mjs";

/**
 * Minimal Battle.net API client for WoW: Forever.
 * Namespaces: static-forever-{region}, dynamic-forever-{region}, profile-forever-{region}.
 * BLIZZARD_API_BASE / BLIZZARD_OAUTH_URL can point at a mock server for tests.
 */
export class Blizzard {
  constructor({ clientId, clientSecret, apiBase, oauthUrl }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.apiBase = apiBase; // e.g. "https://{region}.api.blizzard.com"
    this.oauthUrl = oauthUrl ?? "https://oauth.battle.net/token";
    this.token = null;
    this.tokenExpires = 0;
    this.requests = 0;
  }

  async getToken() {
    if (this.token && Date.now() < this.tokenExpires - 60_000) {
      return this.token;
    }
    const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    const res = await fetch(this.oauthUrl, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) {
      throw new Error(`OAuth failed: ${res.status} ${await res.text()}`);
    }
    const body = await res.json();
    this.token = body.access_token;
    this.tokenExpires = Date.now() + body.expires_in * 1000;
    return this.token;
  }

  url(region, pathOrHref, kind) {
    if (pathOrHref.startsWith("http")) {
      // Blizzard "href" links already carry the namespace.
      const u = new URL(pathOrHref);
      if (this.apiBase.includes("localhost") || this.apiBase.includes("127.0.0.1")) {
        const base = new URL(this.apiBase.replace("{region}", region));
        u.protocol = base.protocol;
        u.host = base.host;
      }
      u.searchParams.set("locale", "en_US");
      return u.toString();
    }
    const base = this.apiBase.replace("{region}", region);
    const sep = pathOrHref.includes("?") ? "&" : "?";
    return `${base}${pathOrHref}${sep}namespace=${kind}-forever-${region}&locale=en_US`;
  }

  /**
   * GET with retries. Returns { status, data, lastModified }.
   * status 304 => not modified (data null). 404 => data null.
   */
  async get(region, path, kind = "dynamic", { ifModifiedSince, retries = 4 } = {}) {
    const url = this.url(region, path, kind);
    for (let attempt = 0; ; attempt++) {
      const token = await this.getToken();
      const headers = { Authorization: `Bearer ${token}`, "Accept-Encoding": "gzip" };
      if (ifModifiedSince) {
        headers["If-Modified-Since"] = ifModifiedSince;
      }
      let res;
      try {
        this.requests++;
        res = await fetch(url, { headers });
      } catch (err) {
        if (attempt >= retries) {
          throw err;
        }
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (res.status === 304) {
        return { status: 304, data: null, lastModified: ifModifiedSince };
      }
      if (res.status === 404 || res.status === 403) {
        return { status: res.status, data: null, lastModified: null };
      }
      if (res.status === 401 && attempt < retries) {
        this.token = null;
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await sleep(1500 * 2 ** attempt);
        continue;
      }
      if (!res.ok) {
        throw new Error(`GET ${url} -> ${res.status}`);
      }
      const data = await res.json();
      return { status: res.status, data, lastModified: res.headers.get("last-modified") };
    }
  }
}

/** Find the first array of {id,...} objects in a Blizzard index response. */
export function findIndexArray(obj) {
  if (!obj || typeof obj !== "object") {
    return [];
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === "_links") {
      continue;
    }
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object" && "id" in v[0]) {
      return v;
    }
  }
  return [];
}

/** Blizzard names are strings with locale set, objects without. */
export function nameOf(n) {
  if (n == null) {
    return "";
  }
  if (typeof n === "string") {
    return n;
  }
  return n.en_US ?? Object.values(n)[0] ?? "";
}
