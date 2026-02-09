// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

// --- JWT CONFIG ---
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "24h";
const SALT_ROUNDS = 12;

if (!JWT_SECRET) {
  console.warn("⚠️ JWT_SECRET ontbreekt in .env - auth endpoints werken niet!");
}

const app = express();
const PORT = process.env.PORT || 3000;

// --- SUPABASE CLIENT ---
const SUPABASE_URL = process.env.SUPABASE_URL || "";
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
    if (!Array.isArray(accounts)) accounts = [];
  } catch (err) {
    console.error("⚠️ Kon accounts.json niet lezen, gebruik lege lijst:", err.message);
    accounts = [];
  }
}
loadAccounts();

// Helper overlap
function isOverlap(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

// Helper: YYYY-MM-DD in UTC start/end
function dayStartIso(dateStr) {
  return new Date(dateStr + "T00:00:00.000Z").toISOString();
}
function dayEndIso(dateStr) {
  return new Date(dateStr + "T23:59:59.999Z").toISOString();
}
function isoDay(dateObj) {
  return dateObj.toISOString().slice(0, 10);
}

// Helper: date-string ('YYYY-MM-DD' of ISO) -> start-of-day / end-of-day ISO
function toDayStartIso(dateStr) {
  if (!dateStr) return null;
  if (dateStr.includes("T")) return new Date(dateStr).toISOString();
  return new Date(dateStr + "T00:00:00.000Z").toISOString();
}
function toDayEndIso(dateStr) {
  if (!dateStr) return null;
  if (dateStr.includes("T")) return new Date(dateStr).toISOString();
  return new Date(dateStr + "T23:59:59.999Z").toISOString();
}

// ---- API ROUTES ----

// Inloggen met organisatiecode (nog steeds via accounts.json) - LEGACY, blijft werken
app.post("/api/login", (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "Code is verplicht" });

  const account = accounts.find(
    (a) => a.code.toLowerCase() === String(code).toLowerCase()
  );

  if (!account) return res.status(401).json({ error: "Onbekende code" });

  res.json({ orgId: account.id, name: account.name });
});

//
// ---------- NIEUWE AUTH ENDPOINTS (Fase 2) ----------
//

// Verify organization code (stap 1 van nieuwe login flow)
app.post("/api/auth/verify-org", async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "Code is verplicht" });

  try {
    const { data, error } = await supabase
      .from("organizations")
      .select("id, name, allowed_sections, meeting_org_id")
      .ilike("code", code)
      .single();

    if (error || !data) {
      return res.status(401).json({ error: "Onbekende organisatiecode" });
    }

    // Defaults: alle secties, eigen org voor meetings
    const allowedSections = data.allowed_sections || ["cars", "meetings"];
    const meetingOrgId = data.meeting_org_id || data.id;

    res.json({ orgId: data.id, orgName: data.name, allowedSections, meetingOrgId });
  } catch (err) {
    console.error("Serverfout /api/auth/verify-org:", err);
    res.status(500).json({ error: "Interne serverfout." });
  }
});

