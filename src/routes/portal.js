const express = require("express");
const path = require("path");
const fs = require("fs");
const { pool } = require("../db");
const { requireTeam } = require("../auth");
const { photoUpload, PHOTO_DIR } = require("../upload");
const { fullName, initials, fmtDate, teamUsage } = require("../utils");

const router = express.Router();

// ---------- Auth (unauthenticated) ----------
router.get("/login", (req, res) => {
  res.render("portal/login", { title: "Team Login", error: null, nav: null });
});

router.post("/login", async (req, res, next) => {
  try {
    const code = (req.body.access_code || "").trim();
    const { rows } = await pool.query("SELECT * FROM teams WHERE UPPER(access_code) = UPPER($1)", [code]);
    const team = rows[0];
    if (!team) {
      return res.render("portal/login", { title: "Team Login", error: "That access code wasn't recognized — check with FEL Motorsports staff.", nav: null });
    }
    req.session.teamId = team.id;
    res.redirect("/portal");
  } catch (err) { next(err); }
});

router.get("/logout", (req, res) => {
  req.session.teamId = null;
  res.redirect("/portal/login");
});

router.use(requireTeam);

async function loadTeam(req) {
  const { rows } = await pool.query("SELECT * FROM teams WHERE id = $1", [req.session.teamId]);
  return rows[0];
}

// Race-weekend context: which event this team is currently confirming registration for.
router.use(async (req, res, next) => {
  try {
    const { rows: events } = await pool.query("SELECT * FROM events ORDER BY sort_order ASC, id ASC");
    res.locals.events = events;
    res.locals.currentEvent = events.find((e) => e.id === req.session.eventId) || events[events.length - 1] || null;
    next();
  } catch (err) { next(err); }
});

router.post("/event", (req, res) => {
  const id = parseInt(req.body.event_id, 10);
  if (id) req.session.eventId = id;
  res.redirect(req.get("Referer") || "/portal");
});

// ---------- Weekend roster: who's attending the currently-selected event ----------
router.get("/", async (req, res, next) => {
  try {
    const team = await loadTeam(req);
    if (!team) { req.session.teamId = null; return res.redirect("/portal/login"); }
    const { rows: members } = await pool.query(
      "SELECT * FROM members WHERE team_id = $1 ORDER BY last_name ASC, first_name ASC", [team.id]
    );
    const eventId = res.locals.currentEvent ? res.locals.currentEvent.id : null;
    let attendingIds = new Set();
    if (eventId) {
      const { rows: roster } = await pool.query(
        "SELECT member_id FROM event_roster WHERE event_id = $1", [eventId]
      );
      attendingIds = new Set(roster.map((r) => r.member_id));
    }
    const usage = teamUsage(team, members);
    res.render("portal/dashboard", {
      title: "Weekend Roster", nav: "portal", active: "roster",
      team, members, attendingIds, usage, fullName, initials, fmtDate,
      flash: req.query.ok || null
    });
  } catch (err) { next(err); }
});

router.post("/roster/toggle", async (req, res, next) => {
  try {
    const team = await loadTeam(req);
    const eventId = res.locals.currentEvent ? res.locals.currentEvent.id : null;
    const memberId = parseInt(req.body.member_id, 10);
    if (!eventId || !memberId) return res.redirect("/portal");
    const { rows: mrows } = await pool.query(
      "SELECT * FROM members WHERE id = $1 AND team_id = $2", [memberId, team.id]
    );
    const member = mrows[0];
    if (!member) return res.redirect("/portal");

    const { rows: existing } = await pool.query(
      "SELECT 1 FROM event_roster WHERE event_id = $1 AND member_id = $2", [eventId, memberId]
    );
    if (existing.length) {
      await pool.query("DELETE FROM event_roster WHERE event_id = $1 AND member_id = $2", [eventId, memberId]);
      await pool.query(
        `INSERT INTO event_roster_log (event_id, team_id, member_id, member_name, action)
         VALUES ($1,$2,$3,$4,'removed')`,
        [eventId, team.id, memberId, fullName(member)]
      );
      return res.redirect("/portal?ok=notattending");
    }
    await pool.query("INSERT INTO event_roster (event_id, member_id) VALUES ($1,$2)", [eventId, memberId]);
    await pool.query(
      `INSERT INTO event_roster_log (event_id, team_id, member_id, member_name, action)
       VALUES ($1,$2,$3,$4,'added')`,
      [eventId, team.id, memberId, fullName(member)]
    );
    res.redirect("/portal?ok=attending");
  } catch (err) { next(err); }
});

// ---------- My Roster: the team's full season roster ----------
router.get("/members", async (req, res, next) => {
  try {
    const team = await loadTeam(req);
    const { rows: members } = await pool.query(
      "SELECT * FROM members WHERE team_id = $1 ORDER BY last_name ASC, first_name ASC", [team.id]
    );
    res.render("portal/members", {
      title: "My Roster", nav: "portal", active: "members",
      team, members, fullName, initials,
      flash: req.query.ok || null
    });
  } catch (err) { next(err); }
});

