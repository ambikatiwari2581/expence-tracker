
const express = require("express");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === "production";

if (isProduction && !process.env.SESSION_SECRET) {
  throw new Error("Production mein SESSION_SECRET set karein.");
}

if (isProduction && !process.env.ADMIN_EMAIL) {
  throw new Error("Production mein ADMIN_EMAIL set karein.");
}

if (isProduction && (!process.env.ADMIN_PASSWORD ||
    process.env.ADMIN_PASSWORD.length < 12)) {
  throw new Error("ADMIN_PASSWORD kam se kam 12 characters ka rakhein.");
}

app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "20kb" }));

const db = new Database("expense.db");
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user'
      CHECK(role IN ('user', 'admin')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    description TEXT NOT NULL,
    amount REAL NOT NULL CHECK(amount > 0),
    type TEXT NOT NULL CHECK(type IN ('income', 'expense')),
    category TEXT NOT NULL,
    date TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS entries_user_date
  ON entries(user_id, date);
`);

const categories = [
  "Food", "Travel", "Shopping", "Bills",
  "Education", "Salary", "Health", "Other"
];

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validDate(value) {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const d = new Date(value + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) &&
    d.toISOString().slice(0, 10) === value;
}

function cleanEntry(body) {
  const description = typeof body.description === "string"
    ? body.description.trim() : "";
  const amount = Number(body.amount);
  const type = body.type;
  const category = body.category;
  const date = body.date;

  if (!description || description.length > 100) {
    return { error: "Description 1 se 100 characters ka hona chahiye." };
  }

  if (!Number.isFinite(amount) || amount <= 0 ||
      amount > 100000000) {
    return { error: "Amount sahi enter karein." };
  }

  if (!["income", "expense"].includes(type)) {
    return { error: "Type sahi select karein." };
  }

  if (!categories.includes(category)) {
    return { error: "Category sahi select karein." };
  }

  if (!validDate(date)) {
    return { error: "Date sahi enter karein." };
  }

  return {
    value: {
      description,
      amount: Math.round(amount * 100) / 100,
      type,
      category,
      date
    }
  };
}

// Admin account: pehli baar environment variables se banega.
if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
  const email = process.env.ADMIN_EMAIL.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;

  if (!emailPattern.test(email) || password.length < 12) {
    throw new Error("Admin email ya password valid nahi hai.");
  }

  const existing = db.prepare(
    "SELECT id FROM users WHERE email = ?"
  ).get(email);

  if (!existing) {
    const hash = bcrypt.hashSync(password, 12);
    db.prepare(
      "INSERT INTO users (email, password_hash, role) VALUES (?, ?, 'admin')"
    ).run(email, hash);
    console.log("Admin account created:", email);
  }
}

app.use(session({
  name: "expense.sid",
  secret: process.env.SESSION_SECRET || "local-development-secret-change-this",
  store: new SQLiteStore({
    db: "sessions.sqlite",
    dir: "."
  }),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction,
    maxAge: 1000 * 60 * 60 * 8
  }
}));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false
});

app.use("/api/login", authLimiter);
app.use("/api/signup", authLimiter);

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Pehle login karein." });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (req.session.role !== "admin") {
    return res.status(403).json({ error: "Admin access zaroori hai." });
  }
  next();
}

function startSession(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate(err => {
      if (err) return reject(err);
      req.session.userId = user.id;
      req.session.role = user.role;
      req.session.save(err2 => {
        if (err2) return reject(err2);
        resolve();
      });
    });
  });
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    role: user.role
  };
}

app.post("/api/signup", async (req, res, next) => {
  try {
    const email = typeof req.body.email === "string"
      ? req.body.email.trim().toLowerCase() : "";
    const password = req.body.password;

    if (!emailPattern.test(email) || email.length > 254) {
      return res.status(400).json({ error: "Valid email enter karein." });
    }

    if (typeof password !== "string" ||
        password.length < 8 || password.length > 72) {
      return res.status(400).json({
        error: "Password 8 se 72 characters ka hona chahiye."
      });
    }

    const hash = await bcrypt.hash(password, 12);

    let result;
    try {
      result = db.prepare(
        "INSERT INTO users (email, password_hash) VALUES (?, ?)"
      ).run(email, hash);
    } catch (err) {
      if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
        return res.status(409).json({
          error: "Is email ka account pehle se hai."
        });
      }
      throw err;
    }

    const user = {
      id: Number(result.lastInsertRowid),
      email,
      role: "user"
    };

    await startSession(req, user);
    res.status(201).json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

app.post("/api/login", async (req, res, next) => {
  try {
    const email = typeof req.body.email === "string"
      ? req.body.email.trim().toLowerCase() : "";
    const password = req.body.password;

    const user = db.prepare(
      "SELECT * FROM users WHERE email = ?"
    ).get(email);

    const valid = user && typeof password === "string" &&
      await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return res.status(401).json({
        error: "Email ya password galat hai."
      });
    }

    await startSession(req, user);
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

app.get("/api/me", requireAuth, (req, res) => {
  const user = db.prepare(
    "SELECT id, email, role FROM users WHERE id = ?"
  ).get(req.session.userId);

  if (!user) {
    return res.status(401).json({ error: "Account nahi mila." });
  }

  res.json({ user });
});

app.post("/api/logout", requireAuth, (req, res, next) => {
  req.session.destroy(err => {
    if (err) return next(err);
    res.clearCookie("expense.sid", {
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction
    });
    res.json({ message: "Logout ho gaya." });
  });
});

app.get("/api/entries", requireAuth, (req, res) => {
  const entries = db.prepare(`
    SELECT id, description, amount, type, category, date
    FROM entries
    WHERE user_id = ?
    ORDER BY date DESC, id DESC
  `).all(req.session.userId);

  res.json({ entries });
});

app.post("/api/entries", requireAuth, (req, res) => {
  const cleaned = cleanEntry(req.body);
  if (cleaned.error) {
    return res.status(400).json({ error: cleaned.error });
  }

  const e = cleaned.value;
  const result = db.prepare(`
    INSERT INTO entries
      (user_id, description, amount, type, category, date)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    req.session.userId, e.description, e.amount,
    e.type, e.category, e.date
  );

  res.status(201).json({
    entry: { id: Number(result.lastInsertRowid), ...e }
  });
});

