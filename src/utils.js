const crypto = require("crypto");

function generateAccessCode() {
  // Short, easy to read aloud/type: e.g. "FEL-7K2Q9R"
  const bytes = crypto.randomBytes(5).toString("hex").toUpperCase();
  return `FEL-${bytes.slice(0, 6)}`;
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

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

module.exports = { generateAccessCode, fullName, initials, fmtDate, fmtStamp, usageFromCounts, escapeHtml };
