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

// 1) Load location→API key mapping from CSV
const locations = [];
fs.createReadStream(path.join(__dirname, "secrets", "api_keys.csv"))
  .pipe(csv())
  .on("data", row => {
    locations.push({
      slug: row.location.toLowerCase().trim(),
      apiKey: row.api_key.trim()
    });
  })
  .on("end", () => console.log("🔑 Loaded API keys for:", locations.map(l=>l.slug)));

// 2) Date-range helper (last 30 days default)
function getDateRange(req) {
  const now = Date.now();
  let start = now - 1000*60*60*24*30, end = now;
  if (req.query.startDate && req.query.endDate) {
    const s = Date.parse(req.query.startDate), e = Date.parse(req.query.endDate);
    if (!isNaN(s)&&!isNaN(e)) {
      start = s;
      end   = e + 86399999;
    }
  }
  return { start, end };
}

// 3) Helper to page through all contacts
async function fetchAllContacts(apiKey, locationId) {
  const all = [];
  let page = 1, perPage = 50;
  while (true) {
    const resp = await axios.get("https://rest.gohighlevel.com/v1/contacts/", {
      headers: { Authorization: `Bearer ${apiKey}` },
      params: { locationId, page, perPage }
    });
    const batch = resp.data.contacts || [];
    all.push(...batch);
    if (batch.length < perPage) break;
    page++;
  }
  return all;
}

// 4) GET /locations → just return the slugs we know
app.get("/locations", (req, res) => {
  res.json(locations.map(l => ({ slug: l.slug })));
});

// 5) GET /stats/:location → contacts-only metrics
app.get("/stats/:location", async (req, res) => {
  const slug = req.params.location.toLowerCase();
  const locEntry = locations.find(l => l.slug === slug);
  if (!locEntry) {
    return res.status(404).json({ error: "Location not found" });
  }

  const { start, end } = getDateRange(req);
  const apiKey = locEntry.apiKey;

  // Fetch all contacts for this location
  let contacts = [];
  try {
    // Must know the numeric locationId for the call
    // We'll extract it from the first page
    const firstPage = await axios.get("https://rest.gohighlevel.com/v1/contacts/", {
      headers: { Authorization: `Bearer ${apiKey}` },
      params: { page: 1, perPage: 1 }
    });
    const locationId = firstPage.data.contacts?.[0]?.locationId;
    if (!locationId) {
      throw new Error("Unable to discover locationId from contacts");
    }
    contacts = await fetchAllContacts(apiKey, locationId);
  } catch (e) {
    console.error("❌ Contacts fetch failed:", e.response?.data || e.message);
    return res.status(500).json({ error: "Failed to fetch contacts", details: e.message });
  }

  // Set up our buckets
  const pipelines = ["adult","youth","leagues"];
  const combined = {
    leads: 0,
    appointments: 0,
    shows: 0,
    noShows: 0,
    wins: 0,
    cold: 0
  };
  const byPipeline = {};
  pipelines.forEach(p => {
    byPipeline[p] = { leads:0, appointments:0, shows:0, noShows:0, wins:0, cold:0 };
  });

  // 6) Iterate contacts
  for (const c of contacts) {
    const created = Date.parse(c.dateCreated);
    const updated = Date.parse(c.dateUpdated);
    const tags = (c.tags || []).map(t => t.toLowerCase());

    // Determine pipelines this contact belongs to
    const belongsTo = pipelines.filter(p => tags.includes(p));
    if (belongsTo.length === 0) {
      // if no explicit pipeline tag, skip entirely
      continue;
    }

    // A) Leads = created in window
    if (created >= start && created <= end) {
      combined.leads++;
      belongsTo.forEach(p => byPipeline[p].leads++);
    }

    // B) Appointments = tag + updated in window
    if (tags.includes("appointment") && updated >= start && updated <= end) {
      combined.appointments++;
      belongsTo.forEach(p => byPipeline[p].appointments++);
    }

    // C) Shows / No-Shows
    if ((tags.includes("show") || tags.includes("no-show")) && updated >= start && updated <= end) {
      if (tags.includes("show")) {
        combined.shows++;
        belongsTo.forEach(p => byPipeline[p].shows++);
      }
      if (tags.includes("no-show")) {
        combined.noShows++;
        belongsTo.forEach(p => byPipeline[p].noShows++);
      }
    }

    // D) Wins / Cold
    if (tags.includes("won") && updated >= start && updated <= end) {
      combined.wins++;
      belongsTo.forEach(p => byPipeline[p].wins++);
    }
    if (tags.includes("cold") && updated >= start && updated <= end) {
      combined.cold++;
      belongsTo.forEach(p => byPipeline[p].cold++);
    }
  }

  res.json({
    location: slug,
    dateRange: {
      startDate: new Date(start).toISOString().slice(0,10),
      endDate:   new Date(end).toISOString().slice(0,10)
    },
    combined,
    pipelines: byPipeline
  });
});

// 7) Start
app.listen(PORT, () => {
  console.log(`🚀 Contacts-only dashboard listening on port ${PORT}`);
});
