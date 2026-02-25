// setup-demo.js
// Maakt een volledige demo-omgeving aan in Supabase.
// Gebruik: node setup-demo.js
// Is idempotent: draai meerdere keren zonder dubbele data.

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const bcrypt = require("bcrypt");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

const SALT_ROUNDS = 12;

// ─── DEMO CONFIGURATIE ────────────────────────────────────────────
const DEMO_ORG = {
  name: "Voorbeeldbedrijf BV",
  code: "DEMO",
  allowed_sections: ["cars", "meetings"],
};

const DEMO_USER = {
  name: "Demo Gebruiker",
  email: "demo@poolauto.nl",
  password: "Demo1234",
  role: "admin",
};

const DEMO_CARS = [
  { name: "Volkswagen Polo", license: "TS-001-B", status: "ok" },
  { name: "Toyota Yaris",    license: "TS-002-B", status: "ok" },
];

const DEMO_ROOMS = [
  { name: "Vergaderruimte A", capacity: 8 },
];

// ─── HELPERS ──────────────────────────────────────────────────────

// Geeft een ISO string terug voor dag + tijdstip (lokale tijd als UTC)
function toISO(date, hours, minutes = 0) {
  const d = new Date(date);
  d.setHours(hours, minutes, 0, 0);
  return d.toISOString();
}

