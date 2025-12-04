// server.js
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---- BESTANDEN ----
const DATA_FILE = path.join(__dirname, "bookings.json");

// ---- POOLAUTO'S ----
const cars = [
  { id: 1, name: "Poolauto 1", license: "AA-123-B" },
  { id: 2, name: "Poolauto 2", license: "BB-456-C" },
];

// ---- DATA LOADEN ----
let bookings = [];
let nextBookingId = 1;

function loadBookings() {
  if (fs.existsSync(DATA_FILE)) {
    const raw = fs.readFileSync(DATA_FILE, "utf-8");
    bookings = JSON.parse(raw);

    // bepaal volgende ID
    if (bookings.length > 0) {
      nextBookingId =
        Math.max(...bookings.map((b) => b.id)) + 1;
    }
  } else {
    bookings = [];
  }
}

function saveBookings() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(bookings, null, 2));
}

// Bij server-start laden
loadBookings();

// ---- HELPERS ----
function isOverlap(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

function findAvailableCar(startDate, endDate) {
  for (const car of cars) {
    const conflict = bookings.some((b) => {
      if (b.carId !== car.id) return false;
      return isOverlap(
        startDate,
        endDate,
        new Date(b.start),
        new Date(b.end)
      );
    });
    if (!conflict) return car;
  }
  return null;
}

// ---- API ROUTES ----

// Alle bookings (optioneel gefilterd op datum)
app.get("/api/bookings", (req, res) => {
  const { date } = req.query;
  let result = bookings;

  if (date) {
    result = result.filter(
      (b) => b.start.slice(0, 10) === date
    );
  }

  res.json(result);
});

// Nieuwe booking (automatische auto-toewijzing)
app.post("/api/bookings", (req, res) => {
  const { userName, start, end, note } = req.body;

  if (!userName || !start || !end) {
    return res.status(400).json({
      error: "userName, start en end zijn verplicht",
    });
  }

  const startDate = new Date(start);
  const endDate = new Date(end);

  if (endDate <= startDate) {
    return res.status(400).json({
      error: "Eindtijd moet na starttijd liggen",
    });
  }

  const availableCar = findAvailableCar(startDate, endDate);

  if (!availableCar) {
    return res.status(409).json({
      error: "Geen poolauto beschikbaar in deze periode",
    });
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
  saveBookings();

  res.status(201).json(newBooking);
});

app.delete("/api/bookings/:id", (req, res) => {
  const id = Number(req.params.id);

  const index = bookings.findIndex((b) => b.id === id);
  if (index === -1) {
    return res.status(404).json({ error: "Reservering niet gevonden" });
  }

  const deleted = bookings.splice(index, 1)[0];
  saveBookings();

  res.json({ success: true, deleted });
});

// ---- START SERVER ----
app.listen(PORT, () => {
  console.log(`✅ Poolauto app draait op http://localhost:${PORT}`);
});
