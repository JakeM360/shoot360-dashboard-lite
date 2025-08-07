// server.js
require("dotenv").config();
const express = require("express");
const axios   = require("axios");
const csv     = require("csv-parser");
const fs      = require("fs");
const path    = require("path");
const cors    = require("cors");

const app = express();
app.use(cors());
const PORT = process.env.PORT || 3000;

// -------------------------
// ENV / Headers
// -------------------------
const AGENCY_KEY = process.env.GHL_API_KEY;
if (!AGENCY_KEY) {
  console.error("❌ Missing GHL_API_KEY");
  process.exit(1);
}
const agencyHeaders = { Authorization: `Bearer ${AGENCY_KEY}`, "Content-Type":"application/json" };

// -------------------------
// CSV → rawLocations (slug → location key)
// -------------------------
const rawLocations = [];
fs.createReadStream(path.join(__dirname, "secrets", "api_keys.csv"))
  .pipe(csv())
  .on("data", row => {
    rawLocations.push({
      csvName: row.location.trim(),
      slug:    row.location.toLowerCase().trim().replace(/\s+/g, "-"),
      apiKey:  (row.api_key || "").trim()
    });
  })
  .on("end", () => console.log("🔑 CSV loaded:", rawLocations.map(r=>r.slug)));

// -------------------------
// Helpers
// -------------------------
function getDateRange(req){
  const now = Date.now();
  let start = now - 1000*60*60*24*30, end = now;
  if (req.query.startDate && req.query.endDate) {
    const s = Date.parse(req.query.startDate);
    const e = Date.parse(req.query.endDate);
    if (!isNaN(s) && !isNaN(e)) {
      start = s; end = e + 86399999;
    }
  }
  return { start, end };
}

async function fetchAllContacts(apiKey, locationId) {
  const all = [];
  let page = 1, perPage = 50;
  while (true) {
    const resp = await axios.get("https://rest.gohighlevel.com/v1/contacts/", {
      headers: { Authorization: `Bearer ${apiKey}` },
      params:  { locationId, page, perPage }
    });
    const batch = resp.data.contacts || [];
    all.push(...batch);
    if (batch.length < perPage) break;
    page++;
  }
  return all;
}

async function fetchAllPipelineOpps(apiKey, locationId, pipelineId) {
  const all = [];
  let page = 1, perPage = 50;
  while (true) {
    const resp = await axios.get(
      `https://rest.gohighlevel.com/v1/pipelines/${pipelineId}/opportunities`,
      { headers: { Authorization:`Bearer ${apiKey}` }, params: { locationId, page, perPage } }
    );
    const batch = resp.data.opportunities || [];
    all.push(...batch);
    if (batch.length < perPage) break;
    page++;
  }
  return all;
}

// simple concurrency limiter (no deps)
async function runWithLimit(items, limit, worker) {
  const results = [];
  let i = 0, active = 0;
  return new Promise((resolve, reject) => {
    const startNext = () => {
      if (i >= items.length && active === 0) return resolve(results);
      while (active < limit && i < items.length) {
        const idx = i++; active++;
        Promise.resolve(worker(items[idx], idx))
          .then(r => { results[idx] = r; active--; startNext(); })
          .catch(err => reject(err));
      }
    };
    startNext();
  });
}

// -------------------------
// Runtime store
// -------------------------
const locations = {}; // slug -> { id, apiKey, pipelines:[{name,id}] }

// cache { key: { ts, data } }
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 mins
const cache = new Map();
const cacheGet = (key) => {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() - item.ts > CACHE_TTL_MS) { cache.delete(key); return null; }
  return item.data;
};
const cacheSet = (key, data) => cache.set(key, { ts: Date.now(), data });

// -------------------------
// Initialization: agency → locations → pipelines
// -------------------------
async function initialize(){
  const { data: ag } = await axios.get("https://rest.gohighlevel.com/v1/locations", { headers: agencyHeaders });
  const agList = ag.locations || [];

  for (const raw of rawLocations){
    const match = agList.find(l => l.name.toLowerCase().includes(raw.csvName.toLowerCase()));
    if (!match) { console.warn(`⚠ No match for "${raw.csvName}"`); continue; }
    locations[raw.slug] = { id: match.id, apiKey: raw.apiKey, pipelines: [] };
  }
  console.log("✅ Locations ready:", Object.keys(locations));

  // fetch Youth/Adult/Leagues pipelines per location
  await Promise.all(Object.entries(locations).map(async ([slug, loc])=>{
    try {
      const r = await axios.get("https://rest.gohighlevel.com/v1/pipelines/", {
        headers: { Authorization:`Bearer ${loc.apiKey}` },
        params: { locationId: loc.id }
      });
      const pipes = (r.data.pipelines||[]).filter(p => ["Youth","Adult","Leagues"].includes(p.name));
      loc.pipelines = pipes.map(p => ({ name: p.name.toLowerCase(), id: p.id }));
    } catch (e) {
      console.error(`❌ pipelines lookup failed for ${slug}:`, e.message);
    }
  }));
  console.log("✅ Pipelines discovered");
}

