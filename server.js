// server.js
require("dotenv").config();
const express = require("express");
const fs      = require("fs");
const path    = require("path");
const csv     = require("csv-parser");
const axios   = require("axios");
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

// STEP A: Fetch sub-accounts and merge per-location config
async function initialize() {
  // A1: Fetch locations
  const resp = await axios.get("https://rest.gohighlevel.com/v1/locations", { headers: agencyHeaders });
  locationsCache = (resp.data.locations || []).map(loc => {
    const raw = loc.name.replace(/^Shoot 360\s*-\s*/, "");
    return { id: loc.id, name: loc.name, slug: raw.toLowerCase().replace(/\s+/g, "-"), apiKey: null, calendars: [] };
  });

  console.log("✅ Loaded locations:", locationsCache.map(l => l.slug));

  // A2: Load CSV of per-location API keys & calendars
  return new Promise((resolve, reject) => {
    const filePath = path.join(__dirname, "secrets", "api_keys.csv");
    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", row => {
        const slug = row.location.toLowerCase().trim();
        const loc  = locationsCache.find(l => l.slug === slug);
        if (!loc) {
          console.warn("⚠ Skipping CSV entry for unknown location:", row.location);
          return;
        }
        loc.apiKey    = row.api_key.trim();
        loc.calendars = Object.keys(row)
          .filter(k => k.endsWith("_calendar_id") && row[k].trim())
          .map(k => ({ name: k.replace("_calendar_id", ""), id: row[k].trim() }));
      })
      .on("end", () => {
        console.log("✅ Merged API keys & calendars from CSV");
        resolve();
      })
      .on("error", err => {
        console.error("❌ Error reading CSV:", err);
        reject(err);
      });
  });
}

// STEP B: Compute date range (last 30 days default)
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

// STEP C: GET /locations → sidebar data
app.get("/locations", (req, res) => {
  res.json(locationsCache.map(({ id, name, slug }) => ({ id, name, slug })));
});

// STEP D: GET /stats/:location → your main stats
app.get("/stats/:location", async (req, res) => {
  const loc = locationsCache.find(l => l.slug === req.params.location.toLowerCase());
  if (!loc) return res.status(404).json({ error: "Location not found" });
  if (!loc.apiKey) return res.status(500).json({ error: "No API key for this location" });

  const { start, end } = getDateRange(req);
  const headers = { Authorization: `Bearer ${loc.apiKey}`, "Content-Type": "application/json" };

  // 1) Leads (Contacts)
  let leads = 0;
  try {
    const cRes = await axios.get("https://rest.gohighlevel.com/v1/contacts/", { headers });
    leads = (cRes.data.contacts || []).filter(c =>
      Date.parse(c.dateCreated) >= start && Date.parse(c.dateCreated) <= end
    ).length;
  } catch (e) {
    console.error("⚠ Contacts error:", e.response?.data || e.message);
  }

  // 2) All opportunities
  let opps = [];
  try {
    const oRes = await axios.get("https://rest.gohighlevel.com/v1/opportunities/", { headers });
    opps = oRes.data.opportunities || [];
    opps = opps.filter(o => {
      const d = Date.parse(o.dateCreated);
      return d >= start && d <= end;
    });
  } catch (e) {
    console.error("⚠ Opportunities error:", e.response?.data || e.message);
  }

  // 3) Combined & pipeline breakdown
  const combined = {
    leads,
    appointments: opps.length,
    shows:        opps.filter(o => o.tags?.includes("show")).length,
    noShows:      opps.filter(o => o.tags?.includes("no-show")).length,
    wins:         opps.filter(o => o.tags?.includes("won")).length,
    cold:         opps.filter(o => o.tags?.includes("cold")).length,
  };
  const pipelines = ["youth", "adult", "leagues"].reduce((acc, name) => {
    const list = opps.filter(o => o.tags?.includes(name));
    acc[name] = {
      total:   list.length,
      shows:   list.filter(o => o.tags.includes("show")).length,
      noShows: list.filter(o => o.tags.includes("no-show")).length,
      wins:    list.filter(o => o.tags.includes("won")).length,
      cold:    list.filter(o => o.tags.includes("cold")).length,
    };
    return acc;
  }, {});

  res.json({
    location:  loc.name,
    dateRange: {
      startDate: new Date(start).toISOString().slice(0,10),
      endDate:   new Date(end).toISOString().slice(0,10),
    },
    combined,
    pipelines,
  });
});

// STEP E: Initialize & start server
initialize()
  .then(() => app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`)))
  .catch(err => {
    console.error("❌ Initialization failed:", err);
    process.exit(1);
  });
