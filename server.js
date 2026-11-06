require("dotenv").config();
const path = require("path");
const express = require("express");
const session = require("express-session");

const { initSchema } = require("./src/db");
const { UPLOAD_DIR } = require("./src/upload");

const staffRoutes = require("./src/routes/staff");
const portalRoutes = require("./src/routes/portal");

const app = express();

app.set("trust proxy", 1);
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "src", "views"));
app.locals.EVENT_NAME = process.env.EVENT_NAME || "FEL Motorsports";

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOAD_DIR));

app.use(session({
  secret: process.env.SESSION_SECRET || "fel-motorsports-dev-secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 12,
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === "1"
  }
}));

app.get("/", (req, res) => {
  if (req.session.staff) return res.redirect("/staff");
  if (req.session.teamId) return res.redirect("/portal");
  res.render("landing", { title: "FEL Motorsports — Registration" });
});

// These pages reflect live, frequently-changing state (weekend rosters, credential
// status) — never let the browser serve a cached copy after a POST redirects back here.
app.use(["/staff", "/portal"], (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

app.use("/staff", staffRoutes);
app.use("/portal", portalRoutes);

app.use((req, res) => {
  res.status(404).render("error", { title: "Not found", message: "That page doesn't exist." });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render("error", { title: "Something went wrong", message: err.message || "Unexpected error." });
});

const PORT = process.env.PORT || 3000;

initSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`FEL registration app listening on :${PORT}`));
  })
  .catch((err) => {
    console.error("Failed to initialize database schema:", err);
    process.exit(1);
  });