// Geeft de maandag van de huidige week terug
function mondayOfCurrentWeek() {
  const now = new Date();
  const day = now.getDay(); // 0=zo, 1=ma, ...
  const diff = (day + 6) % 7;
  const monday = new Date(now);
  monday.setDate(now.getDate() - diff);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

// ─── MAIN ─────────────────────────────────────────────────────────

async function main() {
  console.log("🚀 Demo setup starten...\n");

  // 1. Organisatie
  console.log("1️⃣  Organisatie aanmaken...");
  let orgId;

  const { data: existingOrg } = await supabase
    .from("organizations")
    .select("id")
    .ilike("code", DEMO_ORG.code)
    .maybeSingle();

  if (existingOrg) {
    orgId = existingOrg.id;
    console.log(`   ✅ Org bestaat al (id: ${orgId})`);
  } else {
    const { data: newOrg, error } = await supabase
      .from("organizations")
      .insert([DEMO_ORG])
      .select("id")
      .single();

    if (error) { console.error("   ❌ Org aanmaken mislukt:", error.message); process.exit(1); }
    orgId = newOrg.id;
    console.log(`   ✅ Org aangemaakt (id: ${orgId})`);
  }

  // 2. Gebruiker
  console.log("\n2️⃣  Demo gebruiker aanmaken...");

  const { data: existingUser } = await supabase
    .from("users")
    .select("id")
    .eq("org_id", orgId)
    .eq("email", DEMO_USER.email)
    .maybeSingle();

  let userId;
  if (existingUser) {
    userId = existingUser.id;
    console.log(`   ✅ Gebruiker bestaat al (id: ${userId})`);
  } else {
    const passwordHash = await bcrypt.hash(DEMO_USER.password, SALT_ROUNDS);
    const { data: newUser, error } = await supabase
      .from("users")
      .insert([{
        org_id: orgId,
        email: DEMO_USER.email,
        password_hash: passwordHash,
        name: DEMO_USER.name,
        role: DEMO_USER.role,
      }])
      .select("id")
      .single();

    if (error) { console.error("   ❌ Gebruiker aanmaken mislukt:", error.message); process.exit(1); }
    userId = newUser.id;
    console.log(`   ✅ Gebruiker aangemaakt (id: ${userId})`);
  }

  // 3. Auto's
  console.log("\n3️⃣  Demo auto's aanmaken...");
  const carIds = [];

  for (const car of DEMO_CARS) {
    const { data: existing } = await supabase
      .from("cars")
      .select("id")
      .eq("license", car.license)
      .maybeSingle();

    if (existing) {
      carIds.push(existing.id);
      console.log(`   ✅ Auto bestaat al: ${car.name} (${car.license})`);
    } else {
      const { data: newCar, error } = await supabase
        .from("cars")
        .insert([car])
        .select("id")
        .single();

      if (error) { console.error(`   ❌ Auto aanmaken mislukt (${car.name}):`, error.message); process.exit(1); }
      carIds.push(newCar.id);
      console.log(`   ✅ Auto aangemaakt: ${car.name} (${car.license})`);
    }
  }

  // 4. Vergaderruimte
  console.log("\n4️⃣  Vergaderruimte aanmaken...");
  let roomId;

  const { data: existingRoom } = await supabase
    .from("meeting_rooms")
    .select("id")
    .eq("org_id", orgId)
    .eq("name", DEMO_ROOMS[0].name)
    .maybeSingle();

  if (existingRoom) {
    roomId = existingRoom.id;
    console.log(`   ✅ Ruimte bestaat al (id: ${roomId})`);
  } else {
    const { data: newRoom, error } = await supabase
      .from("meeting_rooms")
      .insert([{ ...DEMO_ROOMS[0], org_id: orgId }])
      .select("id")
      .single();

    if (error && error.code === "23505") {
      // Primary key conflict: ruimte bestaat toch al, zoek het op
      const { data: fallback } = await supabase
        .from("meeting_rooms")
        .select("id")
        .eq("org_id", orgId)
        .limit(1)
        .single();
      roomId = fallback.id;
      console.log(`   ✅ Ruimte gevonden na conflict (id: ${roomId})`);
    } else if (error) {
      console.error("   ❌ Vergaderruimte aanmaken mislukt:", error.message);
      process.exit(1);
    } else {
      roomId = newRoom.id;
      console.log(`   ✅ Vergaderruimte aangemaakt (id: ${roomId})`);
    }
  }

  // 5. Demo reserveringen (auto's)
  console.log("\n5️⃣  Demo auto-reserveringen aanmaken...");

  const monday = mondayOfCurrentWeek();

  const demoBookings = [
    // Maandag: auto 1
    { org_id: orgId, car_id: carIds[0], user_id: userId, user_name: "Lisa van den Berg",
      start: toISO(addDays(monday, 0), 8, 0),  end: toISO(addDays(monday, 0), 12, 30),
      note: "Bezoek cliënt Enschede" },
    // Maandag: auto 2
    { org_id: orgId, car_id: carIds[1], user_id: userId, user_name: "Mark Janssen",
      start: toISO(addDays(monday, 0), 9, 0),  end: toISO(addDays(monday, 0), 17, 0),
      note: "" },
    // Dinsdag: auto 1
    { org_id: orgId, car_id: carIds[0], user_id: userId, user_name: "Sara Pietersen",
      start: toISO(addDays(monday, 1), 13, 0), end: toISO(addDays(monday, 1), 16, 0),
      note: "Afspraak regio Noord" },
    // Woensdag: auto 1
    { org_id: orgId, car_id: carIds[0], user_id: userId, user_name: "Tom de Groot",
      start: toISO(addDays(monday, 2), 8, 30), end: toISO(addDays(monday, 2), 11, 0),
      note: "" },
    // Donderdag: auto 2
    { org_id: orgId, car_id: carIds[1], user_id: userId, user_name: "Lisa van den Berg",
      start: toISO(addDays(monday, 3), 10, 0), end: toISO(addDays(monday, 3), 14, 30),
      note: "Netwerkbijeenkomst Deventer" },
    // Vrijdag: auto 1
    { org_id: orgId, car_id: carIds[0], user_id: userId, user_name: "Demo Gebruiker",
      start: toISO(addDays(monday, 4), 8, 0),  end: toISO(addDays(monday, 4), 17, 0),
      note: "Dagrit" },
  ];

  // Verwijder eventuele oude demo-bookings voor deze org deze week
  const weekStart = toISO(monday, 0);
  const weekEnd   = toISO(addDays(monday, 6), 23, 59);
  await supabase.from("bookings")
    .delete()
    .eq("org_id", orgId)
    .gte("start", weekStart)
    .lte("start", weekEnd);

  const { error: bookErr } = await supabase.from("bookings").insert(demoBookings);
  if (bookErr) { console.error("   ❌ Bookings aanmaken mislukt:", bookErr.message); process.exit(1); }
  console.log(`   ✅ ${demoBookings.length} auto-reserveringen aangemaakt`);

  // 6. Demo vergaderreserveringen
  console.log("\n6️⃣  Demo vergaderreserveringen aanmaken...");

  const demoMeetings = [
    { room_id: roomId, org_id: orgId, source_org_id: orgId, user_id: userId,
      title: "Teamoverleg",         organizer: "Lisa van den Berg",
      start_time: toISO(addDays(monday, 0), 9, 0),  end_time: toISO(addDays(monday, 0), 10, 0) },
    { room_id: roomId, org_id: orgId, source_org_id: orgId, user_id: userId,
      title: "Klantgesprek",        organizer: "Mark Janssen",
      start_time: toISO(addDays(monday, 1), 14, 0), end_time: toISO(addDays(monday, 1), 15, 30) },
    { room_id: roomId, org_id: orgId, source_org_id: orgId, user_id: userId,
      title: "Kwartaalreview",      organizer: "Demo Gebruiker",
      start_time: toISO(addDays(monday, 2), 10, 0), end_time: toISO(addDays(monday, 2), 12, 0) },
    { room_id: roomId, org_id: orgId, source_org_id: orgId, user_id: userId,
      title: "1-op-1 gesprek",      organizer: "Sara Pietersen",
      start_time: toISO(addDays(monday, 3), 9, 30), end_time: toISO(addDays(monday, 3), 10, 0) },
  ];

  await supabase.from("meeting_bookings")
    .delete()
    .eq("org_id", orgId)
    .gte("start_time", weekStart)
    .lte("start_time", weekEnd);

  const { error: meetErr } = await supabase.from("meeting_bookings").insert(demoMeetings);
  if (meetErr) { console.error("   ❌ Vergaderingen aanmaken mislukt:", meetErr.message); process.exit(1); }
  console.log(`   ✅ ${demoMeetings.length} vergaderreserveringen aangemaakt`);

  // ─── SAMENVATTING ─────────────────────────────────────────────
  console.log("\n" + "─".repeat(48));
  console.log("🎉 Demo klaar! Inloggegevens om te mailen:\n");
  console.log(`  App-URL:       https://jouw-app-url.nl`);
  console.log(`  Org code:      ${DEMO_ORG.code}`);
  console.log(`  E-mail:        ${DEMO_USER.email}`);
  console.log(`  Wachtwoord:    ${DEMO_USER.password}`);
  console.log("─".repeat(48) + "\n");
}

main().catch((err) => {
  console.error("Onverwachte fout:", err);
  process.exit(1);
});
