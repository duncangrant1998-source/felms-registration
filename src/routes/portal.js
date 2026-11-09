const express = require("express");
const path = require("path");
const fs = require("fs");
const { pool } = require("../db");
const { requireTeam } = require("../auth");
const { photoUpload, PHOTO_DIR, documentUpload, DOC_DIR } = require("../upload");
const {
  fullName, initials, fmtDate,
  PERMISSIONS, permissionCategories, usernameSlug, generatePassword, hashPassword, verifyPassword
} = require("../utils");

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

router.post("/member-login", async (req, res, next) => {
  try {
    const username = (req.body.username || "").trim().toLowerCase();
    const password = req.body.password || "";
    const { rows } = await pool.query("SELECT * FROM members WHERE LOWER(username) = $1", [username]);
    const member = rows[0];
    const ok = member && (await verifyPassword(password, member.password_hash));
    if (!ok) {
      return res.render("portal/login", { title: "Team Login", error: "That username or password wasn't recognized.", nav: null });
    }
    req.session.teamId = member.team_id;
    req.session.memberId = member.id;
    res.redirect("/portal");
  } catch (err) { next(err); }
});

router.get("/logout", (req, res) => {
  req.session.teamId = null;
  req.session.memberId = null;
  res.redirect("/portal/login");
});

router.use(requireTeam);

// Loads which member (if any) is behind this session, and whether it has admin access.
// Sessions started with the legacy team access code have no memberId and are treated as
// full admin, same as a team admin account, so the team is never locked out.
router.use(async (req, res, next) => {
  try {
    let currentMember = null;
    if (req.session.memberId) {
      const { rows } = await pool.query(
        "SELECT * FROM members WHERE id = $1 AND team_id = $2", [req.session.memberId, req.session.teamId]
      );
      currentMember = rows[0] || null;
      if (!currentMember) req.session.memberId = null;
    }
    res.locals.currentMember = currentMember;
    res.locals.isAdmin = !currentMember || currentMember.is_admin;
    res.locals.can = (key) => res.locals.isAdmin || !!(currentMember && currentMember.permissions && currentMember.permissions[key]);
    next();
  } catch (err) { next(err); }
});

function requirePermission(key) {
  return (req, res, next) => {
    if (res.locals.can(key)) return next();
    res.status(403).render("error", { title: "No access", message: "Your account doesn't have permission to view this page. Ask your team admin for access." });
  };
}

function requireAdmin(req, res, next) {
  if (res.locals.isAdmin) return next();
  res.status(403).render("error", { title: "No access", message: "Only team admins can manage logins and permissions." });
}

async function loadTeam(req) {
  const { rows } = await pool.query("SELECT * FROM teams WHERE id = $1", [req.session.teamId]);
  return rows[0];
}

// Annual credentials are counted per weekend (who's actually attending this one);
// single-event credentials are counted across the whole season, since a team burns
// one single-event credential each time a member attends a different weekend.
async function creditUsage(team, eventId) {
  const { rows: attending } = await pool.query(
    `SELECT members.cred_type FROM members
     JOIN event_roster ON event_roster.member_id = members.id AND event_roster.event_id = $1
     WHERE members.team_id = $2`,
    [eventId, team.id]
  );
  const annualUsed = attending.filter((m) => m.cred_type === "Annual").length;

  const { rows: singleRows } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM event_roster
     JOIN members ON members.id = event_roster.member_id
     WHERE members.team_id = $1 AND members.cred_type = 'Single event'`,
    [team.id]
  );
  const singleUsed = singleRows[0].c;

  const annualOver = team.annual_limit != null && annualUsed > team.annual_limit;
  const singleOver = team.single_limit != null && singleUsed > team.single_limit;
  return {
    annualUsed, singleUsed,
    annualLimit: team.annual_limit, singleLimit: team.single_limit,
    annualOver, singleOver, over: annualOver || singleOver
  };
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
router.get("/", requirePermission("weekend_view"), async (req, res, next) => {
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
    const usage = await creditUsage(team, eventId);
    res.render("portal/dashboard", {
      title: "Weekend Roster", nav: "portal", active: "roster",
      team, members, attendingIds, usage, fullName, initials, fmtDate,
      flash: req.query.ok || null
    });
  } catch (err) { next(err); }
});

router.post("/roster/toggle", requirePermission("weekend_toggle"), async (req, res, next) => {
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
        `INSERT INTO event_roster_log (event_id, team_id, member_id, member_name, cred_type, action)
         VALUES ($1,$2,$3,$4,$5,'removed')`,
        [eventId, team.id, memberId, fullName(member), member.cred_type]
      );
      return res.redirect("/portal?ok=notattending");
    }
    await pool.query("INSERT INTO event_roster (event_id, member_id) VALUES ($1,$2)", [eventId, memberId]);
    await pool.query(
      `INSERT INTO event_roster_log (event_id, team_id, member_id, member_name, cred_type, action)
       VALUES ($1,$2,$3,$4,$5,'added')`,
      [eventId, team.id, memberId, fullName(member), member.cred_type]
    );
    res.redirect("/portal?ok=attending");
  } catch (err) { next(err); }
});

// ---------- My Roster: the team's full season roster ----------
router.get("/members", requirePermission("roster_view"), async (req, res, next) => {
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

router.get("/members/new", requirePermission("roster_add"), async (req, res, next) => {
  try {
    const team = await loadTeam(req);
    res.render("portal/member-form", { title: "Add Team Member", nav: "portal", active: "members", team, member: null });
  } catch (err) { next(err); }
});

router.post("/members", requirePermission("roster_add"), photoUpload.single("headshot"), async (req, res, next) => {
  try {
    const team = await loadTeam(req);
    const { first_name, last_name, role, email, phone, cred_type, cred_event } = req.body;
    if (!first_name || !last_name) return res.redirect("/portal/members/new");
    const headshot_path = req.file ? `/uploads/photos/${req.file.filename}` : "";

    // The very first member added to an empty roster becomes the team's first admin,
    // since nobody else could have an account yet to grant them one.
    const { rows: countRows } = await pool.query("SELECT COUNT(*)::int AS c FROM members WHERE team_id = $1", [team.id]);
    const isFirstMember = countRows[0].c === 0;

    const base = usernameSlug(first_name, last_name);
    let username = base;
    let suffix = 1;
    while (true) {
      const { rows: existing } = await pool.query("SELECT 1 FROM members WHERE LOWER(username) = $1", [username]);
      if (!existing.length) break;
      suffix += 1;
      username = `${base}${suffix}`;
    }
    const password = generatePassword();
    const password_hash = await hashPassword(password);

    const { rows: inserted } = await pool.query(
      `INSERT INTO members (team_id, first_name, last_name, role, email, phone, cred_type, cred_event, headshot_path, username, password_hash, is_admin)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [team.id, first_name.trim(), last_name.trim(), role || "", email || "", phone || "",
        cred_type || "Annual", cred_event || "", headshot_path, username, password_hash, isFirstMember]
    );
    const member = inserted[0];
    res.render("portal/member-created", {
      title: "Team Member Added", nav: "portal", active: "members",
      team, member, username, password, fullName, reset: false
    });
  } catch (err) { next(err); }
});