router.get("/members/new", async (req, res, next) => {
  try {
    const team = await loadTeam(req);
    res.render("portal/member-form", { title: "Add Team Member", nav: "portal", active: "members", team, member: null });
  } catch (err) { next(err); }
});

router.post("/members", photoUpload.single("headshot"), async (req, res, next) => {
  try {
    const team = await loadTeam(req);
    const { first_name, last_name, role, email, phone, cred_type, cred_event } = req.body;
    if (!first_name || !last_name) return res.redirect("/portal/members/new");
    const headshot_path = req.file ? `/uploads/photos/${req.file.filename}` : "";
    await pool.query(
      `INSERT INTO members (team_id, first_name, last_name, role, email, phone, cred_type, cred_event, headshot_path)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [team.id, first_name.trim(), last_name.trim(), role || "", email || "", phone || "",
        cred_type || "Annual", cred_event || "", headshot_path]
    );
    res.redirect("/portal/members?ok=added");
  } catch (err) { next(err); }
});

router.get("/members/:id/edit", async (req, res, next) => {
  try {
    const team = await loadTeam(req);
    const { rows } = await pool.query(
      "SELECT * FROM members WHERE id = $1 AND team_id = $2", [req.params.id, team.id]
    );
    const member = rows[0];
    if (!member) return res.status(404).render("error", { title: "Not found", message: "Member not found." });
    res.render("portal/member-form", { title: `Edit ${fullName(member)}`, nav: "portal", active: "members", team, member });
  } catch (err) { next(err); }
});

router.post("/members/:id/update", photoUpload.single("headshot"), async (req, res, next) => {
  try {
    const team = await loadTeam(req);
    const { rows } = await pool.query(
      "SELECT * FROM members WHERE id = $1 AND team_id = $2", [req.params.id, team.id]
    );
    const existing = rows[0];
    if (!existing) return res.status(404).render("error", { title: "Not found", message: "Member not found." });

    const { first_name, last_name, role, email, phone, cred_type, cred_event } = req.body;
    let headshot_path = existing.headshot_path;
    if (req.file) {
      if (existing.headshot_path) fs.unlink(path.join(PHOTO_DIR, path.basename(existing.headshot_path)), () => {});
      headshot_path = `/uploads/photos/${req.file.filename}`;
    }
    await pool.query(
      `UPDATE members SET first_name=$1, last_name=$2, role=$3, email=$4, phone=$5,
       cred_type=$6, cred_event=$7, headshot_path=$8, updated_at=now() WHERE id=$9 AND team_id=$10`,
      [first_name.trim(), last_name.trim(), role || "", email || "", phone || "",
        cred_type || "Annual", cred_event || "", headshot_path, req.params.id, team.id]
    );
    res.redirect("/portal/members?ok=updated");
  } catch (err) { next(err); }
});

router.post("/members/:id/delete", async (req, res, next) => {
  try {
    const team = await loadTeam(req);
    const { rows } = await pool.query(
      "SELECT * FROM members WHERE id = $1 AND team_id = $2", [req.params.id, team.id]
    );
    const m = rows[0];
    if (m && m.headshot_path) fs.unlink(path.join(PHOTO_DIR, path.basename(m.headshot_path)), () => {});
    await pool.query("DELETE FROM members WHERE id = $1 AND team_id = $2", [req.params.id, team.id]);
    res.redirect("/portal/members?ok=removed");
  } catch (err) { next(err); }
});

// ---------- Documents (read-only) ----------
router.get("/documents", async (req, res, next) => {
  try {
    const { rows: documents } = await pool.query("SELECT * FROM documents ORDER BY category ASC, title ASC");
    res.render("portal/documents", { title: "Documents", nav: "portal", active: "documents", documents, fmtDate });
  } catch (err) { next(err); }
});

// ---------- Credentials / allowance / purchase requests ----------
router.get("/credentials", async (req, res, next) => {
  try {
    const team = await loadTeam(req);
    const { rows: members } = await pool.query("SELECT * FROM members WHERE team_id = $1", [team.id]);
    const usage = teamUsage(team, members);
    const { rows: requests } = await pool.query(
      "SELECT * FROM credential_requests WHERE team_id = $1 ORDER BY created_at DESC", [team.id]
    );
    res.render("portal/credentials", {
      title: "Credentials", nav: "portal", active: "credentials",
      team, usage, requests, flash: req.query.ok || null
    });
  } catch (err) { next(err); }
});

router.post("/credentials/request", async (req, res, next) => {
  try {
    const team = await loadTeam(req);
    const { cred_type, quantity, note } = req.body;
    const qty = Math.max(1, parseInt(quantity, 10) || 1);
    await pool.query(
      `INSERT INTO credential_requests (team_id, cred_type, quantity, note) VALUES ($1,$2,$3,$4)`,
      [team.id, cred_type || "Annual", qty, note || ""]
    );
    res.redirect("/portal/credentials?ok=requested");
  } catch (err) { next(err); }
});

module.exports = router;