// -------------------------
// Core: compute stats for ONE location
// -------------------------
async function computeLocationStats(slug, start, end) {
  const loc = locations[slug];
  if (!loc) throw new Error(`Unknown location: ${slug}`);

  const key = `stats:${slug}:${start}:${end}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const combined = { leads:0, appointments:0, shows:0, noShows:0, wins:0, cold:0 };
  const pipelinesOut = {};
  for (const p of loc.pipelines) {
    pipelinesOut[p.name] = { leads:0, appointments:0, shows:0, noShows:0, wins:0, cold:0 };
  }

  // A) HEADCOUNT leads — current cards in Lead columns (no date filter)
  await Promise.all(loc.pipelines.map(async (p)=>{
    try {
      const opps = await fetchAllPipelineOpps(loc.apiKey, loc.id, p.id);
      const headcount = opps.filter(o => (o.stageName || "").toLowerCase().includes("lead")).length;
      pipelinesOut[p.name].leads = headcount;
      combined.leads += headcount;
    } catch (e) {
      console.warn(`⚠ opps fetch failed for ${slug}/${p.name}:`, e.message);
    }
  }));

  // B) Tag-based outcomes — dateUpdated inside window
  try {
    const contacts = await fetchAllContacts(loc.apiKey, loc.id);
    for (const c of contacts) {
      const updated = Date.parse(c.dateUpdated);
      if (updated < start || updated > end) continue;
      const tags = (c.tags || []).map(t => t.toLowerCase());
      const member = loc.pipelines.map(p => p.name).filter(n => tags.includes(n)); // adult/youth/leagues

      if (tags.includes("appointment")) { combined.appointments++; member.forEach(n => pipelinesOut[n].appointments++); }
      if (tags.includes("show"))        { combined.shows++;        member.forEach(n => pipelinesOut[n].shows++); }
      if (tags.includes("no-show"))     { combined.noShows++;      member.forEach(n => pipelinesOut[n].noShows++); }
      if (tags.includes("won"))         { combined.wins++;         member.forEach(n => pipelinesOut[n].wins++); }
      if (tags.includes("cold"))        { combined.cold++;         member.forEach(n => pipelinesOut[n].cold++); }
    }
  } catch (e) {
    console.error(`❌ contacts fetch failed for ${slug}:`, e.message);
  }

  const result = { location: slug, combined, pipelines: pipelinesOut };
  cacheSet(key, result);
  return result;
}

// -------------------------
// Routes
// -------------------------
app.get("/locations", (req,res) => {
  res.json(Object.entries(locations).map(([slug, v]) => ({ slug, id: v.id })));
});

// Single location (kept for compatibility)
app.get("/stats/:location", async (req, res) => {
  const slug = req.params.location.toLowerCase();
  if (!locations[slug]) return res.status(404).json({ error:"Location not configured" });
  const { start, end } = getDateRange(req);
  try {
    const data = await computeLocationStats(slug, start, end);
    res.json({
      location: slug,
      dateRange: {
        startDate: new Date(start).toISOString().slice(0,10),
        endDate:   new Date(end).toISOString().slice(0,10)
      },
      combined: data.combined,
      pipelines: data.pipelines
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error:"Failed to compute stats" });
  }
});

// NEW: aggregate across many locations
// GET /stats?locations=all | beaverton,vancouver&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
app.get("/stats", async (req, res) => {
  const { start, end } = getDateRange(req);
  const allSlugs = Object.keys(locations);
  const pick = (req.query.locations || "all").toLowerCase();
  const slugs = pick === "all" ? allSlugs : pick.split(",").map(s => s.trim()).filter(Boolean);

  // safety: strip unknowns
  const targetSlugs = slugs.filter(s => locations[s]);
  if (targetSlugs.length === 0) return res.status(400).json({ error:"No valid locations selected" });

  try {
    // concurrency limit (e.g., 6 at a time)
    const results = await runWithLimit(targetSlugs, 6, (slug)=>computeLocationStats(slug, start, end));

    // build combined + breakdowns
    const total = { leads:0, appointments:0, shows:0, noShows:0, wins:0, cold:0 };
    const byLocation = {};
    const byPipeline = { adult:{leads:0,appointments:0,shows:0,noShows:0,wins:0,cold:0},
                         youth:{leads:0,appointments:0,shows:0,noShows:0,wins:0,cold:0},
                         leagues:{leads:0,appointments:0,shows:0,noShows:0,wins:0,cold:0} };

    for (const r of results) {
      byLocation[r.location] = r;
      // combined totals
      Object.keys(total).forEach(k => total[k] += r.combined[k] || 0);
      // by pipeline totals
      for (const p of Object.keys(byPipeline)) {
        if (!r.pipelines[p]) continue;
        Object.keys(byPipeline[p]).forEach(k => {
          byPipeline[p][k] += r.pipelines[p][k] || 0;
        });
      }
    }

    res.json({
      selection: targetSlugs,
      dateRange: {
        startDate: new Date(start).toISOString().slice(0,10),
        endDate:   new Date(end).toISOString().slice(0,10)
      },
      combined: total,
      byLocation,
      byPipeline
    });
  } catch (e) {
    console.error("❌ aggregate error:", e);
    res.status(500).json({ error:"Failed to aggregate stats" });
  }
});

// -------------------------
// Boot
// -------------------------
initialize()
  .then(()=>app.listen(PORT, ()=>console.log(`🚀 Listening on ${PORT}`)))
  .catch(err => { console.error("❌ Init failed:", err); process.exit(1); });