// Register new user (stap 2a van nieuwe login flow)
app.post("/api/auth/register", async (req, res) => {
  const { orgId, email, password, name } = req.body;

  if (!orgId || !email || !password || !name) {
    return res.status(400).json({ error: "Alle velden zijn verplicht" });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: "Wachtwoord moet minimaal 8 tekens bevatten" });
  }

  const emailLower = email.toLowerCase().trim();
  const nameTrimmed = name.trim();

  try {
    // Check of email al bestaat in deze org
    const { data: existing } = await supabase
      .from("users")
      .select("id")
      .eq("org_id", orgId)
      .eq("email", emailLower)
      .single();

    if (existing) {
      return res.status(409).json({ error: "E-mailadres is al geregistreerd" });
    }

    // Hash wachtwoord
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    // Insert nieuwe user
    const { data: user, error } = await supabase
      .from("users")
      .insert([{
        org_id: orgId,
        email: emailLower,
        password_hash: passwordHash,
        name: nameTrimmed,
        role: "user"
      }])
      .select("id, org_id, email, name, role")
      .single();

    if (error) {
      console.error("Register error:", error);
      return res.status(500).json({ error: "Kon account niet aanmaken" });
    }

    // Haal org settings op voor allowed_sections en meeting_org_id
    const { data: org } = await supabase
      .from("organizations")
      .select("allowed_sections, meeting_org_id")
      .eq("id", orgId)
      .single();

    const allowedSections = org?.allowed_sections || ["cars", "meetings"];
    const meetingOrgId = org?.meeting_org_id || orgId;

    // Genereer JWT token
    const token = jwt.sign({
      userId: user.id,
      orgId: user.org_id,
      email: user.email,
      name: user.name,
      role: user.role,
      allowedSections,
      meetingOrgId
    }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

    res.status(201).json({
      token,
      user: {
        id: user.id,
        orgId: user.org_id,
        email: user.email,
        name: user.name,
        role: user.role,
        allowedSections,
        meetingOrgId
      }
    });
  } catch (err) {
    console.error("Serverfout /api/auth/register:", err);
    res.status(500).json({ error: "Interne serverfout." });
  }
});

// Login existing user (stap 2b van nieuwe login flow)
app.post("/api/auth/login", async (req, res) => {
  const { orgId, email, password } = req.body;

  if (!orgId || !email || !password) {
    return res.status(400).json({ error: "Alle velden zijn verplicht" });
  }

  const emailLower = email.toLowerCase().trim();

  try {
    const { data: user, error } = await supabase
      .from("users")
      .select("id, org_id, email, name, role, password_hash")
      .eq("org_id", orgId)
      .eq("email", emailLower)
      .single();

    if (error || !user) {
      return res.status(401).json({ error: "Onjuist e-mailadres of wachtwoord" });
    }

    // Verify wachtwoord
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: "Onjuist e-mailadres of wachtwoord" });
    }

    // Haal org settings op voor allowed_sections en meeting_org_id
    const { data: org } = await supabase
      .from("organizations")
      .select("allowed_sections, meeting_org_id")
      .eq("id", orgId)
      .single();

    const allowedSections = org?.allowed_sections || ["cars", "meetings"];
    const meetingOrgId = org?.meeting_org_id || orgId;

    // Genereer JWT token
    const token = jwt.sign({
      userId: user.id,
      orgId: user.org_id,
      email: user.email,
      name: user.name,
      role: user.role,
      allowedSections,
      meetingOrgId
    }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

    res.json({
      token,
      user: {
        id: user.id,
        orgId: user.org_id,
        email: user.email,
        name: user.name,
        role: user.role,
        allowedSections,
        meetingOrgId
      }
    });
  } catch (err) {
    console.error("Serverfout /api/auth/login:", err);
    res.status(500).json({ error: "Interne serverfout." });
  }
});

// Get current user from token
app.get("/api/auth/me", async (req, res) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Geen toegangstoken meegegeven" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({
      userId: decoded.userId,
      orgId: decoded.orgId,
      email: decoded.email,
      name: decoded.name,
      role: decoded.role
    });
  } catch (err) {
    return res.status(401).json({ error: "Ongeldig of verlopen token" });
  }
});

// Helper: Extract user from token (returns null if no/invalid token - for backwards compatibility)
function getUserFromToken(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }
  const token = authHeader.split(" ")[1];
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

//
// ---------- EXTRA BESCHIKBARE AUTO'S (Supabase) ----------
//

// GET /api/extra-cars?orgId=1&date=2025-12-15
app.get("/api/extra-cars", async (req, res) => {
  const { orgId, date } = req.query;

  if (!orgId) return res.status(400).json({ error: "orgId is verplicht" });

  const orgIdNum = Number(orgId);
  const d = date || new Date().toISOString().slice(0, 10);

  try {
    const { data, error } = await supabase
      .from("extra_cars")
      .select("id, org_id, license, name, date")
      .eq("org_id", orgIdNum)
      .eq("date", d)
      .order("id", { ascending: true });

    if (error) {
      console.error("Supabase fout GET /api/extra-cars:", error);
      return res.status(500).json({ error: "Kon extra auto's niet ophalen." });
    }

    // ✅ camelCase teruggeven
    res.json(
      (data || []).map((x) => ({
        id: x.id,
        orgId: x.org_id,
        license: x.license,
        name: x.name || "",
        date: x.date,
      }))
    );
  } catch (err) {
    console.error("Serverfout GET /api/extra-cars:", err);
    res.status(500).json({ error: "Interne serverfout." });
  }
});

