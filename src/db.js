const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("railway")
    ? { rejectUnauthorized: false }
    : process.env.PGSSLMODE === "require"
      ? { rejectUnauthorized: false }
      : false
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS teams (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  access_code TEXT UNIQUE NOT NULL,
  group_type TEXT NOT NULL DEFAULT 'Team',
  annual_limit INTEGER,
  single_limit INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS members (
  id SERIAL PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  role TEXT DEFAULT '',
  email TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  cred_type TEXT NOT NULL DEFAULT 'Annual',
  cred_event TEXT DEFAULT '',
  headshot_path TEXT DEFAULT '',
  emg_name TEXT DEFAULT '',
  emg_relation TEXT DEFAULT '',
  emg_phone TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  cred_done BOOLEAN NOT NULL DEFAULT false,
  cred_at TIMESTAMPTZ,
  waiver_done BOOLEAN NOT NULL DEFAULT false,
  waiver_at TIMESTAMPTZ,
  regs_done BOOLEAN NOT NULL DEFAULT false,
  regs_at TIMESTAMPTZ,
  card_printed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Other',
  original_name TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credential_requests (
  id SERIAL PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  cred_type TEXT NOT NULL DEFAULT 'Annual',
  quantity INTEGER NOT NULL DEFAULT 1,
  note TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  round_label TEXT NOT NULL,
  title TEXT NOT NULL,
  date_label TEXT DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0
);
`;

const EVENT_SEED = [
  ["R1", "Castrol Victoria Day Speedfest", "May 15-17", 1],
  ["R2", "Calabogie NASCAR Weekend", "Jul 17-19", 2],
  ["R3", "Grand Prix de Trois-Rivières", "Aug 7-9", 3],
  ["R4", "Markham", "Aug 15-16", 4],
  ["R5", "Labour Day Weekend Sprints", "Sep 4-6", 5]
];

async function initSchema() {
  await pool.query(SCHEMA);
  const { rows } = await pool.query("SELECT COUNT(*)::int AS c FROM events");
  if (rows[0].c === 0) {
    for (const [round_label, title, date_label, sort_order] of EVENT_SEED) {
      await pool.query(
        "INSERT INTO events (round_label, title, date_label, sort_order) VALUES ($1,$2,$3,$4)",
        [round_label, title, date_label, sort_order]
      );
    }
  }
}

module.exports = { pool, initSchema };
