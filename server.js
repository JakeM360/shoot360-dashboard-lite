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

// Cache for locations
let locationsCache = [];

// STEP A: Fetch sub-accounts and merge per-location API keys & calendars
async function initialize() {
  // 1) Fetch locations with agency key
  const locResp = await axios.get("https://rest.gohighlevel.com/v1/locations", { headers: agencyHeaders });
  locationsCache = (locResp.data.locations || []).map(loc => {
    const raw = loc.name.replace(/^Shoot 360\s*-\s*/, "");
    return {
      id:      loc.id,
      name:    loc.name,
      slug:    raw.toLowerCase().replace(/\s+/g, "-"),
      apiKey:  null,
      calendars: []  // still available for future
    };
  });

  // 2) Load your per‐location API keys from CSV
  await new Promise((resolve, reject) => {
    fs.createReadStream(path.join(__dirname, "secrets", "api_keys.csv"))
      .pipe(csv())
      .on("data", row => {
        const slug = row.location.toLowerCase().trim();
        const loc  = locationsCache.find(l => l.slug === slug);
        if (!loc) return;
        loc.apiKey = row.api_key.trim();
      })
      .on("end", resolve)
      .on("error", reject);
  });

  console.log("✅ Initialized:", locationsCache.map(l => l.slug));
}

// STEP B: Date range helper (last 30 days default)
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

// GET /locations → sidebar
app.get("/locations", (req, res) => {
  res.json(locationsCache.map(({ id, name, slug }) => ({ id, name, slug })));
});

// GET /stats/:location → metrics
app.get("/stats/:location", async (req, res) => {
  const loc = locationsCache.find(l => l.slug === req.params.location.toLowerCase());
  if (!loc) return res.status(404).json({ error: "Location not found" });
  if (!loc.apiKey) return res.status(500).json({ error: "Missing API key for location" });

  const { start, end } = getDateRange(req);
  const headers = {
    Authorization: `Bearer ${loc.apiKey}`,
    "Content-Type":  "application/json"
  };

  // 1) Fetch & filter leads via Contacts
  let leads = 0;
  try {
    const cRes = await axios.get("https://rest.gohighlevel.com/v1/contacts/", {
      headers,
      params: { locationId: loc.id }
    });
    leads = (cRes.data.contacts || [])
      .filter(c => {
        const t = Date.parse(c.dateCreated);
        return t >= start && t <= end;
      }).length;
  } catch (e) {
    console.error("⚠ Contacts error:", e.response?.data || e.message);
  }

  // 2) Fetch & filter all opportunities once
  let opps = [];
  try {
    const oRes = await axios.get("https://rest.gohighlevel.com/v1/opportunities/", {
      headers,
      params: { locationId: loc.id }
    });
    opps = (oRes.data.opportunities || [])
      .filter(o => {
        const t = Date.parse(o.dateCreated);
        return t >= start && t <= end;
      });
  } catch (e) {
    console.error("⚠ Opportunities error:", e.response?.data || e.message);
  }

  // 3) Tally combined
  const combined = {
    leads,
    appointments: opps.length,
    shows:        opps.filter(o => o.tags?.includes("show")).length,
    noShows:      opps.filter(o => o.tags?.includes("no-show")).length,
    wins:         opps.filter(o => o.tags?.includes("won")).length,
    cold:         opps.filter(o => o.tags?.includes("cold")).length,
  };

  // 4) Pipeline breakdown by tags
  const pipelines = ["youth","adult","leagues"].reduce((acc, name) => {
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

  // 5) Return payload
  res.json({
    location: loc.name,
    dateRange: {
      startDate: new Date(start).toISOString().slice(0,10),
      endDate:   new Date(end).toISOString().slice(0,10),
    },
    combined,
    pipelines,
  });
});

// STEP E: Initialize & start
initialize()
  .then(() => app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`)))
  .catch(err => {
    console.error("❌ Init failed:", err);
    process.exit(1);
  });
