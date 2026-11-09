const express = require("express");
const { pool } = require("../db");
const { requireStaff } = require("../auth");
const { photoUpload, documentUpload, PHOTO_DIR, DOC_DIR } = require("../upload");
const { generateAccessCode, fullName, initials, fmtDate, fmtStamp, usageFromCounts } = require("../utils");
const path = require("path");
const fs = require("fs");

const router = express.Router();

// Annual counts are scoped to the given weekend (who's attending); single-event counts are
// season-wide attendance totals, since a team burns one single-event credential every time a
// member attends a different weekend. Returns a map of team_id -> { annualUsed, singleUsed }.
async function teamAttendanceCounts(eventId) {
  const { rows: annualRows } = await pool.query(
    `SELECT members.team_id, COUNT(*)::int AS c
     FROM members
     JOIN event_roster ON event_roster.member_id = members.id AND event_roster.event_id = $1
     WHERE members.cred_type = 'Annual'
     GROUP BY members.team_id`, [eventId]
  );
  const { rows: singleRows } = await pool.query(
    `SELECT members.team_id, COUNT(*)::int AS c
     FROM members
     JOIN event_roster ON event_roster.member_id = members.id
     WHERE members.cred_type = 'Single event'
     GROUP BY members.team_id`
  );
  const counts = {};
  for (const r of annualRows) (counts[r.team_id] = counts[r.team_id] || {}).annualUsed = r.c;
  for (const r of singleRows) (counts[r.team_id] = counts[r.team_id] || {}).singleUsed = r.c;
  return counts;
}

// ---------- Auth (unauthenticated) ----------
router.get("/login", (req, res) => {
  res.render("staff/login", { title: "Staff Login", error: null, nav: null });
});

router.post("/login", (req, res) => {
  const { password } = req.body;
  if (password && process.env.STAFF_PASSWORD && password === process.env.STAFF_PASSWORD) {
    req.session.staff = true;
    return res.redirect("/staff");
  }
  res.render("staff/login", { title: "Staff Login", error: "Incorrect password.", nav: null });
});

router.get("/logout", (req, res) => {
  req.session.staff = false;
  res.redirect("/staff/login");
});

// Everything below requires a staff session.
router.use(requireStaff);

// Race-weekend context: staff can switch independently of what any team has selected.
router.use(async (req, res, next) => {
  try {
    const { rows: events } = await pool.query("SELECT * FROM events ORDER BY sort_order ASC, id ASC");
    res.locals.events = events;
    res.locals.currentEvent = events.find((e) => e.id === req.session.staffEventId) || events[events.length - 1] || null;
    next();
  } catch (err) { next(err); }
});

router.post("/event", (req, res) => {
  const id = parseInt(req.body.event_id, 10);
  if (id) req.session.staffEventId = id;
  res.redirect(req.get("Referer") || "/staff");
});

// ---------- Dashboard: all teams + members ----------
router.get("/", async (req, res, next) => {
  try {
    const q = (req.query.q || "").trim().toLowerCase();
    const filter = req.query.filter || "";

    const eventId = res.locals.currentEvent ? res.locals.currentEvent.id : null;
    const { rows: teams } = await pool.query("SELECT * FROM teams ORDER BY name ASC");
    const attendanceCounts = await teamAttendanceCounts(eventId);

    const { rows: members } = await pool.query(
      `SELECT members.* FROM members
       JOIN event_roster ON event_roster.member_id = members.id AND event_roster.event_id = $1
       ORDER BY members.last_name ASC, members.first_name ASC`, [eventId]
    );

    // Single-event credential holders surface first within a team, then everyone else alphabetically by last name.
    function byCredThenName(a, b) {
      const aSingle = a.cred_type === "Single event" ? 0 : 1;
      const bSingle = b.cred_type === "Single event" ? 0 : 1;
      if (aSingle !== bSingle) return aSingle - bSingle;
      return a.last_name.localeCompare(b.last_name) || a.first_name.localeCompare(b.first_name);
    }

    const membersByTeam = {};
    for (const m of members) {
      (membersByTeam[m.team_id] = membersByTeam[m.team_id] || []).push(m);
    }
    for (const teamId of Object.keys(membersByTeam)) {
      membersByTeam[teamId].sort(byCredThenName);
    }

    function matchesSearch(m, team) {
      if (!q) return true;
      const hay = `${fullName(m)} ${m.role} ${team.name}`.toLowerCase();
      return hay.includes(q);
    }
    function matchesFilter(m) {
      if (filter === "nocred") return !m.cred_done;
      if (filter === "nowaiver") return !m.waiver_done;
      if (filter === "noregs") return !m.regs_done;
      if (filter === "nocard") return !m.card_printed;
      return true;
    }

    // Teams group first, then partners, then sponsors.
    const GROUP_TYPE_ORDER = { Team: 0, Partner: 1, Sponsor: 2 };
    const groups = teams.map((team) => {
      const all = membersByTeam[team.id] || [];
      const c = attendanceCounts[team.id] || {};
      const usage = usageFromCounts(team, c.annualUsed || 0, c.singleUsed || 0);
      const visible = all.filter((m) => matchesSearch(m, team) && matchesFilter(m));
      return { team, all, visible, usage };
    }).filter((g) => g.visible.length > 0 || (!q && !filter))
      .sort((a, b) => {
        const order = (GROUP_TYPE_ORDER[a.team.group_type] ?? 99) - (GROUP_TYPE_ORDER[b.team.group_type] ?? 99);
        return order !== 0 ? order : a.team.name.localeCompare(b.team.name);
      });

    const allMembers = members;
    const totals = {
      total: allMembers.length,
      cred: allMembers.filter((m) => m.cred_done).length,
      waiver: allMembers.filter((m) => m.waiver_done).length,
      regs: allMembers.filter((m) => m.regs_done).length,
      overTeams: groups.filter((g) => g.usage.over).length
    };

    res.render("staff/dashboard", {
      title: "Roster",
      nav: "staff",
      active: "dashboard",
      groups, totals, q: req.query.q || "", filter,
      fullName, initials, fmtDate, fmtStamp
    });
  } catch (err) { next(err); }
});

