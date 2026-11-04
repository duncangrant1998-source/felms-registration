function requireStaff(req, res, next) {
  if (req.session && req.session.staff) return next();
  return res.redirect("/staff/login");
}

function requireTeam(req, res, next) {
  if (req.session && req.session.teamId) return next();
  return res.redirect("/portal/login");
}

module.exports = { requireStaff, requireTeam };
