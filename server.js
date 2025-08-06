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

// STEP 1: Load CSV and parse all calendar IDs
function loadLocationsFromCSV() {
  return new Promise((resolve, reject) => {
    const filePath = path.join(__dirname, "secrets", "api_keys.csv");

    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (row) => {
        // Basic validation
        if (!row.location || !row.label || !row.api_key) {
          console.warn("Skipping invalid row in CSV:", row);
          return;
        }

        const calendarIds = [];

        // Dynamically extract calendar IDs
        Object.keys(row).forEach((key) => {
          if (key.startsWith("calendar_") && row[key]) {
            calendarIds.push({
              name: key.replace("calendar_", "").replace("_id", ""), // e.g., youth or adult
              id: row[key],
            });
          }
        });

        locations.push({
          slug: row.location.toLowerCase(),
          label: row.label,
          apiKey: row.api_key,
          calendars: calendarIds,
        });
      })
      .on("end", () => {
        console.log("Loaded locations:", locations.map((l) => l.slug));
        resolve();
      })
      .on("error", (err) => {
        console.error("Error loading CSV:", err);
        reject(err);
      });
  });
}

// STEP 2: Public list of locations
app.get("/locations", (req, res) => {
  const safeList = locations.map(({ slug, label }) => ({ slug, label }));
  res.json(safeList);
});

// STEP 3: Stats route with calendar merging and breakdown
app.get("/stats/:location", async (req, res) => {
  const slug = req.params.location.toLowerCase();
  const location = locations.find((l) => l.slug === slug);

  if (!location) {
    return res.status(404).json({ error: "Location not found" });
  }

  const headers = {
    Authorization: `Bearer ${location.apiKey}`,
    "Content-Type": "application/json",
  };

  try {
    // Fetch leads
    const contactsRes = await axios.get("https://rest.gohighlevel.com/v1/contacts/", { headers });
    const leads = contactsRes.data.contacts.length;

    // Combined stats
    const combinedStats = {
      leads,
      appointments: 0,
      shows: 0,
      noShows: 0,
    };

    const calendarStats = {};

    // Loop through all calendar IDs
    for (const cal of location.calendars) {
      const url = `https://rest.gohighlevel.com/v1/appointments/?calendarId=${cal.id}`;
      const apptRes = await axios.get(url, { headers });

      const appts = apptRes.data.appointments || [];

      const shows = appts.filter((a) => a.status === "show").length;
      const noShows = appts.filter((a) => a.status === "no show").length;
      const total = appts.length;

      // Update per-calendar stats
      calendarStats[cal.name] = {
        calendarId: cal.id,
        total,
        shows,
        noShows,
      };

      // Update combined stats
      combinedStats.appointments += total;
      combinedStats.shows += shows;
      combinedStats.noShows += noShows;
    }

    // Return both combined and individual stats
    res.json({
      location: location.label,
      combined: combinedStats,
      calendars: calendarStats,
    });
  } catch (error) {
    console.error("GHL API error:", error.response?.data || error.message);
    res.status(500).json({
      error: "Failed to fetch stats from GHL",
      details: error.response?.data || error.message,
    });
  }
});

// STEP 4: Start server after CSV loads
loadLocationsFromCSV().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
});
