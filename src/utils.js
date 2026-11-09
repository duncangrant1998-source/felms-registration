const crypto = require("crypto");
const { promisify } = require("util");
const scrypt = promisify(crypto.scrypt);

function generateAccessCode() {
  // Short, easy to read aloud/type: e.g. "FEL-7K2Q9R"
  const bytes = crypto.randomBytes(5).toString("hex").toUpperCase();
  return `FEL-${bytes.slice(0, 6)}`;
}

// Togglable team-member permissions, grouped by the portal section they control.
// Admin accounts always have every permission; these only matter for non-admin members.
const PERMISSIONS = [
  { key: "weekend_view", category: "Weekend Roster", label: "View weekend roster" },
  { key: "weekend_toggle", category: "Weekend Roster", label: "Add or remove members from weekend attendance" },
  { key: "roster_view", category: "My Roster", label: "View the full season roster" },
  { key: "roster_add", category: "My Roster", label: "Add new team members" },
  { key: "roster_edit", category: "My Roster", label: "Edit team member details" },
  { key: "roster_remove", category: "My Roster", label: "Remove team members" },
  { key: "documents_view", category: "Documents", label: "View documents" },
  { key: "credentials_view", category: "Credentials", label: "View credential usage & allowance" },
  { key: "credentials_request", category: "Credentials", label: "Request additional credentials" }
];

function permissionCategories() {
  const categories = [];
  for (const p of PERMISSIONS) {
    let cat = categories.find((c) => c.name === p.category);
    if (!cat) { cat = { name: p.category, items: [] }; categories.push(cat); }
    cat.items.push(p);
  }
  return categories;
}

function usernameSlug(first, last) {
  const slug = `${first}.${last}`.toLowerCase().replace(/[^a-z0-9.]+/g, "").replace(/\.{2,}/g, ".").replace(/^\.|\.$/g, "");
  return slug || "member";
}

function generatePassword() {
  // Short, easy to read aloud/type, avoiding ambiguous characters.
  const bytes = crypto.randomBytes(6).toString("hex").toUpperCase();
  return bytes.slice(0, 8);
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, 64);
  return `${salt}:${derived.toString("hex")}`;
}

async function verifyPassword(password, hash) {
  if (!hash) return false;
  const [salt, key] = hash.split(":");
  if (!salt || !key) return false;
  const derived = await scrypt(password, salt, 64);
  const keyBuf = Buffer.from(key, "hex");
  if (keyBuf.length !== derived.length) return false;
  return crypto.timingSafeEqual(keyBuf, derived);
}

function fullName(m) {
  return [m.first_name, m.last_name].filter(Boolean).join(" ").trim();
}

function initials(m) {
  const a = (m.first_name || "").trim()[0] || "";
  const b = (m.last_name || "").trim()[0] || "";
  return (a + b).toUpperCase() || "—";
}

function fmtDate(d) {
  if (!d) return "—";
  const dt = new Date(d);
  return dt.toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric" });
}

function fmtStamp(d) {
  if (!d) return "";
  const dt = new Date(d);
  return dt.toLocaleString("en-CA", {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
  });
}

// Annual credentials are counted per weekend (who's actually attending the currently
// selected weekend); single-event credentials are counted across the whole season, since
// a team burns one single-event credential each time a member attends a different weekend.
// annualUsed/singleUsed here are pre-counted attendance totals, not roster member counts.
function usageFromCounts(team, annualUsed, singleUsed) {
  const annualOver = team.annual_limit != null && annualUsed > team.annual_limit;
  const singleOver = team.single_limit != null && singleUsed > team.single_limit;
  return {
    annualUsed,
    singleUsed,
    annualLimit: team.annual_limit,
    singleLimit: team.single_limit,
    annualOver,
    singleOver,
    over: annualOver || singleOver
  };
}

// A member's own account page fills in email/phone/headshot — the admin who creates the
// roster entry only supplies name and credential type. Staff use this to follow up with
// teams whose members haven't finished setting up their accounts yet.
function accountComplete(m) {
  return !!(m.first_name && m.last_name && m.email && m.phone && m.headshot_path);
}

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

module.exports = {
  generateAccessCode, fullName, initials, fmtDate, fmtStamp, usageFromCounts, escapeHtml,
  PERMISSIONS, permissionCategories, usernameSlug, generatePassword, hashPassword, verifyPassword,
  accountComplete
};
