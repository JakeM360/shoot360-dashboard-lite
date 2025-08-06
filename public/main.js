// Shoot 360 Dashboard Script
// Shoot 360 Dashboard Script – main.js

document.addEventListener("DOMContentLoaded", () => {
  const data = {
    Portland: {
      leads: 134,
      appointments: 52,
      shows: 38,
      noShows: 14,
      wins: 18,
      losses: 6,
    },
    // Add more mock locations as needed
  };

  const dashboard = document.getElementById("dashboard");
  const locationKey = dashboard?.dataset?.location || "Portland";
  const locationData = data[locationKey];

  if (!locationData) {
    console.error("No data found for location:", locationKey);
    return;
  }

  // Count-up animation for each metric
  const animateCount = (el, value) => {
    const duration = 1000; // ms
    const frameRate = 60;
    const totalFrames = Math.round((duration / 1000) * frameRate);
    let frame = 0;

    const counter = setInterval(() => {
      frame++;
      const progress = frame / totalFrames;
      const current = Math.round(value * progress);
      el.textContent = current.toLocaleString();

      if (frame === totalFrames) {
        clearInterval(counter);
        el.textContent = value.toLocaleString();
      }
    }, duration / totalFrames);
  };

  // Fill each stat
  document.querySelectorAll(".s360-count").forEach((el) => {
    const key = el.dataset.key;
    const value = locationData[key];
    if (typeof value === "number") {
      animateCount(el, value);
    }
  });

  // Update timestamp
  const updated = document.getElementById("s360-updated");
  if (updated) {
    const now = new Date();
    const timeString = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    updated.textContent = `Today at ${timeString}`;
  }
});

