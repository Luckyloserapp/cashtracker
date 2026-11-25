"use strict";
/* CashTracker – „server“ běžící přímo v telefonu.
   Port app.py do JavaScriptu nad SQLite (sql.js). Databáze se ukládá do IndexedDB prohlížeče.
   Frontend (app.js) volá window.LOCAL_API(method, url, body) místo fetch(). */
(function () {
  const IDB_NAME = "cashtracker", IDB_STORE = "files", KEY_MAIN = "main", KEEP_AUTO_BACKUPS = 7;

  const SCHEMA = `
CREATE TABLE IF NOT EXISTS categories (
    id       INTEGER PRIMARY KEY,
    name     TEXT NOT NULL UNIQUE,
    type     TEXT NOT NULL CHECK (type IN ('expense','income','saving')),
    fixed    INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    sort     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS transactions (
    id          INTEGER PRIMARY KEY,
    date        TEXT NOT NULL,
    amount      REAL NOT NULL,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    note        TEXT NOT NULL DEFAULT '',
    source      TEXT NOT NULL DEFAULT 'manual',
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS ix_tx_date ON transactions(date);
CREATE INDEX IF NOT EXISTS ix_tx_cat ON transactions(category_id);
CREATE TABLE IF NOT EXISTS recurring (
    id          INTEGER PRIMARY KEY,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    amount      REAL NOT NULL,
    note        TEXT NOT NULL DEFAULT '',
    active      INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS annual_items (
    id         INTEGER PRIMARY KEY,
    year       INTEGER NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('income','expense')),
    name       TEXT NOT NULL,
    amount     REAL NOT NULL,
    note       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);`;

  const DEFAULT_SETTINGS = { period_start_day: "10", currency: "Kč" };   // výplata 10. v měsíci
  // (název, typ, fixní, výchozí „nutná“, povinná poznámka)
  // Výchozí kategorie telefonní verze (manželka) – liší se od PC verze.
  const DEFAULT_CATEGORIES = [
    ["Plat", "income", 0, 0, 0],
    ["Jídlo", "expense", 0, 1, 0], ["Restaurace", "expense", 0, 0, 0], ["Auto", "expense", 0, 1, 0],
    ["Děti", "expense", 0, 1, 0], ["Drogerie", "expense", 0, 1, 0], ["Móda", "expense", 0, 0, 0],
    ["Investice", "expense", 0, 0, 0], ["Domácnost", "expense", 0, 0, 0], ["Dárky", "expense", 0, 1, 0],
    ["Různé", "expense", 0, 0, 1],
    ["Telefon", "expense", 1, 1, 0], ["DPS", "expense", 1, 1, 0],
    ["Spoření", "saving", 1, 1, 0],
  ];

  /* ------------------------------------------------------------ IndexedDB */
  function idb() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(IDB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(IDB_STORE);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async function idbOp(mode, fn) {
    const d = await idb();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(IDB_STORE, mode);
      const req = fn(tx.objectStore(IDB_STORE));
      tx.oncomplete = () => { d.close(); resolve(req && req.result); };
      tx.onerror = tx.onabort = () => { d.close(); reject(tx.error); };
    });
  }
  const idbGet = key => idbOp("readonly", s => s.get(key));
  const idbPut = (key, val) => idbOp("readwrite", s => s.put(val, key));
  const idbDel = key => idbOp("readwrite", s => s.delete(key));
  const idbKeys = () => idbOp("readonly", s => s.getAllKeys());

  /* ------------------------------------------------------------ SQL helpers */
  let SQL, db;
  function bind(params) {
    return (params || []).map(v => (typeof v === "boolean" ? (v ? 1 : 0) : v === undefined ? null : v));
  }
  function all(sql, params) {
    const st = db.prepare(sql);
    try {
      st.bind(bind(params));
      const out = [];
      while (st.step()) out.push(st.getAsObject());
      return out;
    } finally { st.free(); }
  }
  function allRows(sql, params) {          // pole hodnot místo objektů
    const st = db.prepare(sql);
    try {
      st.bind(bind(params));
      const out = [];
      while (st.step()) out.push(st.get());
      return out;
    } finally { st.free(); }
  }
  const one = (sql, params) => all(sql, params)[0];
  const oneRow = (sql, params) => allRows(sql, params)[0];
  function run(sql, params) {
    db.run(sql, bind(params));
    return { changes: db.getRowsModified(), lastId: oneRow("SELECT last_insert_rowid()")[0] };
  }

  class ApiError extends Error {
    constructor(msg, status = 400) { super(msg); this.status = status; }
  }

  function initDb(seed = true) {
    db.run("PRAGMA foreign_keys = ON");
    db.exec(SCHEMA);
    migrate();
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS))
      run("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)", [k, v]);
    if (seed && oneRow("SELECT COUNT(*) FROM categories")[0] === 0)
      DEFAULT_CATEGORIES.forEach(([name, typ, fixed, nec, noteReq], i) =>
        run("INSERT INTO categories(name, type, fixed, necessary, note_required, sort) VALUES (?,?,?,?,?,?)",
          [name, typ, fixed, nec, noteReq, i]));
  }
  function migrate() {
    const cols = t => new Set(allRows(`PRAGMA table_info(${t})`).map(r => r[1]));
    if (!cols("categories").has("necessary"))
      db.run("ALTER TABLE categories ADD COLUMN necessary INTEGER NOT NULL DEFAULT 0");
    if (!cols("categories").has("note_required"))
      db.run("ALTER TABLE categories ADD COLUMN note_required INTEGER NOT NULL DEFAULT 0");
    if (!cols("transactions").has("necessary"))
      db.run("ALTER TABLE transactions ADD COLUMN necessary INTEGER NOT NULL DEFAULT 0");
    db.run("DROP TABLE IF EXISTS years");
  }
  const getSettings = () => Object.fromEntries(allRows("SELECT key, value FROM settings"));

  /* ------------------------------------------------------------ dates & periods */
  const pad = n => String(n).padStart(2, "0");
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };
  function parseDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
    if (!m) throw new ApiError("Neplatné datum.");
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    if (d.getFullYear() !== +m[1] || d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) throw new ApiError("Neplatné datum.");
    return d;
  }
  function periodOf(d, sd) {
    if (d.getDate() >= sd) return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    const prev = new Date(d.getFullYear(), d.getMonth(), 0);
    return `${prev.getFullYear()}-${pad(prev.getMonth() + 1)}`;
  }
  const periodOfIso = (s, sd) => {      // rychlá verze pro 'YYYY-MM-DD' bez validace
    const y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
    if (d >= sd) return s.slice(0, 7);
    return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`;
  };
  function periodRange(period, sd) {
    const [y, m] = period.split("-").map(Number);
    return [new Date(y, m - 1, sd), new Date(y, m, sd - 1)];
  }
  function shiftPeriod(period, delta) {
    const [y, m] = period.split("-").map(Number);
    const idx = y * 12 + (m - 1) + delta;
    return `${String(Math.floor(idx / 12)).padStart(4, "0")}-${pad(idx % 12 + 1)}`;
  }
  function parseAmount(v, msg = "Neplatná částka.") {
    const s = String(v ?? "").replace(/,/g, ".").replace(/ /g, "").trim();
    const n = Number(s);
    if (s === "" || !Number.isFinite(n)) throw new ApiError(msg);
    return Math.round(n * 100) / 100;
  }

  /* ------------------------------------------------------------ API */
  function apiMeta() {
    const cats = all("SELECT * FROM categories ORDER BY archived, sort, name");
    const counts = new Map(allRows("SELECT category_id, COUNT(*) FROM transactions GROUP BY category_id"));
    for (const c of cats) c.tx_count = counts.get(c.id) || 0;
    const notes = allRows(`SELECT note FROM transactions WHERE note <> '' AND date >= date('now','-3 years')
                           GROUP BY note ORDER BY COUNT(*) DESC LIMIT 400`).map(r => r[0]);
    const rng = oneRow("SELECT MIN(date), MAX(date), COUNT(*) FROM transactions");
    const settings = getSettings();
    const t = today();
    return {
      categories: cats, settings, notes,
      recurring: all("SELECT * FROM recurring ORDER BY id"),
      current_period: periodOf(t, +settings.period_start_day),
      today: iso(t),
      data_range: { min: rng[0], max: rng[1], count: rng[2] },
    };
  }

  function apiTransactions(q) {
    const where = [], args = [];
    if (q.from) { where.push("t.date >= ?"); args.push(q.from); }
    if (q.to) { where.push("t.date <= ?"); args.push(q.to); }
    if (q.category) {
      const ids = q.category.split(",").filter(Boolean).map(x => parseInt(x, 10));
      where.push(`t.category_id IN (${ids.map(() => "?").join(",")})`); args.push(...ids);
    }
    if (q.type) { where.push("c.type = ?"); args.push(q.type); }
    if (q.q) { where.push("t.note LIKE ?"); args.push(`%${q.q}%`); }
    if (q.necessary === "0" || q.necessary === "1") {
      where.push("c.type = 'expense' AND t.necessary = ?"); args.push(+q.necessary);
    }
    const w = where.length ? "WHERE " + where.join(" AND ") : "";
    const limit = Math.min(parseInt(q.limit || 500, 10), 5000);
    const items = all(`SELECT t.*, c.name AS category, c.type AS type FROM transactions t
                       JOIN categories c ON c.id = t.category_id ${w}
                       ORDER BY t.date DESC, t.id DESC LIMIT ?`, [...args, limit]);
    const a = oneRow(`SELECT COUNT(*),
                   COALESCE(SUM(CASE WHEN c.type='income' THEN t.amount END),0),
                   COALESCE(SUM(CASE WHEN c.type='expense' THEN t.amount END),0),
                   COALESCE(SUM(CASE WHEN c.type='saving' THEN t.amount END),0),
                   COALESCE(SUM(CASE WHEN c.type='expense' AND t.necessary=1 THEN t.amount END),0),
                   COALESCE(SUM(CASE WHEN c.type='expense' AND t.necessary=0 THEN t.amount END),0)
            FROM transactions t JOIN categories c ON c.id = t.category_id ${w}`, args);
    return { items, count: a[0], income: a[1], expense: a[2], saving: a[3], necessary: a[4], optional: a[5] };
  }

  function validateTx(b) {
    const d = parseDate(String(b.date ?? ""));
    const amount = parseAmount(b.amount);
    if (amount === 0) throw new ApiError("Částka nesmí být nulová.");
    const cat = one("SELECT * FROM categories WHERE id = ?", [b.category_id ?? null]);
    if (!cat) throw new ApiError("Neznámá kategorie.");
    const note = String(b.note ?? "").trim();
    if (cat.note_required && !note) throw new ApiError(`U kategorie ${cat.name} vyplňte poznámku.`);
    const necessary = b.necessary !== undefined && b.necessary !== null ? (b.necessary ? 1 : 0) : cat.necessary;
    return [iso(d), amount, cat.id, note, necessary];
  }
  const txCreate = b => ({ id: run("INSERT INTO transactions(date, amount, category_id, note, necessary) VALUES (?,?,?,?,?)", validateTx(b)).lastId });
  function txUpdate(b, id) {
    if (!run("UPDATE transactions SET date=?, amount=?, category_id=?, note=?, necessary=? WHERE id=?", [...validateTx(b), id]).changes)
      throw new ApiError("Záznam nenalezen.", 404);
    return { ok: true };
  }
  const txDelete = (b, id) => (run("DELETE FROM transactions WHERE id = ?", [id]), { ok: true });

  function sumsByPeriod(sd, from, to, key = "t.category_id", extra = []) {
    const where = [...extra], args = [];
    if (from) { where.push("t.date >= ?"); args.push(from); }
    if (to) { where.push("t.date <= ?"); args.push(to); }
    const w = where.length ? "WHERE " + where.join(" AND ") : "";
    const out = {};
    for (const [d, k, total] of allRows(`SELECT t.date, ${key}, SUM(t.amount) FROM transactions t
          JOIN categories c ON c.id = t.category_id ${w} GROUP BY t.date, ${key}`, args)) {
      const p = periodOfIso(d, sd);
      const bucket = out[p] || (out[p] = {});
      bucket[k] = (bucket[k] || 0) + total;
    }
    return out;
  }

  function apiSummary(q) {
    const sd = +getSettings().period_start_day;
    const period = q.period || periodOf(today(), sd);
    const [start, end] = periodRange(period, sd);
    const [histStart] = periodRange(shiftPeriod(period, -12), sd);
    const sums = sumsByPeriod(sd, iso(histStart), iso(end));
    const current = sums[period] || {};
    const have = [];
    for (let i = 1; i <= 12; i++) { const p = shiftPeriod(period, -i); if (sums[p]) have.push(p); }
    const avg = {};
    for (const p of have) for (const [cid, v] of Object.entries(sums[p])) avg[cid] = (avg[cid] || 0) + v;
    for (const cid in avg) avg[cid] /= have.length;
    const daily = all(`SELECT t.date, SUM(t.amount) AS total FROM transactions t
           JOIN categories c ON c.id = t.category_id
           WHERE c.type='expense' AND c.fixed=0 AND t.date BETWEEN ? AND ?
           GROUP BY t.date ORDER BY t.date`, [iso(start), iso(end)]);
    const nec = Object.fromEntries(allRows(`SELECT t.necessary, SUM(t.amount) FROM transactions t JOIN categories c ON c.id = t.category_id
           WHERE c.type='expense' AND t.date BETWEEN ? AND ? GROUP BY t.necessary`, [iso(start), iso(end)]));
    return {
      period, start: iso(start), end: iso(end),
      by_necessity: { 1: nec[1] || 0, 0: nec[0] || 0 },
      by_category: current, avg12: avg, avg_periods: have.length, daily,
    };
  }

  function apiStats(q) {
    const sd = +getSettings().period_start_day;
    const group = q.group || "period";
    const regroup = sums => {
      const out = {};
      for (const p of Object.keys(sums).sort()) {
        const key = group === "year" ? p.slice(0, 4) : p;
        const b = out[key] || (out[key] = {});
        for (const [cid, v] of Object.entries(sums[p])) b[cid] = (b[cid] || 0) + v;
      }
      return out;
    };
    return {
      group,
      buckets: regroup(sumsByPeriod(sd, q.from, q.to)),
      necessity: regroup(sumsByPeriod(sd, q.from, q.to, "t.necessary", ["c.type = 'expense'"])),
    };
  }

  function apiNotes(q) {
    const where = ["t.note <> ''", "c.type = 'expense'"], args = [];
    if (q.from) { where.push("t.date >= ?"); args.push(q.from); }
    if (q.to) { where.push("t.date <= ?"); args.push(q.to); }
    return all(`SELECT LOWER(TRIM(t.note)) AS note, COUNT(*) AS n, SUM(t.amount) AS total
            FROM transactions t JOIN categories c ON c.id = t.category_id
            WHERE ${where.join(" AND ")} AND LOWER(TRIM(t.note)) <> 'x'
            GROUP BY LOWER(TRIM(t.note)) ORDER BY total DESC LIMIT 40`, args);
  }

  // categories
  function catFields(b) {
    const name = String(b.name ?? "").trim();
    if (!name) throw new ApiError("Název kategorie je povinný.");
    const typ = b.type || "expense";
    if (!["expense", "income", "saving"].includes(typ)) throw new ApiError("Neplatný typ kategorie.");
    const flag = k => (b[k] ? 1 : 0);
    return [name, typ, flag("fixed"), flag("archived"), flag("necessary"), flag("note_required")];
  }
  const uniqueGuard = fn => {
    try { return fn(); } catch (e) {
      if (/UNIQUE/i.test(e.message)) throw new ApiError("Kategorie s tímto názvem už existuje.");
      throw e;
    }
  };
  function catCreate(b) {
    const f = catFields(b);
    return uniqueGuard(() => {
      const nxt = oneRow("SELECT COALESCE(MAX(sort),0)+1 FROM categories")[0];
      return { id: run("INSERT INTO categories(name, type, fixed, archived, necessary, note_required, sort) VALUES (?,?,?,?,?,?,?)", [...f, nxt]).lastId };
    });
  }
  function catUpdate(b, id) {
    const f = catFields(b);
    uniqueGuard(() => run("UPDATE categories SET name=?, type=?, fixed=?, archived=?, necessary=?, note_required=? WHERE id=?", [...f, id]));
    return { ok: true };
  }
  function catMerge(b, id) {
    const into = parseInt(b.into || 0, 10);
    if (into === id || !one("SELECT 1 FROM categories WHERE id=?", [into])) throw new ApiError("Neplatná cílová kategorie.");
    const n = run("UPDATE transactions SET category_id=? WHERE category_id=?", [into, id]).changes;
    run("UPDATE recurring SET category_id=? WHERE category_id=?", [into, id]);
    run("DELETE FROM categories WHERE id=?", [id]);
    return { moved: n };
  }
  function catDelete(b, id) {
    if (one("SELECT 1 FROM transactions WHERE category_id=? LIMIT 1", [id]))
      throw new ApiError("Kategorie obsahuje záznamy – použijte sloučení nebo archivaci.");
    run("DELETE FROM recurring WHERE category_id=?", [id]);
    run("DELETE FROM categories WHERE id=?", [id]);
    return { ok: true };
  }
  function catOrder(b) {
    (b.ids || []).forEach((cid, i) => run("UPDATE categories SET sort=? WHERE id=?", [i, parseInt(cid, 10)]));
    return { ok: true };
  }

  // recurring
  function recFields(b) {
    if (!one("SELECT 1 FROM categories WHERE id=?", [b.category_id ?? null])) throw new ApiError("Neznámá kategorie.");
    return [parseInt(b.category_id, 10), parseAmount(b.amount), String(b.note ?? "").trim(), b.active === undefined || b.active ? 1 : 0];
  }
  const recCreate = b => ({ id: run("INSERT INTO recurring(category_id, amount, note, active) VALUES (?,?,?,?)", recFields(b)).lastId });
  const recUpdate = (b, id) => (run("UPDATE recurring SET category_id=?, amount=?, note=?, active=? WHERE id=?", [...recFields(b), id]), { ok: true });
  const recDelete = (b, id) => (run("DELETE FROM recurring WHERE id=?", [id]), { ok: true });
  function recApply(b) {
    const sd = +getSettings().period_start_day;
    const period = b.period || periodOf(today(), sd);
    const [start, end] = periodRange(period, sd);
    const d = b.date ? parseDate(b.date) : start;
    let added = 0, skipped = 0;
    for (const r of all(`SELECT r.*, c.necessary FROM recurring r JOIN categories c ON c.id = r.category_id WHERE r.active=1`)) {
      if (one("SELECT 1 FROM transactions WHERE category_id=? AND date BETWEEN ? AND ? LIMIT 1", [r.category_id, iso(start), iso(end)])) {
        skipped++; continue;
      }
      run("INSERT INTO transactions(date, amount, category_id, note, source, necessary) VALUES (?,?,?,?,?,?)",
        [iso(d), r.amount, r.category_id, r.note, "recurring", r.necessary]);
      added++;
    }
    return { added, skipped, period };
  }

  // year
  function apiYear(q) {
    const sd = +getSettings().period_start_day;
    const year = parseInt(q.year || periodOf(today(), sd).slice(0, 4), 10);
    const [start] = periodRange(`${year}-01`, sd);
    const [, end] = periodRange(`${year}-12`, sd);
    const types = new Map(allRows("SELECT id, type FROM categories"));
    const byCat = sumsByPeriod(sd, iso(start), iso(end));
    const byNec = sumsByPeriod(sd, iso(start), iso(end), "t.necessary", ["c.type = 'expense'"]);
    const months = [];
    for (let m = 1; m <= 12; m++) {
      const p = `${year}-${pad(m)}`;
      const cats = byCat[p] || {};
      let inc = 0, sav = 0;
      for (const [cid, v] of Object.entries(cats)) {
        const t = types.get(+cid);
        if (t === "income") inc += v; else if (t === "saving") sav += v;
      }
      const nec = (byNec[p] || {})[1] || 0, opt = (byNec[p] || {})[0] || 0;
      months.push({ period: p, income: inc, necessary: nec, optional: opt, saving: sav,
        balance: inc - nec - opt - sav, has_data: Object.keys(cats).length > 0 });
    }
    const items = all("SELECT * FROM annual_items WHERE year=? ORDER BY kind DESC, amount DESC", [year]);
    const years = new Set(allRows("SELECT DISTINCT date FROM transactions").map(r => +periodOfIso(r[0], sd).slice(0, 4)));
    allRows("SELECT DISTINCT year FROM annual_items").forEach(r => years.add(r[0]));
    years.add(year);
    return {
      year, months, items,
      extra_income: items.filter(i => i.kind === "income").reduce((a, i) => a + i.amount, 0),
      extra_expense: items.filter(i => i.kind === "expense").reduce((a, i) => a + i.amount, 0),
      names: allRows("SELECT name FROM annual_items GROUP BY name ORDER BY COUNT(*) DESC, name").map(r => r[0]),
      years: [...years].sort((a, b) => a - b),
    };
  }
  function annualFields(b) {
    const year = parseInt(b.year, 10);
    if (!Number.isFinite(year)) throw new ApiError("Neplatný rok nebo částka.");
    const amount = parseAmount(b.amount, "Neplatný rok nebo částka.");
    if (!["income", "expense"].includes(b.kind)) throw new ApiError("Neplatný typ položky.");
    const name = String(b.name ?? "").trim();
    if (!name) throw new ApiError("Vyplňte název položky.");
    return [year, b.kind, name, amount, String(b.note ?? "").trim()];
  }
  const annualCreate = b => ({ id: run("INSERT INTO annual_items(year, kind, name, amount, note) VALUES (?,?,?,?,?)", annualFields(b)).lastId });
  const annualUpdate = (b, id) => (run("UPDATE annual_items SET year=?, kind=?, name=?, amount=?, note=? WHERE id=?", [...annualFields(b), id]), { ok: true });
  const annualDelete = (b, id) => (run("DELETE FROM annual_items WHERE id=?", [id]), { ok: true });

  function apiSettings(b) {
    if ("period_start_day" in b) {
      const v = parseInt(b.period_start_day, 10);
      if (!(v >= 1 && v <= 28)) throw new ApiError("Začátek období musí být 1–28.");
      run("UPDATE settings SET value=? WHERE key='period_start_day'", [String(v)]);
    }
    if ("currency" in b) run("UPDATE settings SET value=? WHERE key='currency'", [String(b.currency).slice(0, 8)]);
    return { ok: true };
  }

  function exportCsv() {
    const typ = { income: "příjem", expense: "výdaj", saving: "spoření" };
    const num = v => v.toFixed(2).replace(/0+$/, "").replace(/\.$/, "").replace(".", ",");
    const cell = v => { const s = String(v ?? ""); return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const sd = +getSettings().period_start_day;
    const lines = [["druh", "rok", "obdobi", "datum", "typ", "kategorie", "fixni", "castka", "nutnost", "poznamka"]];
    for (const r of allRows(`SELECT t.date, c.type, c.name, c.fixed, t.amount, t.note, t.necessary FROM transactions t
               JOIN categories c ON c.id=t.category_id ORDER BY t.date, t.id`)) {
      const period = periodOfIso(r[0], sd);
      const nec = r[1] === "expense" ? (r[6] ? "nutná" : "volitelná") : "";
      lines.push(["běžná", period.slice(0, 4), period, r[0], typ[r[1]], r[2], r[3] ? "ano" : "ne", num(r[4]), nec, r[5]]);
    }
    for (const r of allRows("SELECT year, kind, name, amount, note FROM annual_items ORDER BY year, kind DESC, amount DESC"))
      lines.push(["mimořádná", r[0], "", "", typ[r[1]], r[2], "", num(r[3]), "", r[4]]);
    return "﻿" + lines.map(l => l.map(cell).join(";")).join("\r\n") + "\r\n";
  }

  /* ------------------------------------------------------------ routing */
  const ROUTES = [
    ["GET", /^\/api\/meta$/, apiMeta],
    ["GET", /^\/api\/transactions$/, apiTransactions],
    ["POST", /^\/api\/transactions$/, txCreate],
    ["PUT", /^\/api\/transactions\/(\d+)$/, txUpdate],
    ["DELETE", /^\/api\/transactions\/(\d+)$/, txDelete],
    ["GET", /^\/api\/summary$/, apiSummary],
    ["GET", /^\/api\/stats$/, apiStats],
    ["GET", /^\/api\/notes$/, apiNotes],
    ["POST", /^\/api\/categories$/, catCreate],
    ["POST", /^\/api\/categories\/order$/, catOrder],
    ["PUT", /^\/api\/categories\/(\d+)$/, catUpdate],
    ["POST", /^\/api\/categories\/(\d+)\/merge$/, catMerge],
    ["DELETE", /^\/api\/categories\/(\d+)$/, catDelete],
    ["POST", /^\/api\/recurring$/, recCreate],
    ["POST", /^\/api\/recurring\/apply$/, recApply],
    ["PUT", /^\/api\/recurring\/(\d+)$/, recUpdate],
    ["DELETE", /^\/api\/recurring\/(\d+)$/, recDelete],
    ["PUT", /^\/api\/settings$/, apiSettings],
    ["GET", /^\/api\/year$/, apiYear],
    ["POST", /^\/api\/annual$/, annualCreate],
    ["PUT", /^\/api\/annual\/(\d+)$/, annualUpdate],
    ["DELETE", /^\/api\/annual\/(\d+)$/, annualDelete],
  ];

  // zápisy se ukládají postupně, aby se nepředbíhaly
  let saveChain = Promise.resolve();
  function exportDb() {
    const bytes = db.export();
    db.run("PRAGMA foreign_keys = ON");          // export() znovu otevře databázi a pragmy se ztratí
    return bytes;
  }
  function persist() {
    const bytes = exportDb();
    saveChain = saveChain.then(() => idbPut(KEY_MAIN, bytes)).catch(e => {
      console.error(e);
      alert("Nepodařilo se uložit data do telefonu: " + e.message);
    });
    return saveChain;
  }

  let ready;
  async function handle(method, url, body) {
    await ready;
    const u = new URL(url, location.href);
    for (const [m, re, fn] of ROUTES) {
      if (m !== method) continue;
      const match = re.exec(u.pathname.replace(/^.*?(\/api\/)/, "/api/"));
      if (!match) continue;
      if (method === "GET") {
        const q = Object.fromEntries(u.searchParams);
        return JSON.parse(JSON.stringify(fn(q)));
      }
      db.run("BEGIN");
      let result;
      try {
        result = fn(JSON.parse(JSON.stringify(body || {})), ...match.slice(1).map(Number));
        db.run("COMMIT");
      } catch (e) {
        db.run("ROLLBACK");
        if (e instanceof ApiError) throw e;
        console.error(e);
        throw new Error("Chyba: " + e.message);
      }
      await persist();
      return JSON.parse(JSON.stringify(result));
    }
    throw new Error("Neznámý požadavek");
  }

  /* ------------------------------------------------------------ zálohy */
  async function autoBackup(bytes) {
    // jedna automatická záloha denně, drží se posledních KEEP_AUTO_BACKUPS
    const key = "backup-" + iso(today());
    const keys = (await idbKeys()).filter(k => String(k).startsWith("backup-")).sort();
    if (!keys.includes(key)) await idbPut(key, bytes);
    const all = (await idbKeys()).filter(k => String(k).startsWith("backup-")).sort();
    for (const k of all.slice(0, Math.max(0, all.length - KEEP_AUTO_BACKUPS))) await idbDel(k);
  }

  function openBytes(bytes) {
    const d = new SQL.Database(bytes);
    const tables = new Set(d.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values.map(r => r[0]) || []);
    if (bytes && !["categories", "transactions", "settings"].every(t => tables.has(t))) {
      d.close();
      throw new Error("Soubor není databáze CashTrackeru.");
    }
    return d;
  }

  async function start() {
    const vendor = document.currentScript ? new URL("vendor/", document.currentScript.src).href : "vendor/";
    SQL = await initSqlJs({ locateFile: f => vendor + f });
    const stored = await idbGet(KEY_MAIN);
    db = stored ? openBytes(stored) : new SQL.Database();
    initDb();
    if (stored) await autoBackup(stored);
    await persist();
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch { /* ignore */ }
  }
  ready = start();

  window.LOCAL_API = handle;
  window.CT_DB = {
    ready: () => ready,
    exportBytes: async () => { await ready; return exportDb(); },
    exportCsv: async () => { await ready; return exportCsv(); },
    async importBytes(bytes) {
      await ready;
      const d = openBytes(bytes);
      await saveChain;
      const old = db;
      db = d;
      try { initDb(false); } catch (e) { db = old; d.close(); throw e; }
      await idbPut("before-import-" + iso(today()) + "-" + Date.now(), old.export());
      old.close();
      const prev = (await idbKeys()).filter(k => String(k).startsWith("before-import-")).sort();
      for (const k of prev.slice(0, Math.max(0, prev.length - 3))) await idbDel(k);
      await persist();
    },
    async backups() { return (await idbKeys()).filter(k => /^(backup|before-import)-/.test(k)).sort().reverse(); },
    async restoreBackup(key) {
      const bytes = await idbGet(key);
      if (!bytes) throw new Error("Záloha nenalezena.");
      await this.importBytes(bytes);
    },
  };
})();
