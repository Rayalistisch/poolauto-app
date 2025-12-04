// server.js
const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static("public")); // voor je frontend-bestanden

// Poolauto's (kun je later uit een DB halen)
const cars = [
  { id: 1, name: "Poolauto 1", license: "AA-123-B" },
  { id: 2, name: "Poolauto 2", license: "BB-456-C" },
];

let bookings = [];
let nextBookingId = 1;

// Helpers
function isOverlap(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

function findAvailableCar(startDate, endDate) {
  for (const car of cars) {
    const conflict = bookings.some((b) => {
      if (b.carId !== car.id) return false;
      const bStart = new Date(b.start);
      const bEnd = new Date(b.end);
      return isOverlap(startDate, endDate, bStart, bEnd);
    });
    if (!conflict) return car;
  }
  return null;
}

// --- API ROUTES ---

// (optioneel) Haal auto's op – niet meer nodig in frontend, maar handig voor debug
app.get("/api/cars", (req, res) => {
  res.json(cars);
});

// Haal bookings op (optioneel filteren op carId en/of date)
app.get("/api/bookings", (req, res) => {
  const { carId, date } = req.query;
  let result = bookings;

  if (carId) {
    result = result.filter((b) => b.carId === Number(carId));
  }

  // Als er een date is (YYYY-MM-DD), filter op die dag
  if (date) {
    const dayStart = new Date(date + "T00:00:00");
    const dayEnd = new Date(date + "T23:59:59");
    result = result.filter((b) => {
      const start = new Date(b.start);
      return start >= dayStart && start <= dayEnd;
    });
  }

  res.json(result);
});

// Nieuwe booking: auto wordt automatisch toegewezen
app.post("/api/bookings", (req, res) => {
  const { userName, start, end, note } = req.body;

  if (!userName || !start || !end) {
    return res
      .status(400)
      .json({ error: "userName, start en end zijn verplicht" });
  }

  const startDate = new Date(start);
  const endDate = new Date(end);

  if (endDate <= startDate) {
    return res
      .status(400)
      .json({ error: "Eindtijd moet na starttijd liggen" });
  }

  // Zoek een vrije auto in de pool
  const availableCar = findAvailableCar(startDate, endDate);

  if (!availableCar) {
    return res
      .status(409)
      .json({ error: "Er is geen poolauto beschikbaar in deze periode" });
  }

  const newBooking = {
    id: nextBookingId++,
    carId: availableCar.id,
    userName,
    start: startDate.toISOString(),
    end: endDate.toISOString(),
    note: note || "",
  };

  bookings.push(newBooking);
  res.status(201).json(newBooking);
});

// Root route
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start server
app.listen(PORT, () => {
  console.log(`Poolauto app draait op http://localhost:${PORT}`);
});
