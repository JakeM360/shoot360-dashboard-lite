// server.js
require("dotenv").config();
const express = require("express");
const axios   = require("axios");
const csv     = require("csv-parser");
const fs      = require("fs");
const path    = require("path");
const cors    = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());

// 1) Agency key to list locations
const AGENCY_API_KEY = process.env.GHL_API_KEY;
if (!AGENCY_API_KEY) {
  console.error("❌ Missing GHL_API_KEY");
  process.exit(1);
}
const agencyHeaders = {
  Authorization: `Bearer ${AGENCY_API_KEY}`,
  "Content-Type": "application/json"
};

// In‐memory cache
let locationsCache = [];

// 2) Initialize: fetch locations, merge API keys & calendars, then pipelines
async function initialize() {
  // A) List sub‐accounts
  const { data: locData } = await axios.get(
    "https://rest.gohighlevel.com/v1/locations",
    { headers: agencyHeaders }
  );
  locationsCache = (locData.locations || []).map(l => {
    const raw = l.name.replace(/^Shoot 360\s*-\s*/, "");
    return { id: l.id, name: l.name, slug: raw.toLowerCase().replace(/\s+/g, "-"), apiKey: null, calendars: [], pipelines: [] };
  });

  // B) Merge each sub-account’s API key & calendars from CSV
  await new Promise((resolve, reject) => {
    fs.createReadStream(path.join(__dirname, "secrets", "api_keys.csv"))
      .pipe(csv())
      .on("data", row => {
        const slug = row.location.toLowerCase().trim();
        const loc  = locationsCache.find(x => x.slug === slug);
        if (!loc) return;
        loc.apiKey = row.api_key.trim();
        loc.calendars = [];
        if (row.calendar_youth_id)   loc.calendars.push({ name: "youth",  id: row.calendar_youth_id.trim() });
        if (row.calendar_adult_id)   loc.calendars.push({ name: "adult",  id: row.calendar_adult_id.trim() });
        if (row.calendar_leagues_id) loc.calendars.push({ name: "leagues",id: row.calendar_leagues_id.trim() });
      })
      .on("end", resolve)
      .on("error", reject);
  });

  // C) For each location, fetch its pipelines (Youth, Adult, Leagues)
  await Promise.all(locationsCache.map(async loc => {
    if (!loc.apiKey) return;
    const headers = { Authorization: `Bearer ${loc.apiKey}`, "Content-Type":"application/json" };
    try {
      const { data: pData } = await axios.get(
        "https://rest.gohighlevel.com/v1/pipelines/",
        { headers, params:{ locationId: loc.id } }
      );
      loc.pipelines = (pData.pipelines || [])
        .filter(p => ["Youth","Adult","Leagues"].includes(p.name))
        .map(p => ({ name: p.name.toLowerCase(), id: p.id }));
    } catch (e) {
      console.error(`⚠ Pipelines error for ${loc.slug}:`, e.response?.data || e.message);
    }
  }));

  console.log("✅ Initialized:", locationsCache.map(l => l.slug));
}

// 3) Date-range helper
function getDateRange(req) {
  const now = Date.now();
  let start = now - 1000*60*60*24*30, end = now;
  if (req.query.startDate && req.query.endDate) {
    const s = Date.parse(req.query.startDate),
          e = Date.parse(req.query.endDate);
    if (!isNaN(s) && !isNaN(e)) {
      start = s;
      end   = e + 86399999;
    }
  }
  return { start, end };
}

// 4) /locations
app.get("/locations", (req, res) => {
  res.json(locationsCache.map(({ id, name, slug }) => ({ id, name, slug })));
});

// 5) /stats/:location
app.get("/stats/:location", async (req, res) => {
  const loc = locationsCache.find(l => l.slug === req.params.location.toLowerCase());
  if (!loc) return res.status(404).json({ error:"Location not found" });
  if (!loc.apiKey) return res.status(500).json({ error:"Missing API key" });

  const { start, end } = getDateRange(req);
  const headers = { Authorization: `Bearer ${loc.apiKey}`, "Content-Type":"application/json" };

  // Combined counters
  const combined = { leads:0, appointments:0, shows:0, noShows:0, wins:0, cold:0 };
  const pipelinesOut = {};

  // Loop each pipeline
  await Promise.all(loc.pipelines.map(async p => {
    try {
      // Fetch opportunities for this pipeline
      const { data: oData } = await axios.get(
        `https://rest.gohighlevel.com/v1/pipelines/${p.id}/opportunities`,
        { headers, params:{ locationId: loc.id, startDate:start, endDate:end } }
      );
      const opps = oData.opportunities || [];

      // Count leads = “open” opportunities
      const leads   = opps.filter(o => o.status==="open").length;
      // Count won/cold via tags
      const wins    = opps.filter(o => o.tags?.includes("won")).length;
      const cold    = opps.filter(o => o.tags?.includes("cold")).length;
      // Count shows/no-shows via tags
      const shows   = opps.filter(o => o.tags?.includes("show")).length;
      const noShows = opps.filter(o => o.tags?.includes("no-show")).length;
      // Count appointments = total opps
      const total   = opps.length;

      pipelinesOut[p.name] = { leads, appointments: total, shows, noShows, wins, cold };

      // Add into combined
      combined.leads       += leads;
      combined.appointments+= total;
      combined.shows       += shows;
      combined.noShows     += noShows;
      combined.wins        += wins;
      combined.cold        += cold;
    } catch (e) {
      console.error(`⚠ Pipeline ${p.name} error:`, e.response?.data||e.message);
      pipelinesOut[p.name] = { error:true, details: e.response?.data||e.message };
    }
  }));

  return res.json({
    location: loc.name,
    dateRange:{ startDate:new Date(start).toISOString().slice(0,10), endDate:new Date(end).toISOString().slice(0,10) },
    combined,
    pipelines: pipelinesOut
  });
});

// 6) Start
initialize()
  .then(()=> app.listen(PORT, ()=>console.log(`🚀 listening on port ${PORT}`)))
  .catch(err=>{ console.error("❌ init failed:", err); process.exit(1); });