// POST /api/extra-cars  { orgId, license, name?, date? }
app.post("/api/extra-cars", async (req, res) => {
  const { orgId, license, name, date } = req.body;

  if (!orgId) return res.status(400).json({ error: "orgId is verplicht" });
  if (!license) return res.status(400).json({ error: "license is verplicht" });

  const orgIdNum = Number(orgId);
  const d = date || new Date().toISOString().slice(0, 10);

  try {
    const payload = {
      org_id: orgIdNum,
      license: String(license).trim(),
      name: name ? String(name).trim() : null,
      date: d,
    };

    const { data, error } = await supabase
      .from("extra_cars")
      .insert([payload])
      .select("id, org_id, license, name, date")
      .single();

    if (error) {
      console.error("Supabase fout POST /api/extra-cars:", error);
      return res.status(500).json({ error: "Kon extra auto niet opslaan." });
    }

    // ✅ camelCase teruggeven
    res.status(201).json({
      id: data.id,
      orgId: data.org_id,
      license: data.license,
      name: data.name || "",
      date: data.date,
    });
  } catch (err) {
    console.error("Serverfout POST /api/extra-cars:", err);
    res.status(500).json({ error: "Interne serverfout." });
  }
});

//
// ---------- AUTO'S (Supabase + garage-periode) ----------
//

// Alle auto's uit Supabase (incl. status + garage-periode)
app.get("/api/cars", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("cars")
      .select("id, name, license, status, unavailable_from, unavailable_until")
      .order("id", { ascending: true });

    if (error) {
      console.error("Supabase fout GET /api/cars:", error);
      return res.status(500).json({ error: "Kon auto's niet ophalen." });
    }

    res.json(
      (data || []).map((c) => ({
        id: c.id,
        name: c.name,
        license: c.license,
        status: c.status || "ok",
        unavailableFrom: c.unavailable_from,
        unavailableUntil: c.unavailable_until,
      }))
    );
  } catch (err) {
    console.error("Serverfout GET /api/cars:", err);
    res.status(500).json({ error: "Interne serverfout." });
  }
});

// Auto status + garage-periode aanpassen
app.patch("/api/cars/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { status, unavailableFrom, unavailableUntil } = req.body;

  if (!["ok", "garage"].includes(status)) {
    return res
      .status(400)
      .json({ error: "Ongeldige status. Gebruik 'ok' of 'garage'." });
  }

  let updatePayload = { status };

  if (unavailableFrom || unavailableUntil) {
    updatePayload.unavailable_from = unavailableFrom
      ? toDayStartIso(unavailableFrom)
      : null;
    updatePayload.unavailable_until = unavailableUntil
      ? toDayEndIso(unavailableUntil)
      : null;
  } else {
    updatePayload.unavailable_from = null;
    updatePayload.unavailable_until = null;
  }

  try {
    const { data, error } = await supabase
      .from("cars")
      .update(updatePayload)
      .eq("id", id)
      .select("id, name, license, status, unavailable_from, unavailable_until")
      .single();

    if (error) {
      console.error("Supabase fout PATCH /api/cars/:id:", error);
      return res
        .status(500)
        .json({ error: "Kon status niet bijwerken in de database." });
    }

    if (!data) return res.status(404).json({ error: "Auto niet gevonden." });

    res.json({
      id: data.id,
      name: data.name,
      license: data.license,
      status: data.status,
      unavailableFrom: data.unavailable_from,
      unavailableUntil: data.unavailable_until,
    });
  } catch (err) {
    console.error("Serverfout PATCH /api/cars/:id:", err);
    res.status(500).json({ error: "Interne serverfout." });
  }
});

//
// ---------- AVAILABILITY (pool + extra) ----------
//

