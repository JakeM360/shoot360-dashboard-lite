// server.js
const express = require("express");
const fs = require("fs");
const csv = require("csv-parser");
const cors = require("cors");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

const LOCATIONS_CSV = "./secrets/api_keys.csv";

// In-memory cache of locations
const locations = [];

// Load locations from CSV at startup
function loadLocations() {
  return new Promise((resolve, reject) => {
    fs.createReadStream(LOCATIONS_CSV)
      .pipe(csv())
      .on("data", (row) => {
        locations.push({
          slug: row.location.toLowerCase(),
          label: row.label,
          apiKey: row.api_key,
        });
      })
      .on("end", () => {
        console.log("Locations loaded:", locations.map(l => l.slug));
        resolve();
      })
      .on("error", reject);
  });
}

// GET /locations — return safe list
app.get("/locations", (req, res) => {
  const safeList = locations.map(({ slug, label }) => ({ slug, label }));
  res.json(safeList);
});

// Start server after loading locations
loadLocations().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
});
