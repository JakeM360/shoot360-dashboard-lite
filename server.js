// server.js
require("dotenv").config();
const express = require("express");
const axios   = require("axios");
const cors    = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());

// Your agency‐level key in Render’s env vars
const GHL_API_KEY = process.env.GHL_API_KEY;
if (!GHL_API_KEY) {
  console.error("❌ Missing GHL_API_KEY in environment");
  process.exit(1);
}
const ghHeaders = {
  Authorization: `Bearer ${GHL_API_KEY}`,
  "Content-Type": "application/json",
};

// In‐memory cache for sub‐accounts
let locationsCache = [];

// STEP A: Load all locations on startup
async function loadLocations() {
  try {
    const resp = await axios.get("https://rest.gohighlevel.com/v1/locations", {
      headers: ghHeaders,
    });
    locationsCache = (resp.data.locations || []).map((loc) => {
      const raw = loc.name.replace(/^Shoot 360\s*-\s*/, "");
      return {
        id:   loc.id,
        name: loc.name,
        slug: raw.toLowerCase().replace(/\s+/g, "-"),
      };
    });
    console.log("✅ Locations:", locationsCache.map((l) => l.slug));
  } catch (e) {
    console.error("❌ Error loading locations:", e.response?.data || e.message);
  }
}

// STEP B: Default to last 30 days
function getDateRange(req) {
  const now = Date.now();
  let start = now - 1000*60*60*24*30, end = now;
  if (req.query.startDate && req.query.endDate) {
    const s = Date.parse(req.query.startDate);
    const e = Date.parse(req.query.endDate);
    if (!isNaN(s) && !isNaN(e)) {
      start = s;
      end   = e + 86399999;
    }
  }
  return { start, end };
}

// STEP C: Return all locations
app.get("/locations", (req, res) => {
  res.json(locationsCache);
});

// STEP D: Stats per‐location
app.get("/stats/:location", async (req, res) => {
  const slug = req.params.location.toLowerCase();
  const loc  = locationsCache.find((l) => l.slug === slug);
  if (!loc) return res.status(404).json({ error: "Location not found" });

  const { start, end } = getDateRange(req);

  // 1) LEADS via Contacts endpoint
  let leads = 0;
  try {
    const cRes = await axios.get("https://rest.gohighlevel.com/v1/contacts/", {
      headers: ghHeaders,
      params: { locationId: loc.id, startDate: start, endDate: end },
    });
    leads = Array.isArray(cRes.data.contacts) ? cRes.data.contacts.length : 0;
  } catch (e) {
    console.error("⚠ Contacts error:", e.response?.data || e.message);
  }

  // Prepare combined metrics
  const combined = { leads, appointments: 0, shows: 0, noShows: 0, wins: 0, cold: 0 };
  const pipelineStats = {};

  try {
    // 2) Get pipelines for this location
    const pRes = await axios.get("https://rest.gohighlevel.com/v1/pipelines/", {
      headers: ghHeaders,
      params: { locationId: loc.id },
    });
    const pipelines = (pRes.data.pipelines || []).filter(p =>
      ["Youth","Adult","Leagues"].includes(p.name)
    );

    // 3) Fetch opportunities per pipeline
    await Promise.all(pipelines.map(async (p) => {
      try {
        const oRes = await axios.get("https://rest.gohighlevel.com/v1/opportunities/", {
          headers: ghHeaders,
          params: {
            locationId: loc.id,
            pipelineId: p.id,
            startDate:  start,
            endDate:    end
          }
        });
        const opps = Array.isArray(oRes.data.opportunities) ? oRes.data.opportunities : [];

        // Tally by tag
        const total   = opps.length;
        const shows   = opps.filter(o => o.tags?.includes("show")).length;
        const noShows = opps.filter(o => o.tags?.includes("no-show")).length;
        const wins    = opps.filter(o => o.tags?.includes("won")).length;
        const cold    = opps.filter(o => o.tags?.includes("cold")).length;

        pipelineStats[p.name.toLowerCase()] = { total, shows, noShows, wins, cold };

        // Add into combined
        combined.appointments += total;
        combined.shows        += shows;
        combined.noShows      += noShows;
        combined.wins         += wins;
        combined.cold         += cold;
      } catch (e) {
        console.error(`⚠ Pipeline ${p.name} error:`, e.response?.data || e.message);
        pipelineStats[p.name.toLowerCase()] = { error:true, details: e.response?.data||e.message };
      }
    }));
  } catch (e) {
    console.error("❌ Pipeline fetch error:", e.response?.data || e.message);
  }

  // 4) Return JSON
  res.json({
    location:  loc.name,
    dateRange: {
      startDate: new Date(start).toISOString().slice(0,10),
      endDate:   new Date(end).toISOString().slice(0,10)
    },
    combined,
    pipelines: pipelineStats
  });
});

// STEP E: Start after loading locations
loadLocations().then(() => {
  app.listen(PORT, () => console.log(`🚀 Listening on port ${PORT}`));
});
