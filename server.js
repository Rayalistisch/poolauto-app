// server.js
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = 3000;

// --- MIDDLEWARE & STATIC ---
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---- BESTANDEN ----
const DATA_FILE = path.join(__dirname, "bookings.json");
const ACCOUNTS_FILE = path.join(__dirname, "accounts.json");

// ---- ACCOUNTS ----
let accounts = [];

function loadAccounts() {
  try {
    if (!fs.existsSync(ACCOUNTS_FILE)) {
      accounts = [];
      return;
    }
    const raw = fs.readFileSync(ACCOUNTS_FILE, "utf-8").trim();
    if (!raw) {
      accounts = [];
      return;
    }
    accounts = JSON.parse(raw);
    if (!Array.isArray(accounts)) {
      accounts = [];
    }
  } catch (err) {
    console.error("⚠️ Kon accounts.json niet lezen, gebruik lege lijst:", err.message);
    accounts = [];
  }
}

loadAccounts();

// ---- POOLAUTO'S ----
const cars = [
  { id: 1, name: "Poolauto 1", license: "AA-123-B" },
  { id: 2, name: "Poolauto 2", license: "BB-456-C" },
];

// ---- BOOKINGS DATA ----
let bookings = [];
let nextBookingId = 1;

function loadBookings() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      bookings = [];
      return;
    }

    const raw = fs.readFileSync(DATA_FILE, "utf-8").trim();
    if (!raw) {
      bookings = [];
      return;
    }

    bookings = JSON.parse(raw);
    if (!Array.isArray(bookings)) {
      bookings = [];
    }

    if (bookings.length > 0) {
      nextBookingId = Math.max(...bookings.map((b) => Number(b.id) || 0)) + 1;
    }
  } catch (err) {
    console.error("⚠️ Kon bookings.json niet lezen, reset naar leeg:", err.message);
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

function findAvailableCar(startDate, endDate, orgId) {
  // Voor nu delen alle organisaties dezelfde auto's.
  // Wil je per organisatie eigen auto's, dan filter je hier ook op orgId.
  for (const car of cars) {
    const conflict = bookings.some((b) => {
      if (b.carId !== car.id) return false;
      if (b.orgId !== orgId) return false;
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

// Inloggen met organisatiecode
app.post("/api/login", (req, res) => {
  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ error: "Code is verplicht" });
  }

  const account = accounts.find(
    (a) => a.code.toLowerCase() === String(code).toLowerCase()
  );

  if (!account) {
    return res.status(401).json({ error: "Onbekende code" });
  }

  // Echte SaaS zou hier een token maken; nu volstaat orgId + name.
  res.json({
    orgId: account.id,
    name: account.name,
  });
});

// Alle bookings (gefilterd op org + optioneel datum)
app.get("/api/bookings", (req, res) => {
  const { date, orgId } = req.query;

  if (!orgId) {
    return res.status(400).json({ error: "orgId is verplicht" });
  }

  const orgIdNum = Number(orgId);
  let result = bookings.filter((b) => b.orgId === orgIdNum);

  if (date) {
    result = result.filter((b) => b.start.slice(0, 10) === date);
  }

  res.json(result);
});

// Nieuwe booking (automatische auto-toewijzing, per org)
app.post("/api/bookings", (req, res) => {
  const { userName, start, end, note, orgId } = req.body;

  if (!orgId) {
    return res.status(400).json({
      error: "orgId is verplicht",
    });
  }

  const orgIdNum = Number(orgId);

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

  const availableCar = findAvailableCar(startDate, endDate, orgIdNum);

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
    orgId: orgIdNum,
  };

  bookings.push(newBooking);
  saveBookings();

  res.status(201).json(newBooking);
});

// Reservering verwijderen (optioneel: orgId checken)
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