// ---------- Member detail / edit ----------
router.get("/members/:id", async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT * FROM members WHERE id = $1", [req.params.id]);
    const member = rows[0];
    if (!member) return res.status(404).render("error", { title: "Not found", message: "Member not found." });
    const { rows: teamRows } = await pool.query("SELECT * FROM teams WHERE id = $1", [member.team_id]);
    const team = teamRows[0];
    res.render("staff/member", {
      title: fullName(member),
      nav: "staff",
      active: "dashboard",
      member, team, fullName, initials, fmtDate, fmtStamp
    });
  } catch (err) { next(err); }
});

router.post("/members/:id/update", photoUpload.single("headshot"), async (req, res, next) => {
  try {
    const { first_name, last_name, role, email, phone, cred_type, cred_event,
      emg_name, emg_relation, emg_phone, notes } = req.body;
    const { rows } = await pool.query("SELECT * FROM members WHERE id = $1", [req.params.id]);
    const existing = rows[0];
    if (!existing) return res.status(404).render("error", { title: "Not found", message: "Member not found." });

    let headshot_path = existing.headshot_path;
    if (req.file) {
      if (existing.headshot_path) {
        fs.unlink(path.join(PHOTO_DIR, path.basename(existing.headshot_path)), () => {});
      }
      headshot_path = `/uploads/photos/${req.file.filename}`;
    }

    await pool.query(
      `UPDATE members SET first_name=$1, last_name=$2, role=$3, email=$4, phone=$5,
       cred_type=$6, cred_event=$7, emg_name=$8, emg_relation=$9, emg_phone=$10,
       notes=$11, headshot_path=$12, updated_at=now() WHERE id=$13`,
      [first_name, last_name, role, email, phone, cred_type, cred_event,
        emg_name, emg_relation, emg_phone, notes, headshot_path, req.params.id]
    );
    res.redirect(`/staff/members/${req.params.id}`);
  } catch (err) { next(err); }
});

router.post("/members/:id/toggle/:field", async (req, res, next) => {
  try {
    const field = req.params.field;
    if (!["cred", "waiver", "regs"].includes(field)) return res.status(400).send("Bad field");
    const { rows } = await pool.query("SELECT * FROM members WHERE id = $1", [req.params.id]);
    const m = rows[0];
    if (!m) return res.status(404).render("error", { title: "Not found", message: "Member not found." });
    const next_ = !m[`${field}_done`];
    await pool.query(
      `UPDATE members SET ${field}_done=$1, ${field}_at=$2, updated_at=now() WHERE id=$3`,
      [next_, next_ ? new Date() : null, req.params.id]
    );
    res.redirect(req.get("Referer") || `/staff/members/${req.params.id}`);
  } catch (err) { next(err); }
});

