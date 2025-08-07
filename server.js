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

// Agency key used only to fetch sub-account list
const AGENCY_API_KEY = process.env.GHL_API_KEY;
if (!AGENCY_API_KEY) {
  console.error("❌ Missing GHL_API_KEY in environment");
  process.exit(1);
}
const agencyHeaders = {
  Authorization: `Bearer ${AGENCY_API_KEY}`,
  "Content-Type": "application/json",
};

// In-memory cache for locations
let locationsCache = [];

// STEP A: Fetch sub-accounts and merge per-location API keys & calendars
async function initialize() {
  // A1: Fetch locations
  const locResp = await axios.get("https://rest.gohighlevel.com/v1/locations", { headers: agencyHeaders });
  locationsCache = (locResp.data.locations || []).map(loc => {
    const raw = loc.name.replace(/^Shoot 360\s*-\s*/, "");
    return {
      id:   loc.id,
      name: loc.name,
      slug: raw.toLowerCase().replace(/\s+/g, "-"),
      apiKey: null,
      calendars: []
    };
  });

  // A2: Load CSV of per-location API keys & calendars
  await new Promise((resolve, reject) => {
    fs.createReadStream(path.join(__dirname, "secrets", "api_keys.csv"))
      .pipe(csv())
      .on("data", row => {
        const slug = row.location.toLowerCase().trim();
        const loc  = locationsCache.find(l => l.slug === slug);
        if (!loc) return;
        loc.apiKey    = row.api_key.trim();
        loc.calendars = Object.keys(row)
          .filter(k => k.endsWith("_calendar_id") && row[k].trim())
          .map(k => ({ name: k.replace("_calendar_id", ""), id: row[k].trim() }));
      })
      .on("end", resolve)
      .on("error", reject);
  });

  console.log("✅ Initialized locations with API keys & calendars:", locationsCache.map(l => l.slug));
}

// STEP B: Default to last 30 days or use query
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

// STEP C: GET /locations
app.get("/locations", (req, res) => {
  res.json(locationsCache.map(({ id, name, slug }) => ({ id, name, slug })));
});

// STEP D: GET /stats/:location
app.get("/stats/:location", async (req, res) => {
  const loc = locationsCache.find(l => l.slug === req.params.location.toLowerCase());
  if (!loc) return res.status(404).json({ error: "Location not found" });
  if (!loc.apiKey) return res.status(500).json({ error: "No API key for this location" });

  const { start, end } = getDateRange(req);
  const headers = {
    Authorization: `Bearer ${loc.apiKey}`,
    "Content-Type":  "application/json"
  };

  // 1) Fetch Leads via Contacts
  let leads = 0;
  try {
    const cRes = await axios.get("https://rest.gohighlevel.com/v1/contacts/", {
      headers,
      params: { locationId: loc.id }
    });
    leads = (cRes.data.contacts || [])
      .filter(c => {
        const d = Date.parse(c.dateCreated);
        return d >= start && d <= end;
      }).length;
  } catch (e) {
    console.error("⚠ Contacts error:", e.response?.data || e.message);
  }

  // 2) Fetch pipelines for this location via API key
  let pipelinesList = [];
  try {
    const pRes = await axios.get("https://rest.gohighlevel.com/v1/pipelines/", {
      headers,
      params: { locationId: loc.id }
    });
    pipelinesList = (pRes.data.pipelines || []).filter(p =>
      ["Youth","Adult","Leagues"].includes(p.name)
    );
  } catch (e) {
    console.error("⚠ Pipelines error:", e.response?.data || e.message);
  }

  // 3) For each pipeline, fetch its opportunities and tally metrics
  const combined = { leads, appointments: 0, shows: 0, noShows: 0, wins: 0, cold: 0 };
  const pipelines = {};

  await Promise.all(pipelinesList.map(async (p) => {
    try {
      const oRes = await axios.get("https://rest.gohighlevel.com/v1/opportunities/", {
        headers,
        params: {
          locationId: loc.id,
          pipelineId: p.id,
          startDate:  start,
          endDate:    end
        }
      });
      const opps = oRes.data.opportunities || [];
      const total   = opps.length;
      const shows   = opps.filter(o => o.tags?.includes("show")).length;
      const noShows = opps.filter(o => o.tags?.includes("no-show")).length;
      const wins    = opps.filter(o => o.tags?.includes("won")).length;
      const cold    = opps.filter(o => o.tags?.includes("cold")).length;

      pipelines[p.name.toLowerCase()] = { total, shows, noShows, wins, cold };

      combined.appointments += total;
      combined.shows        += shows;
      combined.noShows      += noShows;
      combined.wins         += wins;
      combined.cold         += cold;
    } catch (e) {
      console.error(`⚠ Pipeline ${p.name} error:`, e.response?.data || e.message);
      pipelines[p.name.toLowerCase()] = { error:true, details: e.response?.data || e.message };
    }
  }));

  res.json({
    location:  loc.name,
    dateRange: {
      startDate: new Date(start).toISOString().slice(0,10),
      endDate:   new Date(end).toISOString().slice(0,10)
    },
    combined,
    pipelines
  });
});

// STEP E: Initialize and start
initialize()
  .then(() => app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`)))
  .catch(err => {
    console.error("❌ Initialization failed:", err);
    process.exit(1);
  });
