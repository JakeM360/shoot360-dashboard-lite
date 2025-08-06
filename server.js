// server.js
require("dotenv").config();
const express = require("express");
const axios   = require("axios");
const cors    = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

const GHL_API_KEY = process.env.GHL_API_KEY;
if (!GHL_API_KEY) {
  console.error("❌ Missing GHL_API_KEY in environment");
  process.exit(1);
}
const ghHeaders = {
  Authorization: `Bearer ${GHL_API_KEY}`,
  "Content-Type": "application/json",
};

// GET /locations
app.get("/locations", async (req, res) => {
  try {
    const resp = await axios.get(
      "https://rest.gohighlevel.com/v1/locations",
      { headers: ghHeaders }
    );
    const locations = (resp.data.locations || []).map(loc => ({
      id:   loc.id,
      name: loc.name,
      slug: loc.name.toLowerCase().replace(/\s+/g, "-")
    }));
    res.json(locations);
  } catch (err) {
    console.error("❌ /locations error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to load locations" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
