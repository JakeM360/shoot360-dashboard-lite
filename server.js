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

// Agency key (only to list sub-accounts)
const AGENCY_API_KEY = process.env.GHL_API_KEY;
if (!AGENCY_API_KEY) {
  console.error("❌ Missing GHL_API_KEY in environment");
  process.exit(1);
}
const agencyHeaders = {
  Authorization: `Bearer ${AGENCY_API_KEY}`,
  "Content-Type":  "application/json",
};

// In-memory cache of locations
let locationsCache = [];

// STEP A: Initialize — fetch sub-accounts, merge per-location keys
async function initialize() {
  // 1) List sub-accounts with agency key
  const { data: locData } = await axios.get(
    "https://rest.gohighlevel.com/v1/locations",
    { headers: agencyHeaders }
  );
  locationsCache = (locData.locations || []).map((loc) => {
    const raw = loc.name.replace(/^Shoot 360\s*-\s*/, "");
    return {
      id:    loc.id,
      name:  loc.name,
      slug:  raw.toLowerCase().replace(/\s+/g, "-"),
      apiKey: null,
    };
  });

  // 2) Load API keys CSV to merge sub-account keys
  await new Promise((resolve, reject) => {
    fs.createReadStream(path.join(__dirname, "secrets", "api_keys.csv"))
      .pipe(csv())
      .on("data", (row) => {
        const slug = row.location.toLowerCase().trim();
        const loc  = locationsCache.find((l) => l.slug === slug);
        if (loc) loc.apiKey = row.api_key.trim();
      })
      .on("end", resolve)
      .on("error", reject);
  });

  console.log("✅ Locations initialized:", locationsCache.map((l) => l.slug));
}

// STEP B: Date range helper (last 30d default)
function getDateRange(req) {
  const now = Date.now();
  let start = now - 1000*60*60*24*30,
      end   = now;
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

// GET /locations → id, name, slug
app.get("/locations", (req, res) => {
  res.json(locationsCache.map(({ id, name, slug }) => ({ id, name, slug })));
});

// GET /stats/:location
app.get("/stats/:location", async (req, res) => {
  const slug = req.params.location.toLowerCase();
  const loc  = locationsCache.find((l) => l.slug === slug);
  if (!loc) return res.status(404).json({ error: "Location not found" });
  if (!loc.apiKey) return res.status(500).json({ error: "No API key for this location" });

  const { start, end } = getDateRange(req);

  // 1) Leads via Contacts (sub-account key)
  let leads = 0;
  try {
    const { data: cData } = await axios.get(
      "https://rest.gohighlevel.com/v1/contacts/",
      {
        headers: { Authorization: `Bearer ${loc.apiKey}` },
        params: { locationId: loc.id }
      }
    );
    leads = (cData.contacts || []).filter(c => {
      const t = Date.parse(c.dateCreated);
      return t >= start && t <= end;
    }).length;
  } catch (e) {
    console.error("⚠ Contacts error:", e.response?.data || e.message);
  }

  // 2) Pipelines via sub-account key (must use sub-account key)
  let pipelinesList = [];
  try {
    const { data: pData } = await axios.get(
      "https://rest.gohighlevel.com/v1/pipelines/",
      {
        headers: { Authorization: `Bearer ${loc.apiKey}` },
        params: { locationId: loc.id }
      }
    );
    pipelinesList = (pData.pipelines || []).filter(p =>
      ["Youth","Adult","Leagues"].includes(p.name)
    );
  } catch (e) {
    console.error("⚠ Pipelines error:", e.response?.data || e.message);
  }

  // 3) Opportunities per pipeline
  const combined = { leads, appointments:0, shows:0, noShows:0, wins:0, cold:0 };
  const pipelines = {};

  await Promise.all(pipelinesList.map(async (p) => {
    try {
      const { data: oData } = await axios.get(
        "https://rest.gohighlevel.com/v1/opportunities/",
        {
          headers: { Authorization: `Bearer ${loc.apiKey}` },
          params: {
            locationId: loc.id,
            pipelineId: p.id,
            startDate:  start,
            endDate:    end
          }
        }
      );
      const opps = oData.opportunities || [];
      const total   = opps.length;
      const shows   = opps.filter(o=>o.tags?.includes("show")).length;
      const noShows = opps.filter(o=>o.tags?.includes("no-show")).length;
      const wins    = opps.filter(o=>o.tags?.includes("won")).length;
      const cold    = opps.filter(o=>o.tags?.includes("cold")).length;

      pipelines[p.name.toLowerCase()] = { total, shows, noShows, wins, cold };

      combined.appointments += total;
      combined.shows        += shows;
      combined.noShows      += noShows;
      combined.wins         += wins;
      combined.cold         += cold;
    } catch (e) {
      console.error(`⚠ Pipeline ${p.name} error:`, e.response?.data || e.message);
      pipelines[p.name.toLowerCase()] = {
        error:true, details:e.response?.data||e.message
      };
    }
  }));

  res.json({
    location: loc.name,
    dateRange:{
      startDate:new Date(start).toISOString().slice(0,10),
      endDate:  new Date(end).toISOString().slice(0,10),
    },
    combined,
    pipelines,
  });
});

// Initialize & listen
initialize()
  .then(() => app.listen(PORT, () => console.log(`🚀 Listening on port ${PORT}`)))
  .catch(err => {
    console.error("❌ Init failed:", err);
    process.exit(1);
  });