// GET /api/cars/availability?orgId=1&start=...&end=...
app.get("/api/cars/availability", async (req, res) => {
  const { start, end, orgId } = req.query;

  if (!start || !end || !orgId) {
    return res.status(400).json({ error: "start, end en orgId zijn verplicht" });
  }

  const orgIdNum = Number(orgId);
  const startDate = new Date(start);
  const endDate = new Date(end);
  const day = isoDay(startDate);

  try {
    // 1) Poolauto's
    const { data: carsData, error: carsError } = await supabase
      .from("cars")
      .select("id, name, license, status, unavailable_from, unavailable_until")
      .order("id", { ascending: true });

    if (carsError) {
      console.error("Supabase fout (cars) /api/cars/availability:", carsError);
      return res.status(500).json({ error: "Kon auto's niet ophalen." });
    }

    // 2) Extra auto's voor die dag
    const { data: extraCarsData, error: extraErr } = await supabase
      .from("extra_cars")
      .select("id, org_id, license, name, date")
      .eq("org_id", orgIdNum)
      .eq("date", day)
      .order("id", { ascending: true });

    if (extraErr) {
      console.error("Supabase fout (extra_cars) /api/cars/availability:", extraErr);
      return res.status(500).json({ error: "Kon extra auto's niet ophalen." });
    }

    // 3) Alle bookings voor deze org
    const { data: bookingsData, error: bookingsError } = await supabase
      .from("bookings")
      .select("*")
      .eq("org_id", orgIdNum);

    if (bookingsError) {
      console.error("Supabase fout (bookings) /api/cars/availability:", bookingsError);
      return res.status(500).json({ error: "Kon reserveringen niet ophalen." });
    }

    const cars = carsData || [];
    const extraCars = extraCarsData || [];
    const bookings = bookingsData || [];

    const result = [];

    // Poolauto availability (incl. garage-periode)
    cars.forEach((car) => {
      const status = car.status || "ok";

      let isGarageForThisRequest = false;
      if (status === "garage") {
        if (car.unavailable_from && car.unavailable_until) {
          isGarageForThisRequest = isOverlap(
            startDate,
            endDate,
            new Date(car.unavailable_from),
            new Date(car.unavailable_until)
          );
        } else {
          isGarageForThisRequest = true;
        }
      }

      const conflict = bookings.some((b) => {
        if (b.car_id !== car.id) return false;
        return isOverlap(startDate, endDate, new Date(b.start), new Date(b.end));
      });

      result.push({
        type: "pool",
        id: car.id,
        name: car.name,
        license: car.license,
        status,
        unavailableFrom: car.unavailable_from,
        unavailableUntil: car.unavailable_until,
        available: !isGarageForThisRequest && !conflict,
      });
    });

    // Extra cars availability
    extraCars.forEach((c) => {
      const conflict = bookings.some((b) => {
        if (b.extra_car_id !== c.id) return false;
        return isOverlap(startDate, endDate, new Date(b.start), new Date(b.end));
      });

      result.push({
        type: "extra",
        id: c.id,
        name: c.name || "Extra auto",
        license: c.license,
        status: "ok",
        unavailableFrom: null,
        unavailableUntil: null,
        available: !conflict,
      });
    });

    res.json(result);
  } catch (err) {
    console.error("Serverfout /api/cars/availability:", err);
    res.status(500).json({ error: "Interne serverfout." });
  }
});

