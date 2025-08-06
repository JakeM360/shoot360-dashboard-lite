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

// STEP 1: Load API keys from CSV at runtime
function loadLocationsFromCSV() {
  return new Promise((resolve, reject) => {
    const filePath = path.join(__dirname, "secrets", "api_keys.csv");

    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (row) => {
        const slug = (row.location || "").trim().toLowerCase();
        const label = (row.label || "").trim();
        const apiKey = (row.api_key || "").trim();

        if (slug && label && apiKey) {
          locations.push({ slug, label, apiKey });
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

// STEP 2: GET /locations (public safe list)
app.get("/locations", (req, res) => {
  const safeList = locations.map(({ slug, label }) => ({ slug, label }));
  res.json(safeList);
});

// STEP 3: GET /stats/:location (real GHL stats)
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
    // Contacts
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
    console.error("Error fetching stats from GHL:", error.message);
    res.status(500).json({ error: "Failed to fetch stats from GHL" });
  }
});

// STEP 4: Start the server
loadLocationsFromCSV().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
});
