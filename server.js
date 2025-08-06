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

const locations = [];

// STEP 2: Load API keys from CSV at runtime
function loadLocationsFromCSV() {
  return new Promise((resolve, reject) => {
    const filePath = path.join(__dirname, "secrets", "api_keys.csv");

    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (row) => {
        locations.push({
          slug: row.location.toLowerCase(),
          label: row.label,
          apiKey: row.api_key
        });
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

// STEP 3: GET /locations (safe public version)
app.get("/locations", (req, res) => {
  const safeList = locations.map(({ slug, label }) => ({ slug, label }));
  res.json(safeList);
});

// STEP 4: GET /stats/:location (real data from GHL)
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

  try {
    // Leads
    const contactsRes = await axios.get("https://rest.gohighlevel.com/v1/contacts/", { headers });
    const leads = contactsRes.data.contacts.length;

    // Appointments
    const apptRes = await axios.get("https://rest.gohighlevel.com/v1/appointments/", { headers });
    const appts = apptRes.data.appointments || [];
    const totalAppts = appts.length;
    const shows = appts.filter(a => a.status === "show").length;
    const noShows = appts.filter(a => a.status === "no show").length;

    // Opportunities
    const oppRes = await axios.get("https://rest.gohighlevel.com/v1/opportunities/", { headers });
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
    console.error("Error fetching stats:", error.message);
    res.status(500).json({ error: "Failed to fetch stats from GHL" });
  }
});

// START SERVER
loadLocationsFromCSV().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
});
