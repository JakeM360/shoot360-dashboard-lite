require("dotenv").config();
const express = require("express");
const axios = require("axios");
const csv = require("csv-parser");
const fs = require("fs");
const path = require("path");
const cors = require("cors");

const app = express();
app.use(cors());
const PORT = process.env.PORT || 3000;

// --- ENV ---
const AGENCY_KEY = process.env.GHL_AGENCY_KEY || process.env.GHL_API_KEY;
if (!AGENCY_KEY) {
  console.error("❌ Missing GHL_AGENCY_KEY (or GHL_API_KEY). Set it in Render.");
  process.exit(1);
}
const agencyHeaders = { Authorization: `Bearer ${AGENCY_KEY}`, "Content-Type": "application/json" };

// --- CSV: slug -> location-level key ---
const csvRows = [];
const CSV_PATH = path.join(__dirname, "secrets", "api_keys.csv");
/*
CSV template:
location,api_key
Beaverton,<location_api_key_here>
Vancouver,<location_api_key_here>
*/
fs.createReadStream(CSV_PATH)
  .pipe(csv())
  .on("data", r => csvRows.push({
    name: r.location.trim(),
    slug: r.location.toLowerCase().trim().replace(/\s+/g, "-"),
    apiKey: r.api_key.trim()
  }))
  .on("end", () => console.log("🔑 CSV loaded:", csvRows.map(r => r.slug)));

// --- utils ---
function dateRange(req) {
  const now = Date.now();
  let start = now - 1000 * 60 * 60 * 24 * 30;
  let end = now;
  if (req.query.startDate && req.query.endDate) {
    const s = Date.parse(req.query.startDate);
    const e = Date.parse(req.query.endDate);
    if (!isNaN(s) && !isNaN(e)) {
      start = s;
      end = e + 86399999;
    }
  }
  return { start, end };
}
async function fetchAll(url, headers, params = {}, listKey = "contacts") {
  const all = [];
  let page = 1, perPage = 50;
  while (true) {
    const { data } = await axios.get(url, { headers, params: { ...params, page, perPage } });
    const batch = data[listKey] || [];
    all.push(...batch);
    if (batch.length < perPage) break;
    page++;
  }
  return all;
}

// --- runtime store ---
const LOCS = {}; // slug -> { id, apiKey, pipelines:[{name,id}] }

// --- init: agency locations + pipelines ---
async function init() {
  // A) list sub-accounts
  const { data } = await axios.get("https://rest.gohighlevel.com/v1/locations", { headers: agencyHeaders });
  const ghLocs = data.locations || [];

  // B) merge CSV keys
  for (const row of csvRows) {
    const match = ghLocs.find(l => l.name.toLowerCase().includes(row.name.toLowerCase()));
    if (!match) { console.warn(`⚠ No GHL match for "${row.name}"`); continue; }
    LOCS[row.slug] = { id: match.id, apiKey: row.apiKey, pipelines: [] };
  }
  console.log("✅ Locations:", Object.keys(LOCS));

  // C) discover Youth/Adult/Leagues pipelines (names must match)
  await Promise.all(Object.entries(LOCS).map(async ([slug, loc]) => {
    try {
      const { data } = await axios.get("https://rest.gohighlevel.com/v1/pipelines/", {
        headers: { Authorization: `Bearer ${loc.apiKey}` },
        params: { locationId: loc.id }
      });
      loc.pipelines = (data.pipelines || [])
        .filter(p => ["Youth", "Adult", "Leagues"].includes(p.name))
        .map(p => ({ name: p.name.toLowerCase(), id: p.id }));
    } catch (e) {
      console.error(`❌ pipelines lookup failed for ${slug}:`, e.response?.data || e.message);
    }
  }));
  console.log("✅ Pipelines discovered");
}