app.put("/api/entries/:id", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Entry ID galat hai." });
  }

  const cleaned = cleanEntry(req.body);
  if (cleaned.error) {
    return res.status(400).json({ error: cleaned.error });
  }

  const e = cleaned.value;
  const result = db.prepare(`
    UPDATE entries
    SET description = ?, amount = ?, type = ?, category = ?, date = ?
    WHERE id = ? AND user_id = ?
  `).run(
    e.description, e.amount, e.type, e.category, e.date,
    id, req.session.userId
  );

  if (!result.changes) {
    return res.status(404).json({ error: "Entry nahi mili." });
  }

  res.json({ entry: { id, ...e } });
});

app.delete("/api/entries/:id", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Entry ID galat hai." });
  }

  const result = db.prepare(
    "DELETE FROM entries WHERE id = ? AND user_id = ?"
  ).run(id, req.session.userId);

  if (!result.changes) {
    return res.status(404).json({ error: "Entry nahi mili." });
  }

  res.json({ message: "Entry delete ho gayi." });
});

app.get("/api/reports", requireAuth, (req, res) => {
  const month = req.query.month;

  if (typeof month !== "string" ||
      !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return res.status(400).json({
      error: "Month YYYY-MM format mein dein."
    });
  }

  const userId = req.session.userId;
  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0)
        AS income,
      COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0)
        AS expense
    FROM entries
    WHERE user_id = ? AND substr(date, 1, 7) = ?
  `).get(userId, month);

  const byCategory = db.prepare(`
    SELECT category, SUM(amount) AS total
    FROM entries
    WHERE user_id = ? AND type = 'expense'
      AND substr(date, 1, 7) = ?
    GROUP BY category
    ORDER BY total DESC
  `).all(userId, month);

  res.json({
    month,
    income: totals.income,
    expense: totals.expense,
    balance: Math.round((totals.income - totals.expense) * 100) / 100,
    byCategory
  });
});

app.get("/api/admin/stats", requireAuth, requireAdmin, (req, res) => {
  const users = db.prepare(
    "SELECT COUNT(*) AS count FROM users"
  ).get().count;

  const entries = db.prepare(
    "SELECT COUNT(*) AS count FROM entries"
  ).get().count;

  const expenses = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM entries WHERE type = 'expense'
  `).get().total;

  res.json({ users, entries, expenses });
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Server mein problem hui." });
});

app.listen(PORT, () => {
  console.log(`Website: http://localhost:${PORT}`);
});
