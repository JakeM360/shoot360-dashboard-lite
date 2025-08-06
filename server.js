// server.js
const express = require("express");
const fs      = require("fs");
const path    = require("path");
const csv     = require("csv-parser");
const cors    = require("cors");
const axios   = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());

let locations = [];

// STEP 1: Load CSV (api_keys.csv) and parse calendar IDs
function loadLocationsFromCSV() {
  return new Promise((resolve, reject) => {
    const filePath = path.join(__dirname, "secrets", "api_keys.csv");
    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (row) => {
        if (!row.location || !row.label || !row.api_key) return;
        // collect any calendar IDs (youth_calendar_id, adult_calendar_id, calendar_xxx_id)
        const calendars = Object.keys(row)
          .filter(k =>
            ((k.endsWith("_calendar_id")) ||
             (k.startsWith("calendar_") && k.endsWith("_id")))
            && row[k].trim()
          )
          .map(k => {
            let name;
            if (k.endsWith("_calendar_id")) {
              name = k.slice(0, -"_calendar_id".length);
            } else {
              name = k.slice("calendar_".length, -"_id".length);
            }
            return { name, id: row[k].trim() };
          });

        locations.push({
          slug:   row.location.toLowerCase().trim(),
          label:  row.label.trim(),
          apiKey: row.api_key.trim(),
          calendars
        });
      })
      .on("end", () => {
        console.log("✅ Locations loaded:", locations.map(l => l.slug));
        resolve();
      })
      .on("error", (err) => {
        console.error("❌ Error loading CSV:", err);
        reject(err);
      });
  });
}

// STEP 2: GET /locations → public list for sidebar
app.get("/locations", (req, res) => {
  res.json(locations.map(l => ({ slug: l.slug, label: l.label })));
});

// STEP 3: GET /stats/:location?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
app.get("/stats/:location", async (req, res) => {
  const { location } = req.params;
  const { startDate, endDate } = req.query;

  // Validate presence
  if (!startDate || !endDate) {
    return res.status(400).json({
      error: "Missing required query parameters",
      details: {
        startDate: { message: "startDate is required", rule: "required" },
        endDate:   { message: "endDate is required",   rule: "required" },
      }
    });
  }

  // Parse to timestamps (ms)
  const startTs = Date.parse(startDate);
  const endTs   = Date.parse(endDate) + 86399999; // include end of day
  if (isNaN(startTs) || isNaN(endTs)) {
    return res.status(400).json({
      error: "Invalid date format",
      details: "Use YYYY-MM-DD for startDate and endDate"
    });
  }

  // Find location config
  const loc = locations.find(l => l.slug === location.toLowerCase());
  if (!loc) {
    return res.status(404).json({ error: "Location not found" });
  }

  const headers = {
    Authorization: `Bearer ${loc.apiKey}`,
    "Content-Type": "application/json",
  };

  try {
    // 1) Fetch leads
    const contactsRes = await axios.get("https://rest.gohighlevel.com/v1/contacts/", {
      headers,
      params: { startDate: startTs, endDate: endTs }
    });
    const leads = Array.isArray(contactsRes.data.contacts)
      ? contactsRes.data.contacts.length
      : 0;

    // 2) Initialize combined metrics
    const combined = { leads, appointments: 0, shows: 0, noShows: 0, wins: 0, cold: 0 };
    const calendars = {};

    // 3) Fetch appointments per calendar
    await Promise.all(loc.calendars.map(async (cal) => {
      try {
        const resp = await axios.get("https://rest.gohighlevel.com/v1/appointments/", {
          headers,
          params: {
            calendarId: cal.id,
            startDate:  startTs,
            endDate:    endTs
          }
        });
        const appts = Array.isArray(resp.data.appointments) ? resp.data.appointments : [];
        const total   = appts.length;
        const shows   = appts.filter(a => a.status === "show").length;
        const noShows = appts.filter(a => a.status === "no show").length;

        calendars[cal.name] = { total, shows, noShows };
        combined.appointments += total;
        combined.shows        += shows;
        combined.noShows      += noShows;
      } catch (e) {
        console.error(`⚠ Calendar ${cal.name} error:`, e.response?.data || e.message);
        calendars[cal.name] = { error: true, details: e.response?.data || e.message };
      }
    }));

    // 4) Fetch opportunities (won + cold)
    try {
      const oppRes = await axios.get("https://rest.gohighlevel.com/v1/opportunities/", {
        headers,
        params: { startDate: startTs, endDate: endTs }
      });
      const opps = Array.isArray(oppRes.data.opportunities) ? oppRes.data.opportunities : [];
      combined.wins = opps.filter(o => o.status === "won").length;
      combined.cold = opps.filter(o => o.status === "cold").length;
    } catch (e) {
      console.error("⚠ Opportunities fetch error:", e.response?.data || e.message);
    }

    // 5) Return final JSON
    return res.json({
      location: loc.label,
      combined,
      calendars
    });

  } catch (e) {
    console.error("❌ Stats fetch error:", e.response?.data || e.message);
    return res.status(500).json({
      error: "Failed to fetch stats from GHL",
      details: e.response?.data || e.message
    });
  }
});

// STEP 4: Start server after CSV loads
loadLocationsFromCSV()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error("❌ Startup error:", err);
  });
