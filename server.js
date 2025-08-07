// server.js
require("dotenv").config();
const express = require("express");
const axios   = require("axios");
const csv     = require("csv-parser");
const fs      = require("fs");
const path    = require("path");
const cors    = require("cors");

const app = express();
app.use(cors());
const PORT = process.env.PORT || 3000;

// 1) Agency‐level key for listing sub‐accounts
const AGENCY_KEY = process.env.GHL_API_KEY;
if (!AGENCY_KEY) {
  console.error("❌ Missing GHL_API_KEY (agency key)");
  process.exit(1);
}
const agencyHeaders = {
  Authorization: `Bearer ${AGENCY_KEY}`,
  "Content-Type": "application/json"
};

// 2) Load CSV: slug → private API key
const rawLocations = [];
fs.createReadStream(path.join(__dirname, "secrets", "api_keys.csv"))
  .pipe(csv())
  .on("data", row => {
    rawLocations.push({
      csvName: row.location.trim(),
      slug:    row.location.toLowerCase().trim().replace(/\s+/g, "-"),
      apiKey:  row.api_key.trim()
    });
  })
  .on("end", () => console.log("🔑 Loaded CSV for:", rawLocations.map(r => r.slug)));

// 3) Helper: default last 30 days or ?startDate&endDate
function getDateRange(req) {
  const now = Date.now();
  let start = now - 1000 * 60 * 60 * 24 * 30,
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

// 4) Fetch all contacts for a sub-account
async function fetchAllContacts(apiKey, locationId) {
  const all = [];
  let page = 1, perPage = 50;
  while (true) {
    const resp = await axios.get("https://rest.gohighlevel.com/v1/contacts/", {
      headers: { Authorization: `Bearer ${apiKey}` },
      params:  { locationId, page, perPage }
    });
    const batch = resp.data.contacts || [];
    all.push(...batch);
    if (batch.length < perPage) break;
    page++;
  }
  return all;
}

// 5) Runtime map: slug → { id, apiKey, pipelines }
const locations = {};

// 6) Initialization: fetch sub-account IDs, merge CSV, fetch pipelines & stageIds
async function initialize() {
  // A) fetch sub-accounts with agency key
  const { data: locData } = await axios.get(
    "https://rest.gohighlevel.com/v1/locations",
    { headers: agencyHeaders }
  );
  const agList = locData.locations || [];

  // B) merge CSV entries
  for (const raw of rawLocations) {
    const match = agList.find(l =>
      l.name.toLowerCase().includes(raw.csvName.toLowerCase())
    );
    if (!match) {
      console.warn(`⚠ No GHL match for "${raw.csvName}"`);
      continue;
    }
    locations[raw.slug] = {
      id:      match.id,
      apiKey:  raw.apiKey,
      pipelines: []
    };
  }

  console.log("✅ Initialized locations:", Object.keys(locations));

  // C) for each sub-account, discover pipelines & their stage IDs
  await Promise.all(Object.entries(locations).map(async ([slug, loc]) => {
    const hdr = { Authorization: `Bearer ${loc.apiKey}`, "Content-Type":"application/json" };
    // 1) list pipelines
    let pipes = [];
    try {
      const r = await axios.get("https://rest.gohighlevel.com/v1/pipelines/", {
        headers: hdr,
        params:  { locationId: loc.id }
      });
      pipes = r.data.pipelines || [];
    } catch (e) {
      console.error(`❌ pipelines lookup failed for ${slug}:`, e.message);
    }
    // 2) for each Youth/Adult/Leagues pipeline, fetch its stages
    for (const p of pipes.filter(p => ["Youth","Adult","Leagues"].includes(p.name))) {
      const pi = { name: p.name.toLowerCase(), id: p.id, stageIds: {} };
      try {
        const d = await axios.get(
          `https://rest.gohighlevel.com/v1/pipelines/${p.id}`,
          { headers: hdr, params: { locationId: loc.id } }
        );
        (d.data.pipeline.stages || []).forEach(s => {
          pi.stageIds[s.name.toLowerCase().replace(/\s+/g,"-")] = s.id;
        });
      } catch (e) {
        console.warn(`⚠ stages lookup failed for ${slug}/${p.name}:`, e.message);
      }
      loc.pipelines.push(pi);
    }
  }));

  console.log("✅ Pipelines & stages fetched");
}

// 7) GET /locations → list available slugs
app.get("/locations", (req, res) => {
  res.json(Object.keys(locations));
});

// 8) GET /stats/:location → hybrid headcount-leads & tag-based outcomes
app.get("/stats/:location", async (req, res) => {
  const slug = req.params.location.toLowerCase();
  const loc  = locations[slug];
  if (!loc) {
    return res.status(404).json({ error: "Location not configured" });
  }

  const { start, end } = getDateRange(req);
  const hdr = { Authorization: `Bearer ${loc.apiKey}`, "Content-Type":"application/json" };

  // A) HEADCOUNT leads via pipeline-stage (no date filter)
  const combined = { leads:0, appointments:0, shows:0, noShows:0, wins:0, cold:0 };
  const pipelinesOut = {};

  for (const p of loc.pipelines) {
    pipelinesOut[p.name] = { leads:0, appointments:0, shows:0, noShows:0, wins:0, cold:0 };
    let opps = [];
    try {
      const r = await axios.get(
        `https://rest.gohighlevel.com/v1/pipelines/${p.id}/opportunities`,
        { headers: hdr, params: { locationId: loc.id } }
      );
      opps = r.data.opportunities || [];
    } catch (e) {
      console.warn(`⚠ opps fetch failed for ${slug}/${p.name}:`, e.message);
    }
    const headcount = opps.filter(o => o.stageId === p.stageIds["lead"]).length;
    pipelinesOut[p.name].leads = headcount;
    combined.leads += headcount;
  }

  // B) tag-based outcomes via contacts & dateUpdated
  let contacts = [];
  try {
    contacts = await fetchAllContacts(loc.apiKey, loc.id);
  } catch (e) {
    console.error("❌ contacts fetch failed:", e.message);
    return res.status(500).json({ error: "Contacts fetch failed" });
  }

  for (const c of contacts) {
    const updated = Date.parse(c.dateUpdated);
    if (updated < start || updated > end) continue;
    const tags = (c.tags || []).map(t => t.toLowerCase());
    const member = loc.pipelines.map(p => p.name).filter(n => tags.includes(n));

    if (tags.includes("appointment")) {
      combined.appointments++;
      member.forEach(n => pipelinesOut[n].appointments++);
    }
    if (tags.includes("show")) {
      combined.shows++;
      member.forEach(n => pipelinesOut[n].shows++);
    }
    if (tags.includes("no-show")) {
      combined.noShows++;
      member.forEach(n => pipelinesOut[n].noShows++);
    }
    if (tags.includes("won")) {
      combined.wins++;
      member.forEach(n => pipelinesOut[n].wins++);
    }
    if (tags.includes("cold")) {
      combined.cold++;
      member.forEach(n => pipelinesOut[n].cold++);
    }
  }

  // 9) Return JSON
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

// 10) Start server after initialization
initialize()
  .then(() => app.listen(PORT, () => console.log(`🚀 Dashboard listening on port ${PORT}`)))
  .catch(err => {
    console.error("❌ Initialization failed:", err);
    process.exit(1);
  });
