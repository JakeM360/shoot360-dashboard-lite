// server.js
const express   = require("express");
const fs        = require("fs");
const path      = require("path");
const csv       = require("csv-parser");
const cors      = require("cors");
const axios     = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());

let locations = [];

// STEP 1: Load CSV and debug-print rows
function loadLocationsFromCSV() {
  return new Promise((resolve, reject) => {
    const filePath = path.join(__dirname, "secrets", "api_keys.csv");

    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (row) => {
        console.log("Loaded CSV row keys:", Object.keys(row), "values:", row);
        // Required fields check
        if (!row.location || !row.label || !row.api_key) {
          console.warn("Skipping CSV row (missing required):", row);
          return;
        }

        // Find all calendar_id columns
        const calendars = Object.entries(row)
          .filter(([key, val]) => key.endsWith("_calendar_id") && val.trim())
          .map(([key, val]) => ({
            name: key.replace("_calendar_id", ""),
            id: val.trim()
          }));

        console.log("  → Parsed calendars:", calendars);

        locations.push({
          slug: row.location.toLowerCase().trim(),
          label: row.label.trim(),
          apiKey: row.api_key.trim(),
          calendars
        });
      })
      .on("end", () => {
        console.log("✅ Final locations loaded:", locations);
        resolve();
      })
      .on("error", (err) => {
        console.error("❌ Error loading CSV:", err);
        reject(err);
      });
  });
}

// STEP 2: GET /locations
app.get("/locations", (req, res) => {
  res.json(locations.map(({ slug, label }) => ({ slug, label })));
});

// STEP 3: GET /stats/:location
app.get("/stats/:location", async (req, res) => {
  const { location } = req.params;
  const { startDate, endDate } = req.query;
  if (!startDate || !endDate) {
    return res.status(400).json({ error: "Missing startDate/endDate" });
  }

  const loc = locations.find(l => l.slug === location.toLowerCase());
  if (!loc) return res.status(404).json({ error: "Location not found" });

  const headers = { Authorization: `Bearer ${loc.apiKey}` };
  // 1) Leads
  let leads = 0;
  try {
    const c = await axios.get("https://rest.gohighlevel.com/v1/contacts/", {
      headers,
      params: { startDate, endDate }
    });
    leads = Array.isArray(c.data.contacts) ? c.data.contacts.length : 0;
  } catch (e) {
    console.error("Contacts fetch error:", e.response?.data || e.message);
  }

  const combined = { leads, appointments: 0, shows: 0, noShows: 0 };
  const calendarsRes = {};

  // 2) Per-calendar
  await Promise.all(loc.calendars.map(async (cal) => {
    try {
      const r = await axios.get("https://rest.gohighlevel.com/v1/appointments/", {
        headers,
        params: {
          calendarId: cal.id,
          startDate,
          endDate
        }
      });
      const appts = Array.isArray(r.data.appointments) ? r.data.appointments : [];
      const total = appts.length;
      const shows = appts.filter(a => a.status === "show").length;
      const noShows = appts.filter(a => a.status === "no show").length;

      calendarsRes[cal.name] = { total, shows, noShows };
      combined.appointments += total;
      combined.shows        += shows;
      combined.noShows      += noShows;
    } catch (e) {
      console.error(`Calendar ${cal.name} error:`, e.response?.data || e.message);
      calendarsRes[cal.name] = { error: true, details: e.response?.data || e.message };
    }
  }));

  res.json({ location: loc.label, combined, calendars: calendarsRes });
});

// STEP 4: Start
loadLocationsFromCSV()
  .then(() => app.listen(PORT, () => console.log(`Server on port ${PORT}`)))
  .catch(err => console.error("Startup error:", err));
