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

async function loadLocationsFromCSV() {
  const filePath = path.join(__dirname, "secrets", "api_keys.csv");
  return new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", row => {
        // skip bad rows
        if (!row.location || !row.label || !row.api_key) return;

        const calendarIds = [];
        Object.keys(row).forEach((key) => {
          const val = row[key]?.trim();
          if (!val) return;

          let name = null;
          // Case A: header ends with "_calendar_id" e.g. "youth_calendar_id"
          if (key.endsWith("_calendar_id")) {
            name = key.slice(0, -"_calendar_id".length);
          }
          // Case B: header starts with "calendar_" and ends with "_id" e.g. "calendar_youth_id"
          else if (key.startsWith("calendar_") && key.endsWith("_id")) {
            name = key.slice("calendar_".length, -"_id".length);
          }

          if (name) {
            calendarIds.push({ name, id: val });
          }
        });

        locations.push({
          slug:   row.location.toLowerCase().trim(),
          label:  row.label.trim(),
          apiKey: row.api_key.trim(),
          calendars: calendarIds
        });
      })
      .on("end", () => {
        console.log("✅ Locations loaded:", locations);
        resolve();
      })
      .on("error", err => {
        console.error("❌ CSV load error:", err);
        reject(err);
      });
  });
}

// GET /locations
app.get("/locations", (req, res) => {
  res.json(locations.map(l => ({ slug: l.slug, label: l.label })));
});

// GET /stats/:location?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
app.get("/stats/:location", async (req, res) => {
  const { location } = req.params;
  const { startDate, endDate } = req.query;
  if (!startDate || !endDate) {
    return res.status(400).json({
      error: "Missing required query parameters",
      details: {
        startDate: { message: "startDate is required", rule: "required" },
        endDate:   { message: "endDate is required",   rule: "required" },
      }
    });
  }

  const loc = locations.find(l => l.slug === location.toLowerCase());
  if (!loc) return res.status(404).json({ error: "Location not found" });

  const headers = { Authorization: `Bearer ${loc.apiKey}` };

  try {
    // 1) Leads
    const contacts = await axios.get(
      "https://rest.gohighlevel.com/v1/contacts/",
      { headers, params: { startDate, endDate } }
    );
    const leads = Array.isArray(contacts.data.contacts)
      ? contacts.data.contacts.length
      : 0;

    // 2) Appointments per calendar
    const combined = { leads, appointments: 0, shows: 0, noShows: 0 };
    const calendars = {};

    await Promise.all(
      loc.calendars.map(async (cal) => {
        try {
          const resp = await axios.get(
            "https://rest.gohighlevel.com/v1/appointments/",
            { headers,
              params: { calendarId: cal.id, startDate, endDate }
            }
          );
          const appts = Array.isArray(resp.data.appointments)
            ? resp.data.appointments
            : [];

          const total   = appts.length;
          const shows   = appts.filter(a => a.status === "show").length;
          const noShows = appts.filter(a => a.status === "no show").length;

          calendars[cal.name] = { total, shows, noShows };
          combined.appointments += total;
          combined.shows        += shows;
          combined.noShows      += noShows;
        } catch (e) {
          console.error(`⚠ Calendar "${cal.name}" error:`, e.response?.data || e.message);
          calendars[cal.name] = { error: true, details: e.response?.data || e.message };
        }
      })
    );

    return res.json({ location: loc.label, combined, calendars });
  } catch (e) {
    console.error("❌ Stats fetch error:", e.response?.data || e.message);
    return res.status(500).json({
      error: "Failed to fetch stats",
      details: e.response?.data || e.message
    });
  }
});

// start server
loadLocationsFromCSV()
  .then(() => {
    app.listen(PORT, () =>
      console.log(`🚀 Server running on http://localhost:${PORT}`)
    );
  })
  .catch(err => {
    console.error("Startup error:", err);
  });
