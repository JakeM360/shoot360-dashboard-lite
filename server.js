// server.js
require("dotenv").config();
const express = require("express");
const axios   = require("axios");
const cors    = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());

// Load your agency API key from Render env vars
const GHL_API_KEY = process.env.GHL_API_KEY;
if (!GHL_API_KEY) {
  console.error("❌ Missing GHL_API_KEY in environment");
  process.exit(1);
}
const ghHeaders = {
  Authorization: `Bearer ${GHL_API_KEY}`,
  "Content-Type": "application/json",
};

// In-memory cache of locations
let locationsCache = [];

// STEP A: Load all sub-account locations on startup
async function loadLocations() {
  try {
    const resp = await axios.get("https://rest.gohighlevel.com/v1/locations", {
      headers: ghHeaders,
    });
    // Expecting { locations: [ { id, name, ... }, ... ] }
    locationsCache = (resp.data.locations || []).map((loc) => ({
      id:   loc.id,
      name: loc.name,
      slug: loc.name.toLowerCase().replace(/\s+/g, "-"),
    }));
    console.log("✅ Loaded locations:", locationsCache.map((l) => l.slug));
  } catch (e) {
    console.error("❌ Error loading locations:", e.response?.data || e.message);
  }
}

// STEP B: Helper for default date range (last 30 days)
function getDefaultDateRange() {
  const end = Date.now();
  const start = end - 1000 * 60 * 60 * 24 * 30;
  return { start, end };
}

// STEP C: /locations endpoint
app.get("/locations", (req, res) => {
  res.json(locationsCache);
});

// STEP D: /stats/:location endpoint
app.get("/stats/:location", async (req, res) => {
  const slug = req.params.location.toLowerCase();
  const loc  = locationsCache.find((l) => l.slug === slug);
  if (!loc) return res.status(404).json({ error: "Location not found" });

  // Parse date range from query or default to last 30 days
  let { startDate, endDate } = req.query;
  let startTs, endTs;
  if (startDate && endDate) {
    startTs = Date.parse(startDate);
    endTs   = Date.parse(endDate) + 86399999;
  } else {
    ({ start: startTs, end: endTs } = getDefaultDateRange());
  }
  if (isNaN(startTs) || isNaN(endTs)) {
    return res.status(400).json({ error: "Invalid date format" });
  }

  try {
    // 1) Fetch all opportunities for Leads count
    const allOpp = await axios.get("https://rest.gohighlevel.com/v1/opportunities/", {
      headers: ghHeaders,
      params: { locationId: loc.id, startDate: startTs, endDate: endTs },
    });
    const oppsAll = Array.isArray(allOpp.data.opportunities)
      ? allOpp.data.opportunities
      : [];
    const combined = {
      leads:       oppsAll.length,
      appointments: 0,
      shows:       0,
      noShows:     0,
      wins:        0,
      cold:        0,
    };

    // 2) Fetch pipelines for this location
    const pipesResp = await axios.get("https://rest.gohighlevel.com/v1/pipelines/", {
      headers: ghHeaders,
      params: { locationId: loc.id },
    });
    const pipelines = (pipesResp.data.pipelines || []).filter((p) =>
      ["Youth", "Adult", "Leagues"].includes(p.name)
    );

    // 3) For each pipeline, fetch its opportunities and tally stats
    const pipelineStats = {};
    await Promise.all(
      pipelines.map(async (p) => {
        try {
          const resp = await axios.get("https://rest.gohighlevel.com/v1/opportunities/", {
            headers: ghHeaders,
            params: {
              locationId: loc.id,
              pipelineId: p.id,
              startDate:  startTs,
              endDate:    endTs,
            },
          });
          const opps = Array.isArray(resp.data.opportunities)
            ? resp.data.opportunities
            : [];

          const total   = opps.length;
          const shows   = opps.filter((o) => o.tags?.includes("show")).length;
          const noShows = opps.filter((o) => o.tags?.includes("no-show")).length;
          const wins    = opps.filter((o) => o.tags?.includes("won")).length;
          const cold    = opps.filter((o) => o.tags?.includes("cold")).length;

          pipelineStats[p.name.toLowerCase()] = {
            total, shows, noShows, wins, cold,
          };

          combined.appointments += total;
          combined.shows        += shows;
          combined.noShows      += noShows;
          combined.wins         += wins;
          combined.cold         += cold;
        } catch (err) {
          console.error(`⚠ Pipeline ${p.name} error:`, err.response?.data || err.message);
          pipelineStats[p.name.toLowerCase()] = {
            error: true,
            details: err.response?.data || err.message,
          };
        }
      })
    );

    // 4) Return the response
    res.json({
      location:  loc.name,
      dateRange: { startDate: new Date(startTs).toISOString().slice(0,10), endDate: new Date(endTs).toISOString().slice(0,10) },
      combined,
      pipelines: pipelineStats,
    });
  } catch (err) {
    console.error("❌ /stats error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// STEP E: Start the server after loading locations
loadLocations().then(() => {
  app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));
});