router.get("/members/:id/edit", requirePermission("roster_edit"), async (req, res, next) => {
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

router.post("/members/:id/update", requirePermission("roster_edit"), photoUpload.single("headshot"), async (req, res, next) => {
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

router.post("/members/:id/delete", requirePermission("roster_remove"), async (req, res, next) => {
  try {
    const team = await loadTeam(req);
    const { rows } = await pool.query(
      "SELECT * FROM members WHERE id = $1 AND team_id = $2", [req.params.id, team.id]
    );
    const m = rows[0];
    if (!m) return res.redirect("/portal/members");
    if (m.is_admin) {
      const { rows: adminRows } = await pool.query(
        "SELECT COUNT(*)::int AS c FROM members WHERE team_id = $1 AND is_admin = true AND id != $2", [team.id, m.id]
      );
      if (adminRows[0].c === 0) return res.redirect("/portal/members?ok=lastadmin");
    }
    if (m.headshot_path) fs.unlink(path.join(PHOTO_DIR, path.basename(m.headshot_path)), () => {});
    await pool.query("DELETE FROM members WHERE id = $1 AND team_id = $2", [req.params.id, team.id]);
    res.redirect("/portal/members?ok=removed");
  } catch (err) { next(err); }
});

// ---------- Permissions: team admins control what each non-admin member can access ----------
router.get("/members/:id/permissions", requireAdmin, async (req, res, next) => {
  try {
    const team = await loadTeam(req);
    const { rows } = await pool.query("SELECT * FROM members WHERE id = $1 AND team_id = $2", [req.params.id, team.id]);
    const member = rows[0];
    if (!member) return res.status(404).render("error", { title: "Not found", message: "Member not found." });
    res.render("portal/permissions", {
      title: `Permissions — ${fullName(member)}`, nav: "portal", active: "members",
      team, member, categories: permissionCategories(), fullName,
      err: req.query.err || null
    });
  } catch (err) { next(err); }
});

router.post("/members/:id/permissions", requireAdmin, async (req, res, next) => {
  try {
    const team = await loadTeam(req);
    const { rows } = await pool.query("SELECT * FROM members WHERE id = $1 AND team_id = $2", [req.params.id, team.id]);
    const member = rows[0];
    if (!member) return res.status(404).render("error", { title: "Not found", message: "Member not found." });

    const makeAdmin = req.body.is_admin === "1";
    if (member.is_admin && !makeAdmin) {
      const { rows: adminRows } = await pool.query(
        "SELECT COUNT(*)::int AS c FROM members WHERE team_id = $1 AND is_admin = true AND id != $2", [team.id, member.id]
      );
      if (adminRows[0].c === 0) return res.redirect(`/portal/members/${member.id}/permissions?err=lastadmin`);
    }

    const permissions = {};
    for (const p of PERMISSIONS) permissions[p.key] = req.body[`perm_${p.key}`] === "1";

    await pool.query(
      "UPDATE members SET is_admin = $1, permissions = $2, updated_at = now() WHERE id = $3",
      [makeAdmin, JSON.stringify(permissions), member.id]
    );
    res.redirect("/portal/members?ok=permissions");
  } catch (err) { next(err); }
});

router.post("/members/:id/reset-password", requireAdmin, async (req, res, next) => {
  try {
    const team = await loadTeam(req);
    const { rows } = await pool.query("SELECT * FROM members WHERE id = $1 AND team_id = $2", [req.params.id, team.id]);
    const member = rows[0];
    if (!member) return res.status(404).render("error", { title: "Not found", message: "Member not found." });
    const password = generatePassword();
    const password_hash = await hashPassword(password);
    await pool.query("UPDATE members SET password_hash = $1, updated_at = now() WHERE id = $2", [password_hash, member.id]);
    res.render("portal/member-created", {
      title: "Login Reset", nav: "portal", active: "members",
      team, member, username: member.username, password, fullName, reset: true
    });
  } catch (err) { next(err); }
});

// ---------- My Account: a member's own contact info, filled in after an admin creates them ----------
router.get("/account", async (req, res, next) => {
  try {
    if (!res.locals.currentMember) return res.status(404).render("error", { title: "Not found", message: "There's no personal account for this login." });
    const team = await loadTeam(req);
    res.render("portal/account", {
      title: "My Account", nav: "portal", active: "account",
      team, member: res.locals.currentMember, flash: req.query.ok || null
    });
  } catch (err) { next(err); }
});

router.post("/account", photoUpload.single("headshot"), async (req, res, next) => {
  try {
    if (!res.locals.currentMember) return res.redirect("/portal");
    const member = res.locals.currentMember;
    const { first_name, last_name, role, email, phone } = req.body;
    let headshot_path = member.headshot_path;
    if (req.file) {
      if (member.headshot_path) fs.unlink(path.join(PHOTO_DIR, path.basename(member.headshot_path)), () => {});
      headshot_path = `/uploads/photos/${req.file.filename}`;
    }
    await pool.query(
      `UPDATE members SET first_name=$1, last_name=$2, role=$3, email=$4, phone=$5, headshot_path=$6, updated_at=now() WHERE id=$7`,
      [first_name.trim(), last_name.trim(), role || "", email || "", phone || "", headshot_path, member.id]
    );
    res.redirect("/portal/account?ok=updated");
  } catch (err) { next(err); }
});

// ---------- Documents: series-wide (read-only) + team documents (team admins manage) ----------
router.get("/documents", requirePermission("documents_view"), async (req, res, next) => {
  try {
    const team = await loadTeam(req);
    const { rows: documents } = await pool.query("SELECT * FROM documents ORDER BY category ASC, title ASC");
    const { rows: teamDocuments } = await pool.query(
      "SELECT * FROM team_documents WHERE team_id = $1 ORDER BY uploaded_at DESC", [team.id]
    );
    res.render("portal/documents", {
      title: "Documents", nav: "portal", active: "documents",
      team, documents, teamDocuments, fmtDate, flash: req.query.ok || null
    });
  } catch (err) { next(err); }
});

router.post("/documents/team", requireAdmin, documentUpload.single("file"), async (req, res, next) => {
  try {
    const team = await loadTeam(req);
    if (!req.file) return res.redirect("/portal/documents");
    const { title } = req.body;
    await pool.query(
      `INSERT INTO team_documents (team_id, title, original_name, storage_path) VALUES ($1,$2,$3,$4)`,
      [team.id, title || req.file.originalname, req.file.originalname, `/uploads/documents/${req.file.filename}`]
    );
    res.redirect("/portal/documents?ok=docadded");
  } catch (err) { next(err); }
});

router.post("/documents/team/:id/delete", requireAdmin, async (req, res, next) => {
  try {
    const team = await loadTeam(req);
    const { rows } = await pool.query(
      "SELECT * FROM team_documents WHERE id = $1 AND team_id = $2", [req.params.id, team.id]
    );
    const doc = rows[0];
    if (doc) {
      fs.unlink(path.join(DOC_DIR, path.basename(doc.storage_path)), () => {});
      await pool.query("DELETE FROM team_documents WHERE id = $1", [doc.id]);
    }
    res.redirect("/portal/documents?ok=docremoved");
  } catch (err) { next(err); }
});

// ---------- Credentials / allowance / purchase requests ----------
router.get("/credentials", requirePermission("credentials_view"), async (req, res, next) => {
  try {
    const team = await loadTeam(req);
    const eventId = res.locals.currentEvent ? res.locals.currentEvent.id : null;
    const usage = await creditUsage(team, eventId);
    const { rows: requests } = await pool.query(
      "SELECT * FROM credential_requests WHERE team_id = $1 ORDER BY created_at DESC", [team.id]
    );
    res.render("portal/credentials", {
      title: "Credentials", nav: "portal", active: "credentials",
      team, usage, requests, flash: req.query.ok || null
    });
  } catch (err) { next(err); }
});

router.post("/credentials/request", requirePermission("credentials_request"), async (req, res, next) => {
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
