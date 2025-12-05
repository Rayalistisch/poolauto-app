// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;

// --- SUPABASE CLIENT ---
const SUPABASE_URL =
  process.env.SUPABASE_URL || "";
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.warn(
    "⚠️ SUPABASE_URL en/of SUPABASE_[ANON/SERVICE_ROLE]_KEY ontbreken. Zet deze in .env / Render env vars."
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// --- MIDDLEWARE & STATIC ---
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---- ACCOUNTS (nog steeds lokaal uit JSON) ----
const ACCOUNTS_FILE = path.join(__dirname, "accounts.json");
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
    console.error(
      "⚠️ Kon accounts.json niet lezen, gebruik lege lijst:",
      err.message
    );
    accounts = [];
  }
}

loadAccounts();

// ---- POOLAUTO'S (nog steeds hardcoded) ----
const cars = [
  { id: 1, name: "Toyota Aygo", license: "S-551-FT" },
  { id: 2, name: "Peugeot 107", license: "Z-365-HK" },
  { id: 3, name: "Citroën C1", license: "39-RGG-5" },
  { id: 4, name: "Citroën C1", license: "X-728-DH" },
  { id: 5, name: "MB Bus", license: "V-840-NP" },
];

// Helper overlap
function isOverlap(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

// ---- API ROUTES ----

// Inloggen met organisatiecode (nog steeds via accounts.json)
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

  res.json({
    orgId: account.id,
    name: account.name,
  });
});

// Alle auto's (zonder beschikbaarheid)
app.get("/api/cars", (req, res) => {
  res.json(cars);
});

// Beschikbaarheid per auto op basis van Supabase bookings
app.get("/api/cars/availability", async (req, res) => {
  const { start, end, orgId } = req.query;

  if (!start || !end || !orgId) {
    return res
      .status(400)
      .json({ error: "start, end en orgId zijn verplicht" });
  }

  const orgIdNum = Number(orgId);
  const startDate = new Date(start);
  const endDate = new Date(end);

  try {
    // Haal alle bookings voor deze org op
    const { data: orgBookings, error } = await supabase
      .from("bookings")
      .select("*")
      .eq("org_id", orgIdNum); // ✅ DB-kolom is org_id

    if (error) {
      console.error("Supabase fout /api/cars/availability:", error);
      return res
        .status(500)
        .json({ error: "Kon reserveringen niet ophalen." });
    }

    const result = cars.map((car) => {
      const conflict = (orgBookings || []).some((b) => {
        // ✅ DB-kolom is car_id
        if (b.car_id !== car.id) return false;

        // Ga er vanuit dat kolommen 'start' en 'end' heten in de DB
        return isOverlap(
          startDate,
          endDate,
          new Date(b.start),
          new Date(b.end)
        );
      });

      return {
        ...car,
        available: !conflict,
      };
    });

    res.json(result);
  } catch (err) {
    console.error("Serverfout /api/cars/availability:", err);
    res.status(500).json({ error: "Interne serverfout." });
  }
});


// Alle bookings (gefilterd op org + optioneel datum)
app.get("/api/bookings", async (req, res) => {
  const { date, orgId } = req.query;

  if (!orgId) {
    return res.status(400).json({ error: "orgId is verplicht" });
  }

  const orgIdNum = Number(orgId);

  try {
    let query = supabase
      .from("bookings")
      .select("*")
      .eq("org_id", orgIdNum)
      .order("start", { ascending: true });

    if (date) {
      // Filter op dag in UTC
      const dayStart = new Date(date + "T00:00:00.000Z");
      const dayEnd = new Date(date + "T23:59:59.999Z");

      query = query
        .gte("start", dayStart.toISOString())
        .lt("start", dayEnd.toISOString());
    }

    const { data, error } = await query;

    if (error) {
      console.error("Supabase fout GET /api/bookings:", error);
      return res
        .status(500)
        .json({ error: "Kon reserveringen niet ophalen." });
    }

    // ✅ Map snake_case (DB) → camelCase/front-end verwachte keys
    const normalized = (data || []).map((b) => ({
      id: b.id,
      orgId: b.org_id,
      carId: b.car_id,
      userName: b.user_name,
      start: b.start,
      end: b.end,
      note: b.note,
    }));

    res.json(normalized);
  } catch (err) {
    console.error("Serverfout GET /api/bookings:", err);
    res.status(500).json({ error: "Interne serverfout." });
  }
});



// Nieuwe booking (via Supabase, met gekozen auto)
// Nieuwe booking (via Supabase, met gekozen auto)
app.post("/api/bookings", async (req, res) => {
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

  try {
    // Check overlap voor deze auto binnen deze org
    const { data: overlapping, error: overlapErr } = await supabase
      .from("bookings")
      .select("*")
      .eq("org_id", orgIdNum)
      .eq("car_id", carIdNum)
      .lt("start", endDate.toISOString())
      .gt("end", startDate.toISOString());

    if (overlapErr) {
      console.error("Supabase fout overlap-check:", overlapErr);
      return res
        .status(500)
        .json({ error: "Kon beschikbaarheid niet controleren." });
    }

    if (overlapping && overlapping.length > 0) {
      return res.status(409).json({
        error: "Deze auto is in deze periode al geboekt.",
      });
    }

    const insertPayload = {
      org_id: orgIdNum,
      car_id: carIdNum,
      user_name: userName,
      start: startDate.toISOString(),
      end: endDate.toISOString(),
      note: note || "",
    };

    const { data, error } = await supabase
      .from("bookings")
      .insert([insertPayload])
      .select()
      .single();

    if (error) {
      console.error("Supabase fout INSERT /api/bookings:", error);
      return res
        .status(500)
        .json({ error: "Kon reservering niet opslaan." });
    }

    // ✅ Zelfde normalized shape als GET
    const normalized = {
      id: data.id,
      orgId: data.org_id,
      carId: data.car_id,
      userName: data.user_name,
      start: data.start,
      end: data.end,
      note: data.note,
    };

    res.status(201).json(normalized);
  } catch (err) {
    console.error("Serverfout POST /api/bookings:", err);
    res.status(500).json({ error: "Interne serverfout." });
  }
});



// Reservering verwijderen
app.delete("/api/bookings/:id", async (req, res) => {
  const id = Number(req.params.id);

  try {
    const { data, error } = await supabase
      .from("bookings")
      .delete()
      .eq("id", id)
      .select()
      .single();

    if (error) {
      console.error("Supabase fout DELETE /api/bookings/:id:", error);
      return res
        .status(500)
        .json({ error: "Kon reservering niet verwijderen." });
    }

    if (!data) {
      return res.status(404).json({ error: "Reservering niet gevonden" });
    }

    res.json({ success: true, deleted: data });
  } catch (err) {
    console.error("Serverfout DELETE /api/bookings/:id:", err);
    res.status(500).json({ error: "Interne serverfout." });
  }
});

// ---- START SERVER ----
app.listen(PORT, () => {
  console.log(`✅ Poolauto app draait op http://localhost:${PORT}`);
});