router.post("/members/:id/delete", async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT * FROM members WHERE id = $1", [req.params.id]);
    const m = rows[0];
    if (m && m.headshot_path) fs.unlink(path.join(PHOTO_DIR, path.basename(m.headshot_path)), () => {});
    await pool.query("DELETE FROM members WHERE id = $1", [req.params.id]);
    res.redirect("/staff");
  } catch (err) { next(err); }
});

// ---------- Teams & allowances ----------
router.get("/teams", async (req, res, next) => {
  try {
    const { rows: teams } = await pool.query("SELECT * FROM teams ORDER BY name ASC");
    const eventId = res.locals.currentEvent ? res.locals.currentEvent.id : null;
    const attendanceCounts = await teamAttendanceCounts(eventId);
    const rows = teams.map((team) => {
      const c = attendanceCounts[team.id] || {};
      return { team, usage: usageFromCounts(team, c.annualUsed || 0, c.singleUsed || 0) };
    });
    res.render("staff/teams", { title: "Teams & Allowances", nav: "staff", active: "teams", rows });
  } catch (err) { next(err); }
});

router.post("/teams", async (req, res, next) => {
  try {
    const { name, group_type, annual_limit, single_limit } = req.body;
    if (!name || !name.trim()) return res.redirect("/staff/teams");
    const code = generateAccessCode();
    await pool.query(
      `INSERT INTO teams (name, access_code, group_type, annual_limit, single_limit)
       VALUES ($1,$2,$3,$4,$5)`,
      [name.trim(), code, group_type || "Team",
        annual_limit ? parseInt(annual_limit, 10) : null,
        single_limit ? parseInt(single_limit, 10) : null]
    );
    res.redirect("/staff/teams");
  } catch (err) { next(err); }
});

router.post("/teams/:id/update", async (req, res, next) => {
  try {
    const { name, group_type, annual_limit, single_limit } = req.body;
    await pool.query(
      `UPDATE teams SET name=$1, group_type=$2, annual_limit=$3, single_limit=$4 WHERE id=$5`,
      [name.trim(), group_type || "Team",
        annual_limit ? parseInt(annual_limit, 10) : null,
        single_limit ? parseInt(single_limit, 10) : null,
        req.params.id]
    );
    res.redirect("/staff/teams");
  } catch (err) { next(err); }
});

router.post("/teams/:id/regen-code", async (req, res, next) => {
  try {
    const code = generateAccessCode();
    await pool.query("UPDATE teams SET access_code=$1 WHERE id=$2", [code, req.params.id]);
    res.redirect("/staff/teams");
  } catch (err) { next(err); }
});

router.post("/teams/:id/delete", async (req, res, next) => {
  try {
    await pool.query("DELETE FROM teams WHERE id = $1", [req.params.id]);
    res.redirect("/staff/teams");
  } catch (err) { next(err); }
});

// ---------- Team roster detail: full roster, weekend attendance, and the change log ----------
router.get("/teams/:id/roster", async (req, res, next) => {
  try {
    const { rows: teamRows } = await pool.query("SELECT * FROM teams WHERE id = $1", [req.params.id]);
    const team = teamRows[0];
    if (!team) return res.status(404).render("error", { title: "Not found", message: "Team not found." });

    const { rows: members } = await pool.query(
      "SELECT * FROM members WHERE team_id = $1 ORDER BY last_name ASC, first_name ASC", [team.id]
    );

    const { rows: rosterRows } = await pool.query(
      `SELECT event_roster.event_id, event_roster.member_id FROM event_roster
       JOIN members ON members.id = event_roster.member_id WHERE members.team_id = $1`, [team.id]
    );
    const attendingByEvent = {};
    for (const r of rosterRows) {
      (attendingByEvent[r.event_id] = attendingByEvent[r.event_id] || new Set()).add(r.member_id);
    }

    // Per-weekend annual usage, plus a season-wide single-event total (matches the team portal's own math).
    const weekendBreakdown = res.locals.events.map((e) => {
      const ids = attendingByEvent[e.id] || new Set();
      const annualCount = members.filter((m) => ids.has(m.id) && m.cred_type === "Annual").length;
      const singleCount = members.filter((m) => ids.has(m.id) && m.cred_type === "Single event").length;
      const annualOver = team.annual_limit != null && annualCount > team.annual_limit;
      return { event: e, annualCount, singleCount, annualOver };
    });
    const singleSeasonTotal = weekendBreakdown.reduce((sum, w) => sum + w.singleCount, 0);
    const singleSeasonOver = team.single_limit != null && singleSeasonTotal > team.single_limit;

    const eventId = res.locals.currentEvent ? res.locals.currentEvent.id : null;
    const { rows: log } = await pool.query(
      `SELECT event_roster_log.*, events.round_label, events.title AS event_title
       FROM event_roster_log JOIN events ON events.id = event_roster_log.event_id
       WHERE event_roster_log.team_id = $1 AND event_roster_log.event_id = $2
       ORDER BY event_roster_log.changed_at DESC LIMIT 200`, [team.id, eventId]
    );

    res.render("staff/team-roster", {
      title: team.name, nav: "staff", active: "teams",
      team, members, attendingByEvent, weekendBreakdown, singleSeasonTotal, singleSeasonOver,
      log, fullName, initials, fmtStamp
    });
  } catch (err) { next(err); }
});

