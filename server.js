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

// 2) Load your CSV: slug → private API key & calendar IDs
const rawLocations = [];
fs.createReadStream(path.join(__dirname, "secrets", "api_keys.csv"))
  .pipe(csv())
  .on("data", row => {
    rawLocations.push({
      csvName:  row.location.trim(),
      slug:     row.location.toLowerCase().trim().replace(/\s+/g, "-"),
      apiKey:   row.api_key.trim(),
      calendars:[
        row.calendar_youth_id   ? { name:"youth",   id:row.calendar_youth_id.trim() }   : null,
        row.calendar_adult_id   ? { name:"adult",   id:row.calendar_adult_id.trim() }   : null,
        row.calendar_leagues_id ? { name:"leagues", id:row.calendar_leagues_id.trim() } : null
      ].filter(Boolean)
    });
  })
  .on("end", () => console.log("🔑 CSV loaded:", rawLocations.map(r=>r.slug)));

// 3) Date‐range helper (defaults to last 30 days)
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

// 4) Utility: fetch ALL contacts for a sub‐account
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

// 5) Build runtime map: slug → { id, apiKey, calendars }
const locations = {};

// 6) Initialization: lookup real IDs via agency key & merge CSV
async function initialize() {
  // A) fetch sub‐accounts
  const { data: locData } = await axios.get(
    "https://rest.gohighlevel.com/v1/locations",
    { headers: agencyHeaders }
  );
  const agencyList = locData.locations || [];

  // B) merge with CSV entries
  for (const raw of rawLocations) {
    const match = agencyList.find(l =>
      l.name.toLowerCase().includes(raw.csvName.toLowerCase())
    );
    if (!match) {
      console.warn(`⚠ No match for "${raw.csvName}"`);
      continue;
    }
    locations[raw.slug] = {
      id:        match.id,
      apiKey:    raw.apiKey,
      calendars: raw.calendars
    };
  }

  console.log("✅ Initialized locations:", Object.keys(locations));
}

// 7) GET /locations → list your slugs
app.get("/locations", (req, res) => {
  res.json(Object.keys(locations));
});

// 8) GET /stats/:location → Contacts‐only metrics
app.get("/stats/:location", async (req, res) => {
  const slug = req.params.location.toLowerCase();
  const loc  = locations[slug];
  if (!loc) {
    return res.status(404).json({ error: "Location not found" });
  }

  const { start, end } = getDateRange(req);

  // Fetch all contacts for this sub‐account
  let contacts = [];
  try {
    contacts = await fetchAllContacts(loc.apiKey, loc.id);
  } catch (e) {
    console.error("❌ Contacts fetch error:", e.message);
    return res.status(500).json({ error: "Failed to fetch contacts" });
  }

  // 9) Prepare accumulators
  const combined = {
    leads: 0,
    appointments: 0,
    shows: 0,
    noShows: 0,
    wins: 0,
    cold: 0
  };
  const pipelines = {
    adult:   { leads:0, appointments:0, shows:0, noShows:0, wins:0, cold:0 },
    youth:   { leads:0, appointments:0, shows:0, noShows:0, wins:0, cold:0 },
    leagues: { leads:0, appointments:0, shows:0, noShows:0, wins:0, cold:0 }
  };

  // 10) Iterate contacts
  for (const c of contacts) {
    const updated = Date.parse(c.dateUpdated);
    const tags    = (c.tags || []).map(t => t.toLowerCase());

    // Determine pipeline membership via tags
    const memberPipes = ["adult", "youth", "leagues"].filter(p => tags.includes(p));

    // A) Leads: **everyone** ever in contacts, by pipeline tag
    memberPipes.forEach(p => {
      pipelines[p].leads++;
      combined.leads++;
    });

    // B) Appointments (tag + in window)
    if (tags.includes("appointment") && updated >= start && updated <= end) {
      memberPipes.forEach(p => pipelines[p].appointments++);
      combined.appointments++;
    }

    // C) Shows / No-Shows (tag + in window)
    if (tags.includes("show") && updated >= start && updated <= end) {
      memberPipes.forEach(p => pipelines[p].shows++);
      combined.shows++;
    }
    if (tags.includes("no-show") && updated >= start && updated <= end) {
      memberPipes.forEach(p => pipelines[p].noShows++);
      combined.noShows++;
    }

    // D) Wins / Cold (tag + in window)
    if (tags.includes("won") && updated >= start && updated <= end) {
      memberPipes.forEach(p => pipelines[p].wins++);
      combined.wins++;
    }
    if (tags.includes("cold") && updated >= start && updated <= end) {
      memberPipes.forEach(p => pipelines[p].cold++);
      combined.cold++;
    }
  }

  // 11) Return assembled JSON
  res.json({
    location: slug,
    dateRange: {
      startDate: new Date(start).toISOString().slice(0,10),
      endDate:   new Date(end).toISOString().slice(0,10)
    },
    combined,
    pipelines
  });
});

// 12) Start up
initialize()
  .then(() => app.listen(PORT, () => console.log(`🚀 Listening on port ${PORT}`)))
  .catch(err => {
    console.error("❌ Initialization failed:", err);
    process.exit(1);
  });
