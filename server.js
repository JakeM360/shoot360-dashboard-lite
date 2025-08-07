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

// 1) Agency key (fallback to GHL_API_KEY if you only have that set)
const AGENCY_API_KEY = process.env.GHL_AGENCY_KEY || process.env.GHL_API_KEY;
if (!AGENCY_API_KEY) {
  console.error("❌ Missing GHL_AGENCY_KEY or GHL_API_KEY");
  process.exit(1);
}
const agencyHeaders = {
  Authorization: `Bearer ${AGENCY_API_KEY}`,
  "Content-Type": "application/json"
};

// 2) Load CSV (slug, apiKey, calendar IDs)
const rawLocations = [];
fs.createReadStream(path.join(__dirname, "secrets", "api_keys.csv"))
  .pipe(csv())
  .on("data", row => {
    rawLocations.push({
      csvName:  row.location.trim(),
      slug:     row.location.toLowerCase().trim().replace(/\s+/g, "-"),
      apiKey:   row.api_key.trim(),
      calendars: [
        row.calendar_youth_id   ? { name:"youth",   id:row.calendar_youth_id.trim() }   : null,
        row.calendar_adult_id   ? { name:"adult",   id:row.calendar_adult_id.trim() }   : null,
        row.calendar_leagues_id ? { name:"leagues", id:row.calendar_leagues_id.trim() } : null
      ].filter(Boolean)
    });
  })
  .on("end", () => console.log("🔑 Loaded CSV for:", rawLocations.map(l => l.slug)));

// 3) Date‐range helper (last 30 days default)
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

// 4) Build our location objects (id, apiKey, calendars, pipelines)
const locations = {};

async function initialize() {
  // A) Fetch sub‐accounts with agency key
  const { data: locData } = await axios.get(
    "https://rest.gohighlevel.com/v1/locations",
    { headers: agencyHeaders }
  );
  const agencyList = locData.locations || [];

  // B) Merge CSV entries with agencyList
  for (const raw of rawLocations) {
    const match = agencyList.find(l =>
      l.name.toLowerCase().includes(raw.csvName.toLowerCase())
    );
    if (!match) {
      console.warn(`⚠ No GHL location found for CSV entry "${raw.csvName}"`);
      continue;
    }
    locations[raw.slug] = {
      id:        match.id,
      apiKey:    raw.apiKey,
      calendars: raw.calendars,
      pipelines: []
    };
  }

  // C) For each location, fetch its pipelines & stage IDs
  await Promise.all(Object.entries(locations).map(async ([slug, loc]) => {
    const hdr = { Authorization: `Bearer ${loc.apiKey}`, "Content-Type":"application/json" };
    // 1) list pipelines
    let pipelines = [];
    try {
      const resp = await axios.get(
        "https://rest.gohighlevel.com/v1/pipelines/",
        { headers: hdr, params:{ locationId: loc.id } }
      );
      pipelines = resp.data.pipelines || [];
    } catch (e) {
      console.error(`❌ Could not fetch pipelines for ${slug}:`, e.message);
    }
    // 2) for each pipeline, fetch its stages
    for (const p of pipelines.filter(p => ["Youth","Adult","Leagues"].includes(p.name))) {
      const pipe = { name: p.name.toLowerCase(), id: p.id, stageIds: {} };
      try {
        const detail = await axios.get(
          `https://rest.gohighlevel.com/v1/pipelines/${p.id}`,
          { headers: hdr, params:{ locationId: loc.id } }
        );
        (detail.data.pipeline.stages || []).forEach(s => {
          pipe.stageIds[s.name.toLowerCase().replace(/\s+/g,"-")] = s.id;
        });
      } catch (e) {
        console.error(`⚠ Could not fetch stages for pipeline "${p.name}" at ${slug}:`, e.message);
      }
      loc.pipelines.push(pipe);
    }
  }));

  console.log("✅ Initialization complete");
}

// 5) GET /locations → list available slugs
app.get("/locations", (req, res) => {
  res.json(Object.keys(locations));
});

// 6) GET /stats/:location → pipeline‐stage metrics
app.get("/stats/:location", async (req, res) => {
  const slug = req.params.location.toLowerCase();
  const loc  = locations[slug];
  if (!loc) {
    return res.status(404).json({ error: "Location not configured" });
  }

  const { start, end } = getDateRange(req);
  const hdr = { Authorization: `Bearer ${loc.apiKey}`, "Content-Type":"application/json" };

  // Prepare combined + per‐pipeline accumulators
  const combined = { leads:0, appointments:0, shows:0, noShows:0, cold:0, wins:0 };
  const pipelinesOut = {};

  // Loop each pipeline
  for (const p of loc.pipelines) {
    pipelinesOut[p.name] = { leads:0, appointments:0, shows:0, noShows:0, cold:0, wins:0 };
    let opps = [];
    try {
      const resp = await axios.get(
        `https://rest.gohighlevel.com/v1/pipelines/${p.id}/opportunities`,
        {
          headers: hdr,
          params: { locationId: loc.id, startDate: start, endDate: end }
        }
      );
      opps = resp.data.opportunities || [];
    } catch (e) {
      console.error(`⚠ Opps fetch failed for ${slug}/${p.name}:`, e.message);
    }
    // Tally by stageId & won‐tag
    for (const o of opps) {
      const sid = o.stageId;
      if (sid === p.stageIds["lead"]) {
        pipelinesOut[p.name].leads++;        combined.leads++;
      }
      if (sid === p.stageIds["appointment"]) {
        pipelinesOut[p.name].appointments++; combined.appointments++;
      }
      if (sid === p.stageIds["no-show"]) {
        pipelinesOut[p.name].noShows++;      combined.noShows++;
      }
      if (sid === p.stageIds["show"]) {
        pipelinesOut[p.name].shows++;        combined.shows++;
      }
      if (sid === p.stageIds["cold"]) {
        pipelinesOut[p.name].cold++;         combined.cold++;
      }
      if (o.tags?.includes("won")) {
        pipelinesOut[p.name].wins++;         combined.wins++;
      }
    }
  }

  // Return JSON
  res.json({
    location: slug,
    dateRange: {
      startDate: new Date(start).toISOString().slice(0,10),
      endDate:   new Date(end).toISOString().slice(0,10)
    },
    combined,
    pipelines: pipelinesOut
  });
});

// 7) Boot
initialize()
  .then(() => app.listen(PORT, () => console.log(`🚀 Dashboard listening on port ${PORT}`)))
  .catch(err => {
    console.error("❌ Startup failed:", err);
    process.exit(1);
  });
