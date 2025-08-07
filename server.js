// server.js
require("dotenv").config();
const express = require("express");
const axios   = require("axios");
const cors    = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());

const GHL_API_KEY = process.env.GHL_API_KEY;
if (!GHL_API_KEY) {
  console.error("❌ Missing GHL_API_KEY");
  process.exit(1);
}
const ghHeaders = {
  Authorization: `Bearer ${GHL_API_KEY}`,
  "Content-Type": "application/json",
};

// cache locations on startup
let locationsCache = [];
async function loadLocations() {
  try {
    const { data } = await axios.get("https://rest.gohighlevel.com/v1/locations", { headers: ghHeaders });
    locationsCache = (data.locations || []).map(loc => {
      const raw = loc.name.replace(/^Shoot 360\s*-\s*/, "");
      return {
        id:   loc.id,
        name: loc.name,
        slug: raw.toLowerCase().replace(/\s+/g, "-")
      };
    });
    console.log("✅ Locations:", locationsCache.map(l => l.slug));
  } catch (e) {
    console.error("❌ Failed to load locations", e.response?.data || e.message);
  }
}

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

// GET /locations
app.get("/locations", (req, res) => {
  res.json(locationsCache);
});

// GET /stats/:location
app.get("/stats/:location", async (req, res) => {
  const loc = locationsCache.find(l => l.slug === req.params.location.toLowerCase());
  if (!loc) return res.status(404).json({ error: "Location not found" });

  const { start, end } = getDateRange(req);

  // 1) Leads via Contacts
  let leads = 0;
  try {
    const c = await axios.get("https://rest.gohighlevel.com/v1/contacts/", {
      headers: ghHeaders,
      params: { locationId: loc.id }
    });
    // filter by dateCreated client-side
    leads = (c.data.contacts || []).filter(ct =>
      Date.parse(ct.dateCreated) >= start && Date.parse(ct.dateCreated) <= end
    ).length;
  } catch (e) {
    console.error("⚠ Contacts error:", e.response?.data || e.message);
  }

  // 2) All opportunities once
  let oppsAll = [];
  try {
    const o = await axios.get("https://rest.gohighlevel.com/v1/opportunities/", {
      headers: ghHeaders,
      params: { locationId: loc.id }
    });
    oppsAll = o.data.opportunities || [];
  } catch (e) {
    console.error("⚠ Opps fetch error:", e.response?.data || e.message);
  }

  // filter opps by dateCreated
  oppsAll = oppsAll.filter(o => {
    const d = Date.parse(o.dateCreated);
    return d >= start && d <= end;
  });

  // combined stats
  const combined = {
    leads,
    appointments: oppsAll.length,
    shows:   oppsAll.filter(o => o.tags?.includes("show")).length,
    noShows: oppsAll.filter(o => o.tags?.includes("no-show")).length,
    wins:    oppsAll.filter(o => o.tags?.includes("won")).length,
    cold:    oppsAll.filter(o => o.tags?.includes("cold")).length
  };

  // pipeline breakdown by tags
  const pipelines = ["youth", "adult", "leagues"].reduce((acc, name) => {
    const list = oppsAll.filter(o => o.tags?.includes(name));
    acc[name] = {
      total:   list.length,
      shows:   list.filter(o => o.tags.includes("show")).length,
      noShows: list.filter(o => o.tags.includes("no-show")).length,
      wins:    list.filter(o => o.tags.includes("won")).length,
      cold:    list.filter(o => o.tags.includes("cold")).length
    };
    return acc;
  }, {});

  return res.json({
    location: loc.name,
    dateRange: {
      startDate: new Date(start).toISOString().slice(0,10),
      endDate:   new Date(end).toISOString().slice(0,10)
    },
    combined,
    pipelines
  });
});

// start
loadLocations().then(() => {
  app.listen(PORT, () => console.log(`🚀 on port ${PORT}`));
});