// --- core per-location computation (clean) ---
async function computeOne(slug, start, end) {
  const loc = LOCS[slug];
  if (!loc) throw new Error(`Unknown location: ${slug}`);

  const combined = { leads:0, appointments:0, shows:0, noShows:0, wins:0, cold:0 };
  const byPipe = {};
  loc.pipelines.forEach(p => byPipe[p.name] = { leads:0, appointments:0, shows:0, noShows:0, wins:0, cold:0 });

  // A) Leads = current headcount in Lead column per pipeline (no date filter)
  for (const p of loc.pipelines) {
    try {
      const opps = await fetchAll(
        `https://rest.gohighlevel.com/v1/pipelines/${p.id}/opportunities`,
        { Authorization: `Bearer ${loc.apiKey}` },
        { locationId: loc.id },
        "opportunities"
      );
      const headcount = opps.filter(o => (o.stageName || "").toLowerCase().includes("lead")).length;
      byPipe[p.name].leads = headcount;
      combined.leads += headcount;
    } catch (e) {
      console.warn(`⚠ opps fetch failed for ${slug}/${p.name}:`, e.response?.data || e.message);
    }
  }

  // B) Outcomes via contacts + dateUpdated in window
  let contacts = [];
  try {
    contacts = await fetchAll(
      "https://rest.gohighlevel.com/v1/contacts/",
      { Authorization: `Bearer ${loc.apiKey}` },
      { locationId: loc.id },
      "contacts"
    );
  } catch (e) {
    console.error(`❌ contacts fetch failed for ${slug}:`, e.response?.data || e.message);
  }

  for (const c of contacts) {
    const updated = Date.parse(c.dateUpdated);
    if (isNaN(updated) || updated < start || updated > end) continue;

    const tags = (c.tags || []).map(t => t.toLowerCase());
    const member = loc.pipelines.map(p => p.name).filter(n => tags.includes(n));

    if (tags.includes("appointment")) { combined.appointments++; member.forEach(n => byPipe[n].appointments++); }
    if (tags.includes("show"))        { combined.shows++;        member.forEach(n => byPipe[n].shows++); }
    if (tags.includes("no-show"))     { combined.noShows++;      member.forEach(n => byPipe[n].noShows++); }
    if (tags.includes("won"))         { combined.wins++;         member.forEach(n => byPipe[n].wins++); }
    if (tags.includes("cold"))        { combined.cold++;         member.forEach(n => byPipe[n].cold++); }
  }

  return { location: slug, combined, pipelines: byPipe };
}

// --- endpoints ---
app.get("/health", (req,res)=>res.json({ ok:true }));

app.get("/locations", (req,res)=>{
  res.json(Object.entries(LOCS).map(([slug, v]) => ({ slug, id: v.id })));
});

// single location
app.get("/stats/:location", async (req,res)=>{
  const slug = req.params.location.toLowerCase();
  if (!LOCS[slug]) return res.status(404).json({ error:"Unknown location" });
  const { start, end } = dateRange(req);
  try {
    const r = await computeOne(slug, start, end);
    res.json({
      location: slug,
      dateRange: {
        startDate: new Date(start).toISOString().slice(0,10),
        endDate:   new Date(end).toISOString().slice(0,10)
      },
      combined: r.combined,
      pipelines: r.pipelines
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error:"Failed to compute stats" });
  }
});

// aggregate many locations (or all)
app.get("/stats", async (req,res)=>{
  const { start, end } = dateRange(req);
  const pick = (req.query.locations || "all").toLowerCase();
  const wanted = pick === "all"
    ? Object.keys(LOCS)
    : pick.split(",").map(s=>s.trim()).filter(Boolean).filter(s=>LOCS[s]);

  if (!wanted.length) return res.status(400).json({ error:"No valid locations" });

  try {
    const results = await Promise.all(wanted.map(slug => computeOne(slug, start, end)));
    const combined = { leads:0, appointments:0, shows:0, noShows:0, wins:0, cold:0 };
    const byPipeline = { adult:{leads:0,appointments:0,shows:0,noShows:0,wins:0,cold:0},
                         youth:{leads:0,appointments:0,shows:0,noShows:0,wins:0,cold:0},
                         leagues:{leads:0,appointments:0,shows:0,noShows:0,wins:0,cold:0} };
    for (const r of results) {
      Object.keys(combined).forEach(k => combined[k] += r.combined[k] || 0);
      for (const p of Object.keys(byPipeline)) {
        if (!r.pipelines[p]) continue;
        Object.keys(byPipeline[p]).forEach(k => {
          byPipeline[p][k] += r.pipelines[p][k] || 0;
        });
      }
    }
    res.json({
      selection: wanted,
      dateRange: {
        startDate: new Date(start).toISOString().slice(0,10),
        endDate:   new Date(end).toISOString().slice(0,10)
      },
      combined,
      byPipeline,
      byLocation: Object.fromEntries(results.map(r => [r.location, r]))
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error:"Aggregation failed" });
  }
});

// boot
init()
  .then(()=>app.listen(PORT, ()=>console.log(`🚀 Listening on ${PORT}`)))
  .catch(err => { console.error("❌ Init failed:", err); process.exit(1); });
