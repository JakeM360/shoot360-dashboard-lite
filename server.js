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

// 1) Agency key for listing sub-accounts
const AGENCY_API_KEY = process.env.GHL_API_KEY;
if (!AGENCY_API_KEY) {
  console.error("❌ Missing GHL_API_KEY");
  process.exit(1);
}

// In-memory cache
let locationsCache = [];

// Initialize: load sub-accounts, merge CSV, fetch pipelines & calendars
async function initialize() {
  // A) List sub-accounts
  const locResp = await axios.get(
    "https://rest.gohighlevel.com/v1/locations",
    { headers: { Authorization: `Bearer ${AGENCY_API_KEY}`, "Content-Type": "application/json" } }
  );
  locationsCache = (locResp.data.locations || []).map(l => ({
    id:   l.id,
    name: l.name,
    slug: l.name.replace(/^Shoot 360\s*-\s*/, "").toLowerCase().replace(/\s+/g, "-"),
    apiKey:    null,
    calendars: [],
    pipelines: []
  }));

  // B) Merge per-location API key & calendar IDs from CSV
  await new Promise((resolve, reject) => {
    fs.createReadStream(path.join(__dirname, "secrets", "api_keys.csv"))
      .pipe(csv())
      .on("data", row => {
        const slug = row.location.toLowerCase().trim();
        const loc  = locationsCache.find(x => x.slug === slug);
        if (!loc) return;
        loc.apiKey = row.api_key.trim();
        loc.calendars = [];
        if (row.calendar_youth_id)   loc.calendars.push({ name:"youth",   id: row.calendar_youth_id.trim() });
        if (row.calendar_adult_id)   loc.calendars.push({ name:"adult",   id: row.calendar_adult_id.trim() });
        if (row.calendar_leagues_id) loc.calendars.push({ name:"leagues", id: row.calendar_leagues_id.trim() });
      })
      .on("end", resolve)
      .on("error", reject);
  });

  // C) Fetch pipelines for each location using its own API key
  await Promise.all(locationsCache.map(async loc => {
    if (!loc.apiKey) return;
    try {
      const pResp = await axios.get(
        "https://rest.gohighlevel.com/v1/pipelines/",
        {
          headers: { Authorization: `Bearer ${loc.apiKey}`, "Content-Type": "application/json" },
          params: { locationId: loc.id }
        }
      );
      loc.pipelines = (pResp.data.pipelines || [])
        .filter(p => ["Youth","Adult","Leagues"].includes(p.name))
        .map(p => ({ name:p.name.toLowerCase(), id:p.id }));
    } catch (e) {
      console.error(`⚠ Pipelines error for ${loc.slug}:`, e.response?.data || e.message);
    }
  }));

  console.log("✅ Initialized:", locationsCache.map(l => l.slug));
}

// Helper: last-30-days or query params
function getDateRange(req) {
  const now = Date.now();
  let start = now - 1000*60*60*24*30, end = now;
  if (req.query.startDate && req.query.endDate) {
    const s = Date.parse(req.query.startDate), e = Date.parse(req.query.endDate);
    if (!isNaN(s) && !isNaN(e)) {
      start = s;
      end   = e + 86399999;
    }
  }
  return { start, end };
}

// GET /locations
app.get("/locations", (req, res) => {
  res.json(locationsCache.map(({ id, name, slug }) => ({ id, name, slug })));
});

// GET /stats/:location
app.get("/stats/:location", async (req, res) => {
  const loc = locationsCache.find(x => x.slug === req.params.location.toLowerCase());
  if (!loc)   return res.status(404).json({ error: "Location not found" });
  if (!loc.apiKey) return res.status(500).json({ error: "Missing API key for this location" });

  const { start, end } = getDateRange(req);
  const headers = { Authorization: `Bearer ${loc.apiKey}`, "Content-Type": "application/json" };

  // A) Appointments per calendar (appointments, shows, noShows)
  let combinedAppointments = 0, combinedShows = 0, combinedNoShows = 0;
  const calendarsOut = {};
  await Promise.all(loc.calendars.map(async cal => {
    try {
      const { data } = await axios.get(
        "https://rest.gohighlevel.com/v1/appointments/",
        { headers, params: { calendarId: cal.id, startDate: start, endDate: end } }
      );
      const apps = data.appointments || [];
      const total = apps.length;

      let shows = 0, noShows = 0;
      apps.forEach(a => {
        const st = (a.status || "").toLowerCase();
        if (st === "show") shows++;
        else if (st === "no-show" || st === "no show") noShows++;
      });

      calendarsOut[cal.name] = { appointments: total, shows, noShows };
      combinedAppointments += total;
      combinedShows        += shows;
      combinedNoShows      += noShows;
    } catch (e) {
      console.error(`⚠ Appointments error for calendar ${cal.name}:`, e.response?.data || e.message);
      calendarsOut[cal.name] = { error:true, details:e.response?.data || e.message };
    }
  }));

  // B) Opportunities per pipeline (leads, wins, cold)
  let combinedLeads = 0, combinedWins = 0, combinedCold = 0;
  const pipelinesOut = {};
  await Promise.all(loc.pipelines.map(async p => {
    try {
      const { data } = await axios.get(
        `https://rest.gohighlevel.com/v1/pipelines/${p.id}/opportunities`,
        { headers, params: { locationId: loc.id, startDate: start, endDate: end } }
      );
      const opps = data.opportunities || [];
      const leads = opps.length;
      const wins  = opps.filter(o => o.tags?.includes("won")).length;
      const cold  = opps.filter(o => o.tags?.includes("cold")).length;

      pipelinesOut[p.name] = { leads, wins, cold };
      combinedLeads += leads;
      combinedWins  += wins;
      combinedCold  += cold;
    } catch (e) {
      console.error(`⚠ Opportunities error for pipeline ${p.name}:`, e.response?.data || e.message);
      pipelinesOut[p.name] = { error:true, details:e.response?.data || e.message };
    }
  }));

  // C) Combined totals
  const combined = {
    leads:        combinedLeads,
    appointments: combinedAppointments,
    shows:        combinedShows,
    noShows:      combinedNoShows,
    wins:         combinedWins,
    cold:         combinedCold
  };

  res.json({
    location: loc.name,
    dateRange: {
      startDate: new Date(start).toISOString().slice(0,10),
      endDate:   new Date(end).toISOString().slice(0,10)
    },
    combined,
    calendars: calendarsOut,
    pipelines: pipelinesOut
  });
});

// Start server
initialize()
  .then(() => app.listen(PORT, () => console.log(`🚀 listening on port ${PORT}`)))
  .catch(err => {
    console.error("❌ Initialization failed:", err);
    process.exit(1);
  });
