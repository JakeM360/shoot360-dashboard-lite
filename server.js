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

// --- 1) Load sub-account API keys from CSV
const locations = [];
fs.createReadStream(path.join(__dirname,"secrets","api_keys.csv"))
  .pipe(csv())
  .on("data", row => {
    locations.push({
      slug: row.location.toLowerCase().trim(),
      apiKey: row.api_key.trim()
    });
  })
  .on("end", () => console.log("🔑 Loaded API keys for:", locations.map(l=>l.slug)));

// --- 2) Helpers for date range
function getDateRange(req) {
  const now = Date.now();
  let start = now - 1000*60*60*24*30, end = now;
  if (req.query.startDate && req.query.endDate) {
    const s = Date.parse(req.query.startDate), e = Date.parse(req.query.endDate);
    if (!isNaN(s) && !isNaN(e)) {
      start = s;
      end   = e + 86399999;
    }
  }
  return { start, end };
}

// --- 3) Initialize: for each location, discover pipelines and their stageIds
const pipelineMap = {}; // slug → [ { name, id, stageIds:{ lead, appointment, "no-show", show, cold } } ]
async function initializePipelines() {
  for (let loc of locations) {
    const hdr = { Authorization: `Bearer ${loc.apiKey}`, "Content-Type":"application/json" };

    // 3A) fetch all pipelines
    let pipelines;
    try {
      const resp = await axios.get("https://rest.gohighlevel.com/v1/pipelines/", {
        headers: hdr,
        params: { locationId: loc.slug } // if slug works; if not, use loc.id by first pulling sub-account list
      });
      pipelines = resp.data.pipelines || [];
    } catch (e) {
      console.error(`❌ Failed fetching pipelines for ${loc.slug}:`, e.message);
      pipelines = [];
    }

    // 3B) for each pipeline, fetch its stages to map names→ids
    pipelineMap[loc.slug] = [];
    for (let p of pipelines) {
      if (!["Youth","Adult","Leagues"].includes(p.name)) continue;
      let stageIds = {};
      try {
        const detail = await axios.get(`https://rest.gohighlevel.com/v1/pipelines/${p.id}`, {
          headers: hdr,
          params: { locationId: loc.slug }
        });
        const stages = detail.data.pipeline.stages || [];
        stages.forEach(s => {
          stageIds[s.name.toLowerCase().replace(/\s+/g,"-")] = s.id;
        });
      } catch (e) {
        console.error(`⚠ Failed fetching stages for pipeline ${p.name}:`, e.message);
      }
      pipelineMap[loc.slug].push({
        name: p.name.toLowerCase(),
        id:   p.id,
        stageIds
      });
    }
  }
  console.log("✅ Pipelines initialized for all locations");
}

// --- 4) GET /locations
app.get("/locations", (req,res) => {
  res.json(locations.map(l=>({ slug:l.slug })));
});

// --- 5) GET /stats/:location
app.get("/stats/:location", async (req,res) => {
  const slug = req.params.location.toLowerCase();
  const loc  = locations.find(l=>l.slug===slug);
  if (!loc) return res.status(404).json({ error:"Location not found" });

  const { start, end } = getDateRange(req);
  const hdr = { Authorization: `Bearer ${loc.apiKey}`, "Content-Type":"application/json" };

  // Combined counters
  const combined = {
    leads:0, appointments:0, shows:0, noShows:0, cold:0, wins:0
  };
  // Per-pipeline breakdown
  const pipelinesOut = {};

  // Loop each pipeline
  for (let p of pipelineMap[slug] || []) {
    pipelinesOut[p.name] = {
      leads:0, appointments:0, shows:0, noShows:0, cold:0, wins:0
    };

    let opps = [];
    try {
      const resp = await axios.get(
        `https://rest.gohighlevel.com/v1/pipelines/${p.id}/opportunities`,
        { headers: hdr, params:{ locationId: slug, startDate: start, endDate: end } }
      );
      opps = resp.data.opportunities || [];
    } catch (e) {
      console.error(`⚠ Opps fetch failed for ${slug}/${p.name}:`, e.message);
    }

    // Count by stageId
    opps.forEach(o => {
      const sid = o.stageId;
      if (sid === p.stageIds["lead"]) {
        pipelinesOut[p.name].leads++;
        combined.leads++;
      }
      if (sid === p.stageIds["appointment"]) {
        pipelinesOut[p.name].appointments++;
        combined.appointments++;
      }
      if (sid === p.stageIds["no-show"]) {
        pipelinesOut[p.name].noShows++;
        combined.noShows++;
      }
      if (sid === p.stageIds["show"]) {
        pipelinesOut[p.name].shows++;
        combined.shows++;
      }
      if (sid === p.stageIds["cold"]) {
        pipelinesOut[p.name].cold++;
        combined.cold++;
      }
      // Wins by tag
      if (o.tags?.includes("won")) {
        pipelinesOut[p.name].wins++;
        combined.wins++;
      }
    });
  }

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

// --- 6) Start after pipelines init
initializePipelines()
  .then(() => {
    app.listen(PORT, ()=>console.log(`🚀 Dashboard listening on port ${PORT}`));
  })
  .catch(err => {
    console.error("❌ Initialization failed:", err);
    process.exit(1);
  });
