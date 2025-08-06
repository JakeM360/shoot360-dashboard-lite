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

// STEP 1: Load CSV and parse all calendar IDs
function loadLocationsFromCSV() {
  return new Promise((resolve, reject) => {
    const filePath = path.join(__dirname, "secrets", "api_keys.csv");
    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (row) => {
        if (!row.location || !row.label || !row.api_key) {
          console.warn("Skipping invalid CSV row:", row);
          return;
        }
        // Collect all calendar IDs (youth_calendar_id, adult_calendar_id, etc.)
        const calendars = Object.keys(row)
          .filter((key) => key.endsWith("_calendar_id") && row[key].trim())
          .map((key) => ({
            name: key.replace("_calendar_id", ""),
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
        console.error("❌ Error loading CSV:", err);
        reject(err);
      });
  });
}

// STEP 2: GET /locations → list of { slug, label }
app.get("/locations", (req, res) => {
  res.json(locations.map(({ slug, label }) => ({ slug, label })));
});

// STEP 3: GET /stats/:location?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
app.get("/stats/:location", async (req, res) => {
  const { location } = req.params;
  const { startDate, endDate } = req.query;

  // Validate query params
  if (!startDate || !endDate) {
    return res.status(400).json({
      error: "Missing required query parameters",
      details: {
        startDate: { message: "startDate is required", rule: "required" },
        endDate:   { message: "endDate is required",   rule: "required" },
      },
    });
  }

  // Find location config
  const loc = locations.find((l) => l.slug === location.toLowerCase());
  if (!loc) {
    return res.status(404).json({ error: "Location not found" });
  }

  const headers = {
    Authorization: `Bearer ${loc.apiKey}`,
    "Content-Type": "application/json",
  };

  try {
    // 1. Fetch leads within date range
    const contactsRes = await axios.get("https://rest.gohighlevel.com/v1/contacts/", {
      headers,
      params: { startDate, endDate },
    });
    const leads = Array.isArray(contactsRes.data.contacts)
      ? contactsRes.data.contacts.length
      : 0;

    // 2. Initialize combined appointment stats
    const combined = { leads, appointments: 0, shows: 0, noShows: 0 };
    const calendars = {};

    // 3. Fetch appointments per calendar
    await Promise.all(
      loc.calendars.map(async (cal) => {
        try {
          const resp = await axios.get("https://rest.gohighlevel.com/v1/appointments/", {
            headers,
            params: {
              calendarId: cal.id,
              startDate,
              endDate,
            },
          });

          const appts = Array.isArray(resp.data.appointments)
            ? resp.data.appointments
            : [];

          const total   = appts.length;
          const shows   = appts.filter((a) => a.status === "show").length;
          const noShows = appts.filter((a) => a.status === "no show").length;

          // Record per-calendar
          calendars[cal.name] = { total, shows, noShows };

          // Accumulate into combined
          combined.appointments += total;
          combined.shows        += shows;
          combined.noShows      += noShows;
        } catch (err) {
          console.error(`⚠ Calendar ${cal.name} error:`, err.response?.data || err.message);
          calendars[cal.name] = { error: true, details: err.response?.data || err.message };
        }
      })
    );

    // 4. Return combined + breakdown
    res.json({
      location: loc.label,
      combined,
      calendars,
    });
  } catch (err) {
    console.error("❌ Error fetching stats:", err.response?.data || err.message);
    res.status(500).json({
      error: "Failed to fetch stats from GHL",
      details: err.response?.data || err.message,
    });
  }
});

// STEP 4: Start the server once CSV is loaded
loadLocationsFromCSV()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to start server:", err);
  });
