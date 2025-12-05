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
  { id: 1, name: "Toyota Aygo", license: "S-551-FT" },
  { id: 2, name: "Peugeot 107", license: "Z-365-HK" },
  { id: 3, name: "Citroën C1", license: "39-RGG-5" },
  { id: 4, name: "Citroën C1", license: "X-728-DH" },
  { id: 5, name: "MB Bus", license: "V-840-NP" },
];

// Alle auto's (zonder beschikbaarheid)
app.get("/api/cars", (req, res) => {
  res.json(cars);
});

// Beschikbaarheid per auto voor een periode
app.get("/api/cars/availability", (req, res) => {
  const { start, end, orgId } = req.query;

  if (!orgId) {
    return res.status(400).json({ error: "orgId is verplicht" });
  }

  const orgIdNum = Number(orgId);
  const orgBookings = bookings.filter((b) => b.orgId === orgIdNum);

  // Als start/eind nog niet bekend zijn → geen echte check, gewoon alles beschikbaar
  if (!start || !end) {
    const result = cars.map((car) => ({
      ...car,
      available: true,
    }));
    return res.json(result);
  }

  const startDate = new Date(start);
  const endDate = new Date(end);

  const result = cars.map((car) => {
    const conflict = orgBookings.some((b) => {
      if (b.carId !== car.id) return false;
      return isOverlap(startDate, endDate, new Date(b.start), new Date(b.end));
    });

    return {
      ...car,
      available: !conflict,
    };
  });

  res.json(result);
});

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

// Nieuwe booking (gebruiker kiest zelf auto)
app.post("/api/bookings", (req, res) => {
  const { userName, start, end, note, orgId, carId } = req.body;

  if (!orgId) {
    return res.status(400).json({ error: "orgId is verplicht" });
  }
  if (!userName || !start || !end) {
    return res.status(400).json({
      error: "userName, start en end zijn verplicht",
    });
  }
  if (!carId) {
    return res.status(400).json({
      error: "carId is verplicht",
    });
  }

  const orgIdNum = Number(orgId);
  const carIdNum = Number(carId);

  const car = cars.find((c) => c.id === carIdNum);
  if (!car) {
    return res.status(400).json({ error: "Onbekende auto" });
  }

  const startDate = new Date(start);
  const endDate = new Date(end);

  if (endDate <= startDate) {
    return res.status(400).json({
      error: "Eindtijd moet na starttijd liggen",
    });
  }

  // check overlap voor deze auto binnen deze organisatie
  const conflict = bookings.some((b) => {
    if (b.orgId !== orgIdNum) return false;
    if (b.carId !== carIdNum) return false;
    return isOverlap(startDate, endDate, new Date(b.start), new Date(b.end));
  });

  if (conflict) {
    return res.status(409).json({
      error: "Deze auto is in deze periode al geboekt.",
    });
  }

  const newBooking = {
    id: nextBookingId++,
    orgId: orgIdNum,
    carId: carIdNum,
    userName,
    start: startDate.toISOString(),
    end: endDate.toISOString(),
    note: note || "",
  };

  bookings.push(newBooking);
  saveBookings();

  res.status(201).json(newBooking);
});

// Reservering verwijderen
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