// ---------- Hard cards ----------
router.get("/cards", async (req, res, next) => {
  try {
    const teamId = req.query.team || "";
    const onlyUnprinted = req.query.unprinted === "1";
    const eventId = res.locals.currentEvent ? res.locals.currentEvent.id : null;
    let sql = `SELECT members.*, teams.name AS team_name, teams.group_type AS team_group_type
               FROM members
               JOIN teams ON teams.id = members.team_id
               JOIN event_roster ON event_roster.member_id = members.id AND event_roster.event_id = $1
               WHERE 1=1`;
    const params = [eventId];
    if (teamId) { params.push(teamId); sql += ` AND members.team_id = $${params.length}`; }
    if (onlyUnprinted) sql += ` AND members.card_printed = false`;
    sql += ` ORDER BY teams.name ASC, members.last_name ASC`;
    const { rows: cards } = await pool.query(sql, params);
    const { rows: teams } = await pool.query("SELECT * FROM teams ORDER BY name ASC");
    res.render("staff/cards", {
      title: "Hard Cards", nav: "staff", active: "cards",
      cards, teams, teamId, onlyUnprinted, fullName, initials
    });
  } catch (err) { next(err); }
});

router.post("/cards/mark-printed", async (req, res, next) => {
  try {
    let ids = req.body.ids || [];
    if (!Array.isArray(ids)) ids = [ids];
    if (ids.length) {
      await pool.query("UPDATE members SET card_printed = true WHERE id = ANY($1::int[])", [ids.map(Number)]);
    }
    res.redirect(req.get("Referer") || "/staff/cards");
  } catch (err) { next(err); }
});

// ---------- Documents ----------
router.get("/documents", async (req, res, next) => {
  try {
    const { rows: documents } = await pool.query("SELECT * FROM documents ORDER BY category ASC, title ASC");
    res.render("staff/documents", { title: "Documents", nav: "staff", active: "documents", documents, fmtDate });
  } catch (err) { next(err); }
});

router.post("/documents", documentUpload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) return res.redirect("/staff/documents");
    const { title, category } = req.body;
    await pool.query(
      `INSERT INTO documents (title, category, original_name, storage_path) VALUES ($1,$2,$3,$4)`,
      [title || req.file.originalname, category || "Other", req.file.originalname, `/uploads/documents/${req.file.filename}`]
    );
    res.redirect("/staff/documents");
  } catch (err) { next(err); }
});

router.post("/documents/:id/delete", async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT * FROM documents WHERE id = $1", [req.params.id]);
    const doc = rows[0];
    if (doc) fs.unlink(path.join(DOC_DIR, path.basename(doc.storage_path)), () => {});
    await pool.query("DELETE FROM documents WHERE id = $1", [req.params.id]);
    res.redirect("/staff/documents");
  } catch (err) { next(err); }
});

// ---------- Credential requests (additional credential purchases) ----------
router.get("/credential-requests", async (req, res, next) => {
  try {
    const { rows: requests } = await pool.query(
      `SELECT credential_requests.*, teams.name AS team_name
       FROM credential_requests JOIN teams ON teams.id = credential_requests.team_id
       ORDER BY (credential_requests.status = 'pending') DESC, credential_requests.created_at DESC`
    );
    res.render("staff/requests", { title: "Credential Requests", nav: "staff", active: "requests", requests, fmtStamp });
  } catch (err) { next(err); }
});

router.post("/credential-requests/:id/status", async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!["pending", "approved", "fulfilled", "cancelled"].includes(status)) return res.status(400).send("Bad status");
    await pool.query("UPDATE credential_requests SET status=$1, updated_at=now() WHERE id=$2", [status, req.params.id]);
    res.redirect("/staff/credential-requests");
  } catch (err) { next(err); }
});

module.exports = router;
