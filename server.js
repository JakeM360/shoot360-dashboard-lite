const express = require("express");
const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");
const cors = require("cors");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

const locations = [];

// Load locations and API keys from CSV
function loadLocationsFromCSV() {
  return new Promise((resolve, reject) => {
    const filePath = path.join(__dirname, "secrets", "api_keys.csv");

    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (row) => {
        if (row.location && row.api_key) {
          locations.push({
            slug: row.location.toLowerCase().trim(),
            label: row.label || row.location,
            apiKey: row.api_key.trim(),
          });
        } else {
          console.warn("Skipping invalid row in CSV:", row);
        }
      })
      .on("end", () => {
        console.log("Loaded locations:", locations.map(l => l.slug));
        resolve();
      })
      .on("error", (err) => {
        console.error("Error loading CSV:", err);
        reject(err);
      });
  });
}

// Return public list of locations
app.get("/locations", (req, res) => {
  const safeList = locations.map(({ slug, label }) => ({ slug, label }));
  res.json(safeList);
});

// Return GHL stats for a specific location
app.get("/stats/:location", async (req, res) => {
  const slug = req.params.location.toLowerCase();
  const location = locations.find(l => l.slug === slug);

  if (!location) {
    return res.status(404).json({ error: "Location not found" });
  }

  const headers = {
    Authorization: `Bearer ${location.apiKey}`,
    "Content-Type": "application/json",
  };

  console.log(`Fetching stats for ${slug} using key:`, location.apiKey.slice(0, 10) + "...");

  try {
    // Leads
    const contactsRes = await axios.get("https://rest.gohighlevel.com/v2/contacts/", { headers });
    const leads = contactsRes.data.contacts.length;

    // Appointments
    const apptRes = await axios.get("https://rest.gohighlevel.com/v2/appointments/", { headers });
    const appts = apptRes.data.appointments || [];
    const totalAppts = appts.length;
    const shows = appts.filter(a => a.status === "show").length;
    const noShows = appts.filter(a => a.status === "no show").length;

    // Opportunities
    const oppRes = await axios.get("https://rest.gohighlevel.com/v2/opportunities/", { headers });
    const opps = oppRes.data.opportunities || [];
    const wins = opps.filter(o => o.status === "won").length;
    const losses = opps.filter(o => o.status === "lost").length;

    res.json({
      location: location.label,
      leads,
      appointments: totalAppts,
      shows,
      noShows,
      wins,
      losses,
    });

  } catch (error) {
    console.error("GHL API error:", error.response?.status, error.response?.data || error.message);
    res.status(500).json({
      error: "Failed to fetch stats from GHL",
      message: error.response?.data?.message || error.message,
      status: error.response?.status || 500,
    });
  }
});

// Start server after CSV loads
loadLocationsFromCSV().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
});
