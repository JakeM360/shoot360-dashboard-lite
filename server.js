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

// 1) Agency‐level key for locating sub-account IDs
const AGENCY_KEY = process.env.GHL_API_KEY;
if (!AGENCY_KEY) {
  console.error("❌ Missing GHL_API_KEY (agency key)");
  process.exit(1);
}
const agencyHeaders = {
  Authorization: `Bearer ${AGENCY_KEY}`,
  "Content-Type": "application/json"
};

// 2) Read your CSV: map slug → private apiKey, calendars (if still used)
const rawLocations = [];
fs.createReadStream(path.join(__dirname, "secrets", "api_keys.csv"))
  .pipe(csv())
  .on("data", row => {
    const slug = row.location.toLowerCase().trim().replace(/\s+/g, "-");
    rawLocations.push({
      slug,
      apiKey:   row.api_key.trim(),
      calendars:[
        row.calendar_youth_id   ? { name:"youth",   id:row.calendar_youth_id.trim() }   : null,
        row.calendar_adult_id   ? { name:"adult",   id:row.calendar_adult_id.trim() }   : null,
        row.calendar_leagues_id ? { name:"leagues", id:row.calendar_leagues_id.trim() } : null
      ].filter(Boolean)
    });
  })
  .on("end", () => console.log("🔑 Loaded CSV entries:", rawLocations.map(l=>l.slug)));

// 3) Helper: default last 30 days or use ?startDate&endDate
function getDateRange(req){
  const now = Date.now();
  let start = now - 1000*60*60*24*30, end = now;
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

// 4) Fetch all contacts for a given sub-account (by private key & locationId)
async function fetchAllContacts(apiKey, locationId){
  const all = [];
  let page = 1, perPage = 50;
  while (true){
    const resp = await axios.get("https://rest.gohighlevel.com/v1/contacts/", {
      headers: { Authorization:`Bearer ${apiKey}` },
      params: { locationId, page, perPage }
    });
    const batch = resp.data.contacts||[];
    all.push(...batch);
    if (batch.length < perPage) break;
    page++;
  }
  return all;
}

// 5) Build our runtime map: slug → { id, apiKey, calendars }
const locations = {};

// 6) Initialization: resolve real location IDs via agency key & merge CSV
async function initialize(){
  // A) get sub-accounts from agency
  const { data: ag } = await axios.get(
    "https://rest.gohighlevel.com/v1/locations",
    { headers: agencyHeaders }
  );
  const agList = ag.locations||[];

  // B) merge with CSV entries
  for (const raw of rawLocations){
    const match = agList.find(x => x.name.toLowerCase().includes(raw.slug));
    if (!match) {
      console.warn(`⚠ Could not find sub-account matching "${raw.slug}"`);
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

// 7) GET /locations → available slugs
app.get("/locations",(req,res)=>{
  res.json(Object.keys(locations));
});

// 8) GET /stats/:location → contacts‐only metrics
app.get("/stats/:location", async (req,res) => {
  const slug = req.params.location.toLowerCase();
  const loc  = locations[slug];
  if (!loc) return res.status(404).json({ error:"Unknown location" });

  const { start, end } = getDateRange(req);
  let contacts = [];
  try {
    contacts = await fetchAllContacts(loc.apiKey, loc.id);
  } catch (e) {
    console.error("❌ Failed fetching contacts:", e.message);
    return res.status(500).json({ error:"Contacts fetch failed" });
  }

  // Prepare accumulators
  const combined = {
    leads:0, appointments:0, shows:0, noShows:0, wins:0, cold:0
  };
  const pipelines = { adult:{}, youth:{}, leagues:{} };
  // initialize pipeline buckets
  Object.keys(pipelines).forEach(p=>{
    pipelines[p] = { leads:0, appointments:0, shows:0, noShows:0, wins:0, cold:0 };
  });

  // 9) Roll through contacts
  for (const c of contacts){
    const created = Date.parse(c.dateCreated);
    const updated = Date.parse(c.dateUpdated);
    const tags = (c.tags||[]).map(t=>t.toLowerCase());

    // determine pipelines this contact belongs to
    const memberPipes = ["adult","youth","leagues"].filter(p=>tags.includes(p));

    // A) leads: created in window
    if (created>=start && created<=end){
      combined.leads++;
      memberPipes.forEach(p=>pipelines[p].leads++);
    }
    // B) appointments
    if (tags.includes("appointment") && updated>=start && updated<=end){
      combined.appointments++;
      memberPipes.forEach(p=>pipelines[p].appointments++);
    }
    // C) shows / noShows
    if (tags.includes("show") && updated>=start && updated<=end){
      combined.shows++;
      memberPipes.forEach(p=>pipelines[p].shows++);
    }
    if (tags.includes("no-show") && updated>=start && updated<=end){
      combined.noShows++;
      memberPipes.forEach(p=>pipelines[p].noShows++);
    }
    // D) wins / cold
    if (tags.includes("won") && updated>=start && updated<=end){
      combined.wins++;
      memberPipes.forEach(p=>pipelines[p].wins++);
    }
    if (tags.includes("cold") && updated>=start && updated<=end){
      combined.cold++;
      memberPipes.forEach(p=>pipelines[p].cold++);
    }
  }

  // Return everything
  res.json({
    location: slug,
    dateRange:{
      startDate: new Date(start).toISOString().slice(0,10),
      endDate:   new Date(end).toISOString().slice(0,10)
    },
    combined,
    pipelines
  });
});

// 10) Boot
initialize()
  .then(()=> app.listen(PORT,()=>console.log(`🚀 Listening on port ${PORT}`)))
  .catch(err=>{
    console.error("❌ Init failed:", err);
    process.exit(1);
  });
