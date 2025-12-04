// server.js

const express = require("express");
const fetch = require("node-fetch");
const NodeCache = require("node-cache");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.static("public"));

// Base URL uses environment variable OR default
const BASE = process.env.BASE_URL || "https://leaderboard-bice-mu.vercel.app/api/zama";

const PORT = process.env.PORT || 3000;

const TIMEFRAMES = [
  { key: "24h", label: "Last 24 hours" },
  { key: "7d", label: "Last 7 days" },
  { key: "month", label: "Last 30 days" }
];

const CACHE_TTL = 60 * 5; // 5 minutes
const cache = new NodeCache({ stdTTL: CACHE_TTL, checkperiod: 120 });

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Fetch failed ${r.status} ${url}`);
  return r.json();
}

function getArrayFromResponse(json) {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  if (Array.isArray(json.data)) return json.data;
  if (Array.isArray(json.items)) return json.items;

  for (const v of Object.values(json)) {
    if (Array.isArray(v)) return v;
  }
  return [];
}

function normalize(entry, pageIdx, idxInPage, fallbackPageSize = 100) {
  if (!entry || typeof entry !== "object") return null;

  const keys = Object.keys(entry);
  let username = null, mindshare = null, rank = null;

  for (const k of keys) {
    const lk = k.toLowerCase();
    if (lk.includes("username") || lk.includes("user") || lk.includes("handle") ||
        lk.includes("twitter") || lk.includes("name") || lk.includes("creator")) {
      username = String(entry[k]);
      break;
    }
  }

  for (const k of keys) {
    const lk = k.toLowerCase();
    if (lk.includes("mindshare") || lk.includes("score") || lk.includes("ms") ||
        lk.includes("value") || lk.includes("points")) {
      const v = Number(entry[k]);
      if (!Number.isNaN(v)) { mindshare = v; break; }
    }
  }

  for (const k of keys) {
    const lk = k.toLowerCase();
    if (lk.includes("rank") || lk.includes("position")) {
      const v = Number(entry[k]);
      if (!Number.isNaN(v)) { rank = v; break; }
    }
  }

  if (!Number.isFinite(rank)) {
    rank = (pageIdx - 1) * fallbackPageSize + (idxInPage + 1);
  }

  if (typeof username === "string") {
    username = username.trim().replace(/^@/, "");
  } else {
    // fallback: try to find handle-like value in object values
    for (const v of Object.values(entry)) {
      if (typeof v === "string" && v.startsWith("@")) {
        username = v.replace(/^@/, "");
        break;
      }
    }
  }

  return {
    rank,
    username: username || null,
    mindshare: Number.isFinite(mindshare) ? mindshare : null,
    raw: entry
  };
}

async function fetchAllPagesForTimeframe(timeframeKey, maxPages = 20, pageSizeHint = 100) {
  const cacheKey = `tf:${timeframeKey}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const results = [];
  for (let page = 1; page <= maxPages; page++) {
    try {
      const url = `${BASE}?timeframe=${encodeURIComponent(timeframeKey)}&sortBy=mindshare&page=${page}`;
      const json = await fetchJson(url);
      const arr = getArrayFromResponse(json);
      if (!arr || arr.length === 0) break;

      arr.forEach((e, i) => {
        const n = normalize(e, page, i, pageSizeHint);
        if (n && n.username) results.push(n);
      });

    } catch (err) {
      console.warn("fetch page error:", err.message);
      break;
    }
  }

  cache.set(cacheKey, results);
  return results;
}

app.get("/api/check", async (req, res) => {
  try {
    const raw = String(req.query.username || "").trim();
    if (!raw) return res.status(400).json({ error: "missing username" });
    const username = raw.replace(/^@/, "").toLowerCase();

    const all = await Promise.all(
      TIMEFRAMES.map(async tf => ({
        key: tf.key,
        label: tf.label,
        entries: await fetchAllPagesForTimeframe(tf.key, 20, 100)
      }))
    );

    const output = { username, results: {} };

    for (const bucket of all) {
      const entries = bucket.entries || [];
      const you = entries.find(e => e.username && e.username.toLowerCase() === username);

      let rank100 = entries.find(e => e.rank === 100);

      if (!rank100) {
        // try to find 100th by mindshare descending
        const withMs = entries.filter(e => typeof e.mindshare === 'number');
        if (withMs.length >= 100) {
          withMs.sort((a, b) => b.mindshare - a.mindshare);
          rank100 = withMs[99];
        } else {
          const sortedByRank = entries.slice().sort((a,b) => a.rank - b.rank);
          if (sortedByRank.length >= 100) rank100 = sortedByRank[99];
        }
      }

      const obj = { totalFetched: entries.length };

      if (!you) {
        obj.found = false;
        obj.rank100_mindshare = rank100 ? rank100.mindshare : null;
      } else {
        obj.found = true;
        obj.rank = you.rank;
        obj.mindshare = you.mindshare;
        obj.rank100_mindshare = rank100 ? rank100.mindshare : null;
        obj.needed_mindshare =
          rank100 && you.mindshare != null
            ? Math.max(0, rank100.mindshare - you.mindshare)
            : null;
      }

      output.results[bucket.key] = obj;
    }

    res.json(output);
  } catch (err) {
    console.error("API error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