//
// ---------- BOOKINGS (Supabase) ----------
//

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
      query = query.gte("start", dayStartIso(date)).lt("start", dayEndIso(date));
    }

    const { data, error } = await query;

    if (error) {
      console.error("Supabase fout GET /api/bookings:", error);
      return res.status(500).json({ error: "Kon reserveringen niet ophalen." });
    }

    // ✅ DIT FIXT JOUW “car undefined”:
    // snake_case → camelCase
    const normalized = (data || []).map((b) => ({
      id: b.id,
      orgId: b.org_id,
      carId: b.car_id,
      extraCarId: b.extra_car_id,
      userId: b.user_id,  // Voor ownership check in frontend
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

// Nieuwe booking (poolauto óf extra-auto)
app.post("/api/bookings", async (req, res) => {
  const { userName, start, end, note, orgId, carId, extraCarId } = req.body;

  if (!orgId) return res.status(400).json({ error: "orgId is verplicht" });
  if (!userName || !start || !end) {
    return res.status(400).json({ error: "userName, start en end zijn verplicht" });
  }

  // Haal user uit token als aanwezig (voor user_id koppeling)
  const tokenUser = getUserFromToken(req);
  const userId = tokenUser ? tokenUser.userId : null;

  const orgIdNum = Number(orgId);
  const startDate = new Date(start);
  const endDate = new Date(end);

  if (endDate <= startDate) {
    return res.status(400).json({ error: "Eindtijd moet na starttijd liggen" });
  }

  const hasPoolCar =
    carId !== null && carId !== undefined && String(carId).trim() !== "";
  const hasExtraCar =
    extraCarId !== null && extraCarId !== undefined && String(extraCarId).trim() !== "";

  if (!hasPoolCar && !hasExtraCar) {
    return res.status(400).json({ error: "carId of extraCarId is verplicht" });
  }
  if (hasPoolCar && hasExtraCar) {
    return res.status(400).json({ error: "Gebruik óf carId óf extraCarId (niet allebei)" });
  }

  try {
    // -----------------------------
    // CASE 1: POOLAUTO
    // -----------------------------
    if (hasPoolCar) {
      const carIdNum = Number(carId);

      // Check of auto bestaat en status / periode dit tijdvak blokkeren
      const { data: carData, error: carError } = await supabase
        .from("cars")
        .select("id, status, unavailable_from, unavailable_until")
        .eq("id", carIdNum)
        .single();

      if (carError || !carData) {
        console.error("Supabase fout auto-check /api/bookings:", carError);
        return res.status(400).json({ error: "Onbekende auto." });
      }

      const status = carData.status || "ok";
      let isGarageForThisRequest = false;

      if (status === "garage") {
        if (carData.unavailable_from && carData.unavailable_until) {
          isGarageForThisRequest = isOverlap(
            startDate,
            endDate,
            new Date(carData.unavailable_from),
            new Date(carData.unavailable_until)
          );
        } else {
          isGarageForThisRequest = true;
        }
      }

      if (isGarageForThisRequest) {
        return res.status(409).json({
          error: "Deze auto staat in deze periode op 'garage / niet beschikbaar'.",
        });
      }

      // Overlap check poolauto
      const { data: overlapping, error: overlapErr } = await supabase
        .from("bookings")
        .select("id")
        .eq("org_id", orgIdNum)
        .eq("car_id", carIdNum)
        .lt("start", endDate.toISOString())
        .gt("end", startDate.toISOString());

      if (overlapErr) {
        console.error("Supabase fout overlap-check poolauto:", overlapErr);
        return res.status(500).json({ error: "Kon beschikbaarheid niet controleren." });
      }

      if (overlapping && overlapping.length > 0) {
        return res.status(409).json({ error: "Deze auto is in deze periode al geboekt." });
      }

      const insertPayload = {
        org_id: orgIdNum,
        car_id: carIdNum,
        extra_car_id: null,
        user_id: userId,  // Koppel aan user als ingelogd, anders null
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
        console.error("Supabase fout INSERT /api/bookings (poolauto):", error);
        return res.status(500).json({ error: "Kon reservering niet opslaan." });
      }

      // ✅ camelCase response
      return res.status(201).json({
        id: data.id,
        orgId: data.org_id,
        carId: data.car_id,
        extraCarId: data.extra_car_id,
        userName: data.user_name,
        start: data.start,
        end: data.end,
        note: data.note,
      });
    }

    // -----------------------------
    // CASE 2: EXTRA AUTO
    // -----------------------------
    const extraIdNum = Number(extraCarId);
    const startDay = isoDay(startDate);

    const { data: extraData, error: extraErr } = await supabase
      .from("extra_cars")
      .select("id, org_id, license, name, date")
      .eq("id", extraIdNum)
      .eq("org_id", orgIdNum)
      .eq("date", startDay)
      .single();

    if (extraErr || !extraData) {
      console.error("Supabase fout extra-car check:", extraErr);
      return res
        .status(400)
        .json({ error: "Extra auto niet gevonden (of niet beschikbaar vandaag)." });
    }

    // Overlap check extra auto
    const { data: overlappingExtra, error: overlapExtraErr } = await supabase
      .from("bookings")
      .select("id")
      .eq("org_id", orgIdNum)
      .eq("extra_car_id", extraIdNum)
      .lt("start", endDate.toISOString())
      .gt("end", startDate.toISOString());

    if (overlapExtraErr) {
      console.error("Supabase fout overlap-check extra auto:", overlapExtraErr);
      return res.status(500).json({ error: "Kon beschikbaarheid niet controleren." });
    }

    if (overlappingExtra && overlappingExtra.length > 0) {
      return res.status(409).json({ error: "Deze extra auto is in deze periode al geboekt." });
    }

    const insertPayloadExtra = {
      org_id: orgIdNum,
      car_id: null,
      extra_car_id: extraIdNum,
      user_id: userId,  // Koppel aan user als ingelogd, anders null
      user_name: userName,
      start: startDate.toISOString(),
      end: endDate.toISOString(),
      note: note || "",
    };

    const { data: inserted, error: insErr } = await supabase
      .from("bookings")
      .insert([insertPayloadExtra])
      .select()
      .single();

    if (insErr) {
      console.error("Supabase fout INSERT /api/bookings (extra):", insErr);
      return res.status(500).json({ error: "Kon reservering niet opslaan." });
    }

    // ✅ camelCase response
    return res.status(201).json({
      id: inserted.id,
      orgId: inserted.org_id,
      carId: inserted.car_id,
      extraCarId: inserted.extra_car_id,
      userName: inserted.user_name,
      start: inserted.start,
      end: inserted.end,
      note: inserted.note,
    });
  } catch (err) {
    console.error("Serverfout POST /api/bookings:", err);
    res.status(500).json({ error: "Interne serverfout." });
  }
});

// Reservering verwijderen (met ownership check)
app.delete("/api/bookings/:id", async (req, res) => {
  const id = Number(req.params.id);
  const tokenUser = getUserFromToken(req);

  try {
    // Eerst de booking ophalen om ownership te checken
    const { data: booking, error: fetchError } = await supabase
      .from("bookings")
      .select("id, user_id, org_id")
      .eq("id", id)
      .single();

    if (fetchError || !booking) {
      return res.status(404).json({ error: "Reservering niet gevonden" });
    }

    // Ownership check (alleen als er een token is)
    if (tokenUser) {
      const isOwner = booking.user_id === tokenUser.userId;
      const isAdmin = tokenUser.role === "admin";
      const isLegacy = booking.user_id === null;

      // Legacy reserveringen (zonder user_id) kunnen alleen door admins verwijderd worden
      // Eigen reserveringen kunnen altijd verwijderd worden
      // Admins kunnen alles verwijderen
      if (!isOwner && !isAdmin) {
        return res.status(403).json({
          error: "Je kunt alleen je eigen reserveringen verwijderen"
        });
      }
      if (isLegacy && !isAdmin) {
        return res.status(403).json({
          error: "Oude reserveringen kunnen alleen door admins verwijderd worden"
        });
      }
    }
    // Geen token = oude flow (tijdelijk toegestaan voor backwards compatibility)

    const { data, error } = await supabase
      .from("bookings")
      .delete()
      .eq("id", id)
      .select()
      .single();

    if (error) {
      console.error("Supabase fout DELETE /api/bookings/:id:", error);
      return res.status(500).json({ error: "Kon reservering niet verwijderen." });
    }

    res.json({ success: true, deleted: data });
  } catch (err) {
    console.error("Serverfout DELETE /api/bookings/:id:", err);
    res.status(500).json({ error: "Interne serverfout." });
  }
});

// Voeg deze code toe VOOR de "START SERVER" regel in je server.js

//
// ---------- MEETING ROOMS (Supabase) ----------
//

// GET alle vergaderruimtes voor een organisatie
app.get("/api/meeting-rooms", async (req, res) => {
  const { orgId } = req.query;

  if (!orgId) {
    return res.status(400).json({ error: "orgId is verplicht" });
  }

  const orgIdNum = Number(orgId);

  try {
    const { data, error } = await supabase
      .from("meeting_rooms")
      .select("*")
      .eq("org_id", orgIdNum)
      .order("id", { ascending: true });

    if (error) {
      console.error("Supabase fout GET /api/meeting-rooms:", error);
      return res.status(500).json({ error: "Kon vergaderruimtes niet ophalen." });
    }

    // camelCase response
    res.json(
      (data || []).map((r) => ({
        id: r.id,
        orgId: r.org_id,
        name: r.name,
        capacity: r.capacity,
      }))
    );
  } catch (err) {
    console.error("Serverfout GET /api/meeting-rooms:", err);
    res.status(500).json({ error: "Interne serverfout." });
  }
});

//
// ---------- MEETING BOOKINGS (Supabase) ----------
//

// GET alle vergaderreserveringen (gefilterd op org + optioneel datum)
app.get("/api/meeting-bookings", async (req, res) => {
  const { date, orgId } = req.query;

  if (!orgId) {
    return res.status(400).json({ error: "orgId is verplicht" });
  }

  const orgIdNum = Number(orgId);

  try {
    let query = supabase
      .from("meeting_bookings")
      .select("*")
      .eq("org_id", orgIdNum)
      .order("start_time", { ascending: true });

    if (date) {
      query = query.gte("start_time", dayStartIso(date)).lt("start_time", dayEndIso(date));
    }

    const { data, error } = await query;

    if (error) {
      console.error("Supabase fout GET /api/meeting-bookings:", error);
      return res.status(500).json({ error: "Kon vergaderreserveringen niet ophalen." });
    }

    // Haal organisatienamen op voor source_org_ids
    const sourceOrgIds = [...new Set((data || []).map(b => b.source_org_id).filter(Boolean))];
    let orgNames = {};
    if (sourceOrgIds.length > 0) {
      const { data: orgs } = await supabase
        .from("organizations")
        .select("id, name")
        .in("id", sourceOrgIds);
      orgNames = (orgs || []).reduce((acc, o) => ({ ...acc, [o.id]: o.name }), {});
    }

    // camelCase response
    const normalized = (data || []).map((b) => ({
      id: b.id,
      roomId: b.room_id,
      orgId: b.org_id,
      sourceOrgId: b.source_org_id,
      sourceOrgName: orgNames[b.source_org_id] || null,
      userId: b.user_id,  // Voor ownership check in frontend
      title: b.title,
      organizer: b.organizer,
      startTime: b.start_time,
      endTime: b.end_time,
    }));

    res.json(normalized);
  } catch (err) {
    console.error("Serverfout GET /api/meeting-bookings:", err);
    res.status(500).json({ error: "Interne serverfout." });
  }
});

// POST nieuwe vergaderreservering
app.post("/api/meeting-bookings", async (req, res) => {
  const { roomId, orgId, title, organizer, startTime, endTime } = req.body;

  if (!orgId || !roomId || !organizer || !startTime || !endTime) {
    return res.status(400).json({
      error: "orgId, roomId, organizer, startTime en endTime zijn verplicht"
    });
  }

  // Haal user uit token als aanwezig (voor user_id en source_org koppeling)
  const tokenUser = getUserFromToken(req);
  const userId = tokenUser ? tokenUser.userId : null;
  const sourceOrgId = tokenUser ? tokenUser.orgId : orgId; // Echte org van de user

  const orgIdNum = Number(orgId);
  const roomIdNum = Number(roomId);
  const start = new Date(startTime);
  const end = new Date(endTime);

  if (end <= start) {
    return res.status(400).json({ error: "Eindtijd moet na starttijd liggen" });
  }

  try {
    // Check of kamer bestaat en bij deze org hoort
    const { data: roomData, error: roomError } = await supabase
      .from("meeting_rooms")
      .select("id, org_id")
      .eq("id", roomIdNum)
      .eq("org_id", orgIdNum)
      .single();

    if (roomError || !roomData) {
      console.error("Supabase fout room-check /api/meeting-bookings:", roomError);
      return res.status(400).json({ error: "Onbekende vergaderruimte." });
    }

    // Check overlap
    const { data: overlapping, error: overlapErr } = await supabase
      .from("meeting_bookings")
      .select("id")
      .eq("room_id", roomIdNum)
      .lt("start_time", end.toISOString())
      .gt("end_time", start.toISOString());

    if (overlapErr) {
      console.error("Supabase fout overlap-check vergadering:", overlapErr);
      return res.status(500).json({ error: "Kon beschikbaarheid niet controleren." });
    }

    if (overlapping && overlapping.length > 0) {
      return res.status(409).json({ 
        error: "Deze vergaderruimte is in deze periode al geboekt." 
      });
    }

    // Insert nieuwe reservering
    const insertPayload = {
      room_id: roomIdNum,
      org_id: orgIdNum,
      source_org_id: Number(sourceOrgId), // Echte org van de user (voor weergave)
      user_id: userId,  // Koppel aan user als ingelogd, anders null
      title: title || null,
      organizer: organizer,
      start_time: start.toISOString(),
      end_time: end.toISOString(),
    };

    const { data, error } = await supabase
      .from("meeting_bookings")
      .insert([insertPayload])
      .select()
      .single();

    if (error) {
      console.error("Supabase fout INSERT /api/meeting-bookings:", error);
      return res.status(500).json({ error: "Kon vergaderreservering niet opslaan." });
    }

    // camelCase response
    return res.status(201).json({
      id: data.id,
      roomId: data.room_id,
      orgId: data.org_id,
      title: data.title,
      organizer: data.organizer,
      startTime: data.start_time,
      endTime: data.end_time,
    });
  } catch (err) {
    console.error("Serverfout POST /api/meeting-bookings:", err);
    res.status(500).json({ error: "Interne serverfout." });
  }
});

// DELETE vergaderreservering (met ownership check)
app.delete("/api/meeting-bookings/:id", async (req, res) => {
  const id = Number(req.params.id);
  const tokenUser = getUserFromToken(req);

  try {
    // Eerst de booking ophalen om ownership te checken
    const { data: booking, error: fetchError } = await supabase
      .from("meeting_bookings")
      .select("id, user_id, org_id")
      .eq("id", id)
      .single();

    if (fetchError || !booking) {
      return res.status(404).json({ error: "Vergaderreservering niet gevonden" });
    }

    // Ownership check (alleen als er een token is)
    if (tokenUser) {
      const isOwner = booking.user_id === tokenUser.userId;
      const isAdmin = tokenUser.role === "admin";
      const isLegacy = booking.user_id === null;

      // Legacy reserveringen (zonder user_id) kunnen alleen door admins verwijderd worden
      // Eigen reserveringen kunnen altijd verwijderd worden
      // Admins kunnen alles verwijderen
      if (!isOwner && !isAdmin) {
        return res.status(403).json({
          error: "Je kunt alleen je eigen reserveringen verwijderen"
        });
      }
      if (isLegacy && !isAdmin) {
        return res.status(403).json({
          error: "Oude reserveringen kunnen alleen door admins verwijderd worden"
        });
      }
    }
    // Geen token = oude flow (tijdelijk toegestaan voor backwards compatibility)

    const { data, error } = await supabase
      .from("meeting_bookings")
      .delete()
      .eq("id", id)
      .select()
      .single();

    if (error) {
      console.error("Supabase fout DELETE /api/meeting-bookings/:id:", error);
      return res.status(500).json({ error: "Kon vergaderreservering niet verwijderen." });
    }

    res.json({ success: true, deleted: data });
  } catch (err) {
    console.error("Serverfout DELETE /api/meeting-bookings/:id:", err);
    res.status(500).json({ error: "Interne serverfout." });
  }
});

// ---- START SERVER ----
app.listen(PORT, () => {
  console.log(`✅ Poolauto app draait op http://localhost:${PORT}`);
});
