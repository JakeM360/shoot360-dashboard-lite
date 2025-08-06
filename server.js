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
app.get('/stats/:location', async (req, res) => {
  const { location } = req.params;
  const { startDate, endDate } = req.query;

  const loc = locations.find(loc => loc.slug === location);
  if (!loc) return res.status(404).json({ error: 'Location not found' });

  if (!startDate || !endDate) {
    return res.status(400).json({
      error: 'Missing required query parameters',
      details: {
        startDate: { message: 'startDate is required', rule: 'required' },
        endDate: { message: 'endDate is required', rule: 'required' },
      },
    });
  }

  const headers = { Authorization: `Bearer ${loc.api_key}` };
  const baseUrl = 'https://rest.gohighlevel.com/v1/appointments/stats';
  const calendars = {};

  // Handle all calendar IDs dynamically
  const calendarFields = Object.keys(loc).filter(k => k.endsWith('_calendar_id'));
  let combinedStats = { leads: 0, appointments: 0, shows: 0, noShows: 0 };

  for (const field of calendarFields) {
    const calendarId = loc[field];
    if (!calendarId) continue;

    try {
      const response = await axios.get(baseUrl, {
        headers,
        params: {
          calendarId,
          startDate,
          endDate
        }
      });

      const stats = response.data;
      calendars[field.replace('_calendar_id', '')] = stats;

      // Combine stats
      Object.keys(combinedStats).forEach(key => {
        combinedStats[key] += stats[key] || 0;
      });
    } catch (error) {
      console.error(`GHL API error for ${calendarId}:`, error?.response?.data || error.message);
      return res.status(500).json({const express = require("express");
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

        // Dynamically extract calendar IDs from keys like youth_calendar_id, adult_calendar_id
        Object.keys(row).forEach((key) => {
          if (key.endsWith("_calendar_id") && row[key]) {
            calendarIds.push({
              name: key.replace("_calendar_id", ""), // e.g., "youth"
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

// STEP 2: Public stats endpoint with optional startDate and endDate
app.get("/stats/:location", async (req, res) => {
  const { location } = req.params;
  const { startDate, endDate } = req.query;

  const loc = locations.find((loc) => loc.slug === location);
  if (!loc) return res.status(404).json({ error: "Location not found" });

  if (!startDate || !endDate) {
    return res.status(400).json({
      error: "Missing required query parameters",
      details: {
        startDate: { message: "The start date field is mandatory.", rule: "required" },
        endDate: { message: "The end date field is mandatory.", rule: "required" },
      },
    });
  }

  const headers = { Authorization: `Bearer ${loc.apiKey}` };
  const baseUrl = "https://rest.gohighlevel.com/v1/appointments/stats";

  let combinedStats = { leads: 0, appointments: 0, shows: 0, noShows: 0 };
  let calendarStats = {};

  try {
    for (const cal of loc.calendars) {
      try {
        const response = await axios.get(baseUrl, {
          headers,
          params: {
            calendarId: cal.id,
            startDate,
            endDate,
          },
        });

        const stats = response.data;
        calendarStats[cal.name] = stats;

        // Add to combined stats
        Object.keys(combinedStats).forEach((key) => {
          combinedStats[key] += stats[key] || 0;
        });
      } catch (calendarError) {
        console.error(`GHL API error for calendar ${cal.name}:`, calendarError.response?.data || calendarError.message);
        calendarStats[cal.name] = { error: true, details: calendarError.response?.data || calendarError.message };
      }
    }

    res.json({
      location: loc.label,
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

// STEP 3: Start the server after CSV loads
loadLocationsFromCSV().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
});
        error: 'Failed to fetch stats from GHL',
        details: error?.response?.data || error.message
      });
    }
  }

  res.json({
    location: loc.label,
    combined: combinedStats,
    calendars
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
