// server.js
const express = require("express");
const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");
const cors = require("cors");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());

let locations = [];

// STEP 1: Load CSV and parse calendar IDs (any number of *_calendar_id columns)
function loadLocationsFromCSV() {
  return new Promise((resolve, reject) => {
    const filePath = path.join(__dirname, "secrets", "api_keys.csv");
    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (row) => {
        if (!row.location || !row.label || !row.api_key) {
          console.warn("Skipping CSV row (missing required fields):", row);
          return;
        }
        // collect any calendar IDs
        const calendars = Object.keys(row)
          .filter((key) => key.endsWith("_calendar_id") && row[key])
          .map((key) => ({
            name: key.replace("_calendar_id", ""), // e.g. "youth" or "adult"
            id: row[key].trim(),
          }));

        locations.push({
          slug: row.location.toLowerCase().trim(),
          label: row.label.trim(),
          apiKey: row.api_key.trim(),
          calendars,
        });
      })
      .on("end", () => {
        console.log("✅ Loaded locations:", locations.map((l) => l.slug));
        resolve();
      })
      .on("error", (err) => {
        console.error("❌ Error reading CSV:", err);
        reject(err);
      });
  });
}

// STEP 2: GET /locations → public list for sidebar
app.get("/locations", (req, res) => {
  res.json(locations.map(({ slug, label }) => ({ slug, label })));
});

// STEP 3: GET /stats/:location?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
app.get("/stats/:location", async (req, res) => {
  const { location } = req.params;
  const { startDate, endDate } = req.query;
  if (!startDate || !endDate) {
    return res.status(400).json({
      error: "Missing required query parameters",
      details: {
        startDate: { message: "The startDate field is mandatory.", rule: "required" },
        endDate:   { message: "The endDate field is mandatory.",   rule: "required" },
      },
    });
  }

  const loc = locations.find((l) => l.slug === location.toLowerCase());
  if (!loc) {
    return res.status(404).json({ error: "Location not found" });
  }

  const headers = {
    Authorization: `Bearer ${loc.apiKey}`,
    "Content-Type": "application/json",
  };

  try {
    // 1) Fetch leads count
    const contactsRes = await axios.get("https://rest.gohighlevel.com/v1/contacts/", { headers });
    const leads = Array.isArray(contactsRes.data.contacts)
      ? contactsRes.data.contacts.length
      : 0;

    // 2) Initialize stats
    const combined = { leads, appointments: 0, shows: 0, noShows: 0 };
    const calendars = {};

    // 3) Fetch stats for each calendar
    await Promise.all(
      loc.calendars.map(async (cal) => {
        try {
          const url = "https://rest.gohighlevel.com/v1/appointments/stats";
          const resp = await axios.get(url, {
            headers,
            params: { calendarId: cal.id, startDate, endDate },
          });
          const stats = resp.data;

          // record per-calendar
          calendars[cal.name] = stats;

          // accumulate into combined
          combined.appointments += stats.appointments || 0;
          combined.shows        += stats.shows        || 0;
          combined.noShows      += stats.noShows      || 0;
        } catch (err) {
          console.error(`⚠️ Calendar ${cal.name} error:`, err.response?.data || err.message);
          calendars[cal.name] = { error: true, details: err.response?.data || err.message };
        }
      })
    );

    // 4) Return JSON
    res.json({
      location: loc.label,
      combined,
      calendars,
    });

  } catch (err) {
    console.error("❌ GHL API error:", err.response?.data || err.message);
    res.status(500).json({
      error: "Failed to fetch stats from GHL",
      details: err.response?.data || err.message,
    });
  }
});

// STEP 4: Start server after CSV loads
loadLocationsFromCSV()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to start server:", err);
  });
