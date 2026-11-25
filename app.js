"use strict";

/* ================================================================ utils */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const MONTHS = ["Leden", "Únor", "Březen", "Duben", "Květen", "Červen", "Červenec",
  "Srpen", "Září", "Říjen", "Listopad", "Prosinec"];
const nf = new Intl.NumberFormat("cs-CZ", { maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat("cs-CZ", { maximumFractionDigits: 0 });
const TYPE_LABEL = { expense: "Výdaj", income: "Příjem", saving: "Spoření" };
const SERIES = ["--s1", "--s2", "--s3", "--s4", "--s5", "--s6", "--s7", "--s8"].map(v => `var(${v})`);

const state = {
  meta: null,
  cats: new Map(),
  period: null,
  txLimit: 300,
  statRange: "12",
};

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function money(n, withCur = true) {
  const s = nf.format(Math.round((n || 0) * 100) / 100);
  return withCur ? `${s} ${state.meta?.settings.currency || "Kč"}` : s;
}
function compact(n) {
  const a = Math.abs(n);
  if (a >= 1e6) return nf.format(Math.round(n / 1e5) / 10) + " mil.";
  if (a >= 1e3) return nf0.format(Math.round(n / 1e3)) + " tis.";
  return nf0.format(n);
}
function fmtDate(iso, withYear = true) {
  const [y, m, d] = iso.split("-").map(Number);
  return withYear ? `${d}. ${m}. ${y}` : `${d}. ${m}.`;
}
function periodLabel(p) {
  if (/^\d{4}$/.test(p)) return p;
  const [y, m] = p.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}
function shiftPeriod(p, delta) {
  const [y, m] = p.split("-").map(Number);
  const idx = y * 12 + (m - 1) + delta;
  return `${Math.floor(idx / 12)}-${String(idx % 12 + 1).padStart(2, "0")}`;
}
function periodRange(p) {
  const sd = Number(state.meta.settings.period_start_day);
  const [y, m] = p.split("-").map(Number);
  const start = new Date(y, m - 1, sd);
  const end = new Date(y, m, sd - 1);
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { from: iso(start), to: iso(end) };
}
function parseAmount(s) {
  // umožní zapsat i součet, např. "120+85,50"
  const parts = String(s).replace(/\s/g, "").replace(/,/g, ".").split("+").filter(Boolean);
  if (!parts.length) return NaN;
  let sum = 0;
  for (const p of parts) {
    if (!/^-?\d+(\.\d+)?$/.test(p)) return NaN;
    sum += parseFloat(p);
  }
  return Math.round(sum * 100) / 100;
}
async function api(method, url, body) {
  if (window.LOCAL_API) return window.LOCAL_API(method, url, body);
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Chyba ${res.status}`);
  return data;
}
let toastTimer;
function toast(msg, action) {
  const el = $("#toast");
  el.innerHTML = esc(msg);
  if (action) {
    const b = document.createElement("button");
    b.textContent = action.label;
    b.onclick = () => { el.hidden = true; action.run(); };
    el.appendChild(b);
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), action ? 6000 : 2500);
}
function catsOf(type, { includeArchived = false } = {}) {
  return [...state.cats.values()].filter(c => c.type === type && (includeArchived || !c.archived));
}

/* ================================================================ meta */
async function loadMeta() {
  state.meta = await api("GET", "/api/meta");
  state.cats = new Map(state.meta.categories.map(c => [c.id, c]));
  if (!state.period) state.period = state.meta.current_period;
  let dl = $("#noteList");
  if (!dl) {
    dl = document.createElement("datalist");
    dl.id = "noteList";
    document.body.appendChild(dl);
  }
  dl.innerHTML = state.meta.notes.map(n => `<option value="${esc(n)}">`).join("");
}

/* ================================================================ transaction form */
function buildTxForm(form, { tx = null, onSaved, onCancel } = {}) {
  const cat0 = tx ? state.cats.get(tx.category_id) : null;
  let type = cat0 ? cat0.type : "expense";
  let catId = tx ? tx.category_id : null;
  let necessary = tx ? tx.necessary : null, necFor = tx ? tx.category_id : null;
  let done = new Set(), autoAmount = null;   // už zapsané fixní platby; částka předvyplněná ze šablony
  const remembered = {};

  form.innerHTML = `
    <div class="seg" role="tablist">
      ${Object.entries(TYPE_LABEL).map(([k, v]) => `<button type="button" data-type="${k}">${v}</button>`).join("")}
    </div>
    <div class="row2">
      <label class="amount">Částka (${esc(state.meta.settings.currency)})
        <input name="amount" inputmode="decimal" placeholder="0" required></label>
      <label>Datum <input name="date" type="date" required></label>
    </div>
    <div class="chips" data-role="chips"></div>
    <div class="nec-row" data-role="nec">
      <span class="muted small">Platba</span>
      <div class="seg">
        <button type="button" data-nec="1"><span class="dot nec1"></span>Nutná</button>
        <button type="button" data-nec="0"><span class="dot nec0"></span>Volitelná</button>
      </div>
    </div>
    <label><span data-role="noteLabel">Poznámka</span> <input name="note" list="noteList"></label>
    <div class="form-error" data-role="err"></div>
    <div class="form-actions">
      <button type="submit">${tx ? "Uložit změny" : "Přidat"}</button>
      ${onCancel ? '<button type="button" class="ghost" data-role="cancel">Zrušit</button>' : ""}
      ${tx ? "" : '<span class="muted small">Enter = uložit · do částky jde psát i 120+85</span>'}
    </div>`;
  const amount = form.elements.amount, dateIn = form.elements.date, note = form.elements.note;
  const err = $('[data-role="err"]', form);
  amount.value = tx ? String(tx.amount).replace(".", ",") : "";
  dateIn.value = tx ? tx.date : state.meta.today;
  note.value = tx ? tx.note : "";

  function renderChips() {
    $$(".seg button", form).forEach(b => b.classList.toggle("active", b.dataset.type === type));
    let list = catsOf(type);
    if (cat0 && cat0.type === type && cat0.archived) list = [...list, cat0];
    if (!list.some(c => c.id === catId)) catId = remembered[type] ?? list[0]?.id ?? null;
    const groups = type === "expense"
      ? [["Denní útrata", list.filter(c => !c.fixed)], ["Fixní platby", list.filter(c => c.fixed)]]
      : [["", list]];
    $('[data-role="chips"]', form).innerHTML = groups.filter(g => g[1].length).map(([label, cs]) =>
      (label && groups.length > 1 ? `<div class="chip-group-label">${label}</div>` : "") +
      cs.map(c => {
        const isDone = !tx && c.fixed && done.has(c.id);
        return `<button type="button" class="chip ${c.id === catId ? "active" : ""} ${isDone ? "done" : ""}" data-id="${c.id}"
          ${isDone ? 'title="V tomto období už zapsáno"' : ""}>${isDone ? "✓ " : ""}${esc(c.name)}</button>`;
      }).join("")
    ).join("") || '<span class="muted small">Žádná kategorie tohoto typu – přidejte ji v Nastavení.</span>';
    renderExtras();
  }
  function renderExtras() {
    const cat = state.cats.get(catId);
    if (cat && necFor !== catId) { necessary = cat.necessary; necFor = catId; }
    const nec = $('[data-role="nec"]', form);
    nec.hidden = type !== "expense";
    $$("[data-nec]", nec).forEach(b => b.classList.toggle("active", Number(b.dataset.nec) === necessary));
    const req = cat && cat.note_required;
    $('[data-role="noteLabel"]', form).textContent = req ? `Poznámka – povinná u kategorie ${cat.name}` : "Poznámka";
    note.placeholder = req ? "Co to bylo?" : "nepovinná";
  }
  form.addEventListener("click", e => {
    const t = e.target.closest("[data-type]");
    if (t) { remembered[type] = catId; type = t.dataset.type; catId = remembered[type] ?? null; renderChips(); return; }
    const c = e.target.closest(".chip");
    if (c) {
      catId = Number(c.dataset.id); remembered[type] = catId; renderChips();
      // částka ze šablony pravidelné platby (jen u nového záznamu a jen do prázdného/předvyplněného pole)
      if (!tx) {
        const tpl = state.meta.recurring.find(r => r.active && r.category_id === catId);
        if (!amount.value.trim() || amount.value === autoAmount) {
          autoAmount = tpl ? String(tpl.amount).replace(".", ",") : null;
          amount.value = autoAmount ?? "";
          if (tpl && tpl.note && !note.value) note.value = tpl.note;
        }
      }
      (state.cats.get(catId).note_required ? note : amount).focus();
      if (autoAmount && amount.value === autoAmount) amount.select();
    }
    const n = e.target.closest("[data-nec]");
    if (n) { necessary = Number(n.dataset.nec); renderExtras(); }
    if (e.target.closest('[data-role="cancel"]')) onCancel();
  });
  form.onsubmit = async e => {
    e.preventDefault();
    err.textContent = "";
    const value = parseAmount(amount.value);
    if (!Number.isFinite(value) || value === 0) { err.textContent = "Zadejte částku."; amount.focus(); return; }
    if (!catId) { err.textContent = "Vyberte kategorii."; return; }
    const cat = state.cats.get(catId);
    if (cat.note_required && !note.value.trim()) {
      err.textContent = `U kategorie ${cat.name} vyplňte poznámku.`; note.focus(); return;
    }
    const body = { date: dateIn.value, amount: value, category_id: catId, note: note.value.trim(),
      necessary: cat.type === "expense" ? necessary : cat.necessary };
    try {
      if (tx) await api("PUT", `/api/transactions/${tx.id}`, body);
      else await api("POST", "/api/transactions", body);
    } catch (ex) { err.textContent = ex.message; return; }
    if (!tx) {
      amount.value = ""; note.value = ""; autoAmount = null;
      necFor = null; renderExtras();   // příznak zpět na výchozí hodnotu kategorie
      amount.focus();
      toast(`Přidáno: ${state.cats.get(catId).name} ${money(value)}`);
    }
    onSaved && onSaved(body);
  };
  renderChips();
  return {
    focus: () => amount.focus(),
    setDone: ids => { done = ids; renderChips(); },
  };
}

function openEdit(tx) {
  const dlg = $("#editDialog");
  const host = $("#editFormHost");
  host.innerHTML = '<form class="tx-form" autocomplete="off"></form>';
  buildTxForm($("form", host), {
    tx,
    onSaved: () => { dlg.close(); toast("Uloženo"); refreshCurrent(); },
    onCancel: () => dlg.close(),
  });
  dlg.showModal();
}

async function deleteTx(tx) {
  await api("DELETE", `/api/transactions/${tx.id}`);
  refreshCurrent();
  toast(`Smazáno: ${tx.category} ${money(tx.amount)}`, {
    label: "Vrátit",
    run: async () => {
      await api("POST", "/api/transactions", { date: tx.date, amount: tx.amount, category_id: tx.category_id, note: tx.note, necessary: tx.necessary });
      refreshCurrent();
    },
  });
}

function necDot(tx) {
  if (tx.type !== "expense") return '<span class="dot none"></span>';
  return `<span class="dot nec${tx.necessary ? 1 : 0}" title="${tx.necessary ? "Nutná" : "Volitelná"} platba"></span>`;
}

function txActions(tx) {
  const wrap = document.createElement("span");
  wrap.className = "row-actions";
  wrap.innerHTML = '<button title="Upravit">✎</button><button title="Smazat">🗑</button>';
  const [e, d] = wrap.children;
  e.onclick = () => openEdit(tx);
  d.onclick = () => deleteTx(tx);
  return wrap;
}

/* ================================================================ overview */
let quickForm;
async function renderOverview() {
  const p = state.period;
  const { from, to } = periodRange(p);
  $("#periodTitle").textContent = periodLabel(p);
  $("#periodRange").textContent = `${fmtDate(from)} – ${fmtDate(to)}` + (p === state.meta.current_period ? " · aktuální období" : "");
  if (!quickForm) quickForm = buildTxForm($("#quickForm"), { onSaved: () => renderOverview() });

  const [sum, txs] = await Promise.all([
    api("GET", `/api/summary?period=${p}`),
    api("GET", `/api/transactions?from=${from}&to=${to}&limit=2000`),
  ]);
  const by = id => sum.by_category[id] || 0;
  const avg = id => sum.avg12[id] || 0;
  // fixní platby už zapsané v zobrazeném období se ve formuláři zeslabí
  quickForm.setDone(new Set([...state.cats.values()].filter(c => c.fixed && by(c.id)).map(c => c.id)));
  let income = 0, daily = 0, fixed = 0, saving = 0, dailyAvg = 0;
  for (const c of state.cats.values()) {
    if (c.type === "income") income += by(c.id);
    else if (c.type === "saving") saving += by(c.id);
    else if (c.fixed) fixed += by(c.id);
    else { daily += by(c.id); dailyAvg += avg(c.id); }
  }
  const balance = income - daily - fixed - saving;
  const diff = daily - dailyAvg;
  const nec = sum.by_necessity["1"], opt = sum.by_necessity["0"], exp = nec + opt;
  const pct = v => exp > 0 ? Math.round(v / exp * 100) : 0;
  $("#kpis").innerHTML = `
    <div class="kpi"><div class="label">Příjmy</div><div class="value">${money(income)}</div></div>
    <div class="kpi"><div class="label">Spoření</div><div class="value">${money(saving)}</div></div>
    <div class="kpi"><div class="label"><span class="dot nec1"></span>Nutné výdaje</div><div class="value">${money(nec)}</div>
      <div class="sub">${pct(nec)} % výdajů</div></div>
    <div class="kpi"><div class="label"><span class="dot nec0"></span>Volitelné výdaje</div><div class="value">${money(opt)}</div>
      <div class="sub">${pct(opt)} % výdajů</div></div>
    <div class="split-bar" title="Nutné ${pct(nec)} % · Volitelné ${pct(opt)} %">
      ${exp > 0 ? `<div class="nec1" style="width:${pct(nec)}%"></div><div class="nec0" style="width:${100 - pct(nec)}%"></div>` : ""}
    </div>
    <div class="kpi big"><div class="label">Zůstatek období (příjmy − výdaje − spoření)</div>
      <div class="value ${balance >= 0 ? "pos" : "neg"}">${balance >= 0 ? "" : "−"}${money(Math.abs(balance))}</div>
      <div class="sub">Výdaje celkem ${money(exp)} · denní útrata ${money(daily)} · fixní platby ${money(fixed)}${
        sum.avg_periods ? ` · denní útrata ${diff >= 0 ? "o " + money(diff) + " vyšší" : "o " + money(-diff) + " nižší"} než Ø` : ""}</div></div>`;

  // pravidelné platby, které v období chybí
  const missing = state.meta.recurring.filter(r => r.active && !by(r.category_id));
  const banner = $("#recurringBanner");
  banner.innerHTML = "";
  if (missing.length) {
    const total = missing.reduce((a, r) => a + r.amount, 0);
    banner.innerHTML = `<div class="banner"><span>Nezapsané pravidelné platby: <b>${missing.length}</b> (${money(total)})</span>
      <span><button class="small" data-act="apply">Zapsat</button> <button class="small ghost" data-act="edit">Upravit šablony</button></span></div>`;
    $('[data-act="apply"]', banner).onclick = async () => {
      const r = await api("POST", "/api/recurring/apply", { period: p });
      toast(`Zapsáno ${r.added} pravidelných plateb`);
      renderOverview();
    };
    $('[data-act="edit"]', banner).onclick = () => showView("recurring");
  }

  // pruhy kategorií
  const sections = [
    ["Denní útrata", c => c.type === "expense" && !c.fixed],
    ["Fixní platby a spoření", c => (c.type === "expense" && c.fixed) || c.type === "saving"],
  ];
  $("#catBars").innerHTML = sections.map(([title, pred]) => {
    const cs = [...state.cats.values()].filter(pred)
      .filter(c => by(c.id) || (!c.archived && avg(c.id)))
      .sort((a, b) => by(b.id) - by(a.id) || avg(b.id) - avg(a.id));
    if (!cs.length) return "";
    const max = Math.max(1, ...cs.map(c => Math.max(by(c.id), avg(c.id))));
    const total = cs.reduce((a, c) => a + by(c.id), 0);
    return `<div class="cat-section"><div class="cat-section-title"><span>${title}</span><span>${money(total)}</span></div>` +
      cs.map(c => {
        const v = by(c.id), a = avg(c.id);
        return `<div class="cat-row" data-cat="${c.id}" data-tip="${esc(c.name)}|${v}|${a}">
          <div class="name">${esc(c.name)}</div>
          <div class="track"><div class="fill" style="width:${Math.max(0, v) / max * 100}%"></div>
            ${a ? `<div class="avg" style="left:calc(${a / max * 100}% - 1px)"></div>` : ""}</div>
          <div class="val">${money(v, false)}</div></div>`;
      }).join("") + "</div>";
  }).join("") || '<div class="empty">Žádné výdaje.</div>';
  $$("#catBars .cat-row").forEach(row => {
    row.onclick = () => openTransactions({ from, to, category: row.dataset.cat });
    const [name, v, a] = row.dataset.tip.split("|");
    bindTooltip(row, () => `<div class="t-title">${esc(name)}</div>
      <div class="t-row"><span>${periodLabel(p)}</span><b>${money(+v)}</b></div>
      <div class="t-row"><span>Ø 12 období</span><span>${money(+a)}</span></div>`);
  });

  // seznam záznamů
  const list = $("#periodList");
  list.innerHTML = "";
  if (!txs.items.length) list.innerHTML = '<div class="empty">V tomto období zatím nic.</div>';
  for (const tx of txs.items) {
    const row = document.createElement("div");
    row.className = "tx-item";
    const sign = tx.type === "income" ? "+" : "";
    row.innerHTML = `<span class="d">${fmtDate(tx.date, false)}</span>
      <span>${necDot(tx)}<span class="c">${esc(tx.category)}</span> ${tx.note ? `<span class="n">· ${esc(tx.note)}</span>` : ""}</span>
      <span class="a ${tx.type === "income" ? "pos" : ""}">${sign}${money(tx.amount, false)}</span>`;
    row.appendChild(txActions(tx));
    list.appendChild(row);
  }
  $("#showAllPeriod").onclick = () => openTransactions({ from, to });
}

/* ================================================================ transactions view */
function fillCatSelect(sel, { withAll = true } = {}) {
  const groups = [["Příjmy", "income"], ["Výdaje", "expense"], ["Spoření", "saving"]];
  sel.innerHTML = (withAll ? '<option value="">Všechny</option>' : "") + groups.map(([label, t]) =>
    `<optgroup label="${label}">` + catsOf(t, { includeArchived: true })
      .map(c => `<option value="${c.id}">${esc(c.name)}${c.archived ? " (archiv)" : ""}</option>`).join("") + "</optgroup>"
  ).join("");
}
/* Výběr měsíce: období s daty (od nejnovějšího). Rozsah přes víc měsíců (ze Statistik)
   se zobrazí jako dočasná volba „vlastní“. */
function fillPeriodSelect(custom) {
  const sel = $("#fPeriod");
  const dr = state.meta.data_range;
  const sd = Number(state.meta.settings.period_start_day);
  const periodOfIso = iso => {
    const [y, m, d] = iso.split("-").map(Number);
    return d >= sd ? `${y}-${String(m).padStart(2, "0")}` : shiftPeriod(`${y}-${String(m).padStart(2, "0")}`, -1);
  };
  let p = state.meta.current_period;
  const lastData = dr.max ? periodOfIso(dr.max) : p;
  if (lastData > p) p = lastData;
  const first = dr.min ? periodOfIso(dr.min) : state.meta.current_period;
  const opts = [];
  for (; p >= first; p = shiftPeriod(p, -1)) opts.push(p);
  sel.innerHTML = '<option value="">Všechny měsíce</option>' +
    (custom ? `<option value="custom">${esc(custom.label)}</option>` : "") +
    opts.map(x => `<option value="${x}">${periodLabel(x)}</option>`).join("");
}
function openTransactions({ from = "", to = "", category = "", q = "", necessary = "", label = "" } = {}) {
  state.txCustom = null;
  fillPeriodSelect(null);
  let value = "";
  if (from || to) {
    const p = from && $$("#fPeriod option").map(o => o.value).find(v => /^\d{4}-\d{2}$/.test(v) &&
      periodRange(v).from === from && periodRange(v).to === to);
    if (p) value = p;
    else {
      state.txCustom = { from, to, label: label || `${from ? fmtDate(from) : "…"} – ${to ? fmtDate(to) : "…"}` };
      value = "custom";
    }
  }
  fillPeriodSelect(state.txCustom);
  $("#fPeriod").value = value; $("#fCat").value = category; $("#fQ").value = q;
  $("#fNec").value = necessary;
  state.txLimit = 300;
  showView("transactions");
}
async function renderTransactions() {
  const params = new URLSearchParams();
  const pv = $("#fPeriod").value;
  const range = pv === "custom" && state.txCustom ? state.txCustom : pv ? periodRange(pv) : null;
  if (range?.from) params.set("from", range.from);
  if (range?.to) params.set("to", range.to);
  if ($("#fCat").value) params.set("category", $("#fCat").value);
  if ($("#fQ").value.trim()) params.set("q", $("#fQ").value.trim());
  if ($("#fNec").value) params.set("necessary", $("#fNec").value);
  params.set("limit", state.txLimit);
  const data = await api("GET", `/api/transactions?${params}`);
  $("#txTotals").innerHTML = `<span>Záznamů: <b>${nf0.format(data.count)}</b></span>
    <span>Příjmy: <b>${money(data.income)}</b></span>
    <span>Výdaje: <b>${money(data.expense)}</b></span>
    <span><span class="dot nec1"></span>Nutné: <b>${money(data.necessary)}</b></span>
    <span><span class="dot nec0"></span>Volitelné: <b>${money(data.optional)}</b></span>
    ${data.saving ? `<span>Spoření: <b>${money(data.saving)}</b></span>` : ""}`;
  const tbody = $("#txTable tbody");
  tbody.innerHTML = "";
  if (!data.items.length) tbody.innerHTML = '<tr><td colspan="6" class="empty">Nic nenalezeno.</td></tr>';
  for (const tx of data.items) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="num" style="text-align:left">${fmtDate(tx.date)}</td><td>${esc(tx.category)}</td>
      <td>${tx.type === "expense" ? necDot(tx) + (tx.necessary ? "nutná" : "volitelná") : ""}</td>
      <td>${esc(tx.note)}</td><td class="num ${tx.type === "income" ? "pos" : ""}">${money(tx.amount)}</td><td></td>`;
    tr.lastElementChild.appendChild(txActions(tx));
    tbody.appendChild(tr);
  }
  const more = $("#txMore");
  more.hidden = data.items.length >= data.count;
  more.textContent = `Načíst další (zobrazeno ${data.items.length} z ${nf0.format(data.count)})`;
}

/* ================================================================ charts */
function bindTooltip(el, html) {
  const tip = $("#tooltip");
  el.addEventListener("mousemove", e => {
    tip.innerHTML = html();
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    let x = e.clientX + 14, y = e.clientY + 14;
    if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 14;
    if (y + r.height > innerHeight - 8) y = e.clientY - r.height - 14;
    tip.style.left = x + "px"; tip.style.top = y + "px";
  });
  el.addEventListener("mouseleave", () => (tip.hidden = true));
}
function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
function roundedTop(x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}
/**
 * Sloupcový graf v SVG. series: [{name, color, values[]}], stacked = skládaný.
 */
function barChart(el, { labels, titles, series, stacked = false, onClick }) {
  const W = Math.max(320, el.clientWidth), H = 280;
  const m = { l: 62, r: 8, t: 8, b: 26 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const n = labels.length;
  const totals = labels.map((_, i) => series.reduce((a, s) => a + Math.max(0, s.values[i] || 0), 0));
  const maxV = stacked ? Math.max(...totals) : Math.max(...series.flatMap(s => s.values.map(v => v || 0)));
  const ymax = niceMax(maxV);
  const y = v => m.t + ih - (v / ymax) * ih;
  const gw = iw / n;
  let svg = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img">`;
  for (let k = 0; k <= 4; k++) {
    const v = ymax * k / 4, yy = y(v);
    svg += `<line class="${k ? "gridline" : "baseline"}" x1="${m.l}" x2="${W - m.r}" y1="${yy}" y2="${yy}"/>`;
    svg += `<text x="${m.l - 8}" y="${yy + 4}" text-anchor="end">${compact(v)}</text>`;
  }
  const every = Math.ceil(n / Math.max(1, Math.floor(iw / 56)));
  labels.forEach((lab, i) => {
    const cx = m.l + gw * i + gw / 2;
    if (i % every === 0) svg += `<text x="${cx}" y="${H - 8}" text-anchor="middle">${esc(lab)}</text>`;
    if (stacked) {
      const bw = Math.min(44, gw * 0.66);
      let acc = 0;
      const vis = series.filter(s => (s.values[i] || 0) > 0);
      vis.forEach((s, si) => {
        const v = s.values[i];
        const y0 = y(acc), y1 = y(acc + v);
        const h = y0 - y1;
        const x = cx - bw / 2;
        svg += si === vis.length - 1
          ? `<path class="bar" d="${roundedTop(x, y1, bw, h, 4)}" fill="${s.color}"/>`
          : `<rect class="bar" x="${x}" y="${y1}" width="${bw}" height="${h}" fill="${s.color}"/>`;
        acc += v;
      });
    } else {
      const k = series.length;
      const bw = Math.min(26, (gw * 0.78 - (k - 1) * 2) / k);
      const start = cx - (bw * k + (k - 1) * 2) / 2;
      series.forEach((s, si) => {
        const v = Math.max(0, s.values[i] || 0);
        if (!v) return;
        svg += `<path class="bar" d="${roundedTop(start + si * (bw + 2), y(v), bw, y(0) - y(v), 4)}" fill="${s.color}"/>`;
      });
    }
    svg += `<rect class="hit" data-i="${i}" x="${m.l + gw * i}" y="${m.t}" width="${gw}" height="${ih}"/>`;
  });
  svg += "</svg>";
  const legend = `<div class="legend">${series.map(s => `<span><span class="sw" style="background:${s.color}"></span>${esc(s.name)}</span>`).join("")}</div>`;
  el.innerHTML = legend + svg;
  $$(".hit", el).forEach(h => {
    const i = Number(h.dataset.i);
    bindTooltip(h, () => {
      const rows = series.filter(s => s.values[i]).slice().reverse()
        .map(s => `<div class="t-row"><span><span class="sw" style="background:${s.color}"></span>${esc(s.name)}</span><span>${money(s.values[i])}</span></div>`).join("");
      const tot = stacked ? `<div class="t-row" style="border-top:1px solid var(--grid);margin-top:4px;padding-top:4px"><b>Celkem</b><b>${money(totals[i])}</b></div>` : "";
      return `<div class="t-title">${esc(titles[i])}</div>${rows || '<div class="muted">bez záznamů</div>'}${tot}`;
    });
    if (onClick) { h.style.cursor = "pointer"; h.onclick = () => onClick(i); }
  });
}

/* ================================================================ stats */
async function renderStats() {
  const range = state.statRange;
  const scope = $("#statScope").value;
  let url, keys;
  if (range === "years") {
    url = "/api/stats?group=year";
  } else {
    const n = Number(range);
    keys = Array.from({ length: n }, (_, i) => shiftPeriod(state.meta.current_period, i - n + 1));
    url = `/api/stats?group=period&from=${periodRange(keys[0]).from}&to=${periodRange(keys[n - 1]).to}`;
  }
  const data = await api("GET", url);
  if (!keys) keys = Object.keys(data.buckets);
  const val = (k, cid) => data.buckets[k]?.[cid] || 0;
  const cats = [...state.cats.values()];
  const sumWhere = (k, pred) => cats.filter(pred).reduce((a, c) => a + val(k, c.id), 0);
  const labels = keys.map(k => k.length === 4 ? k : `${k.slice(5)}/${k.slice(2, 4)}`);
  const titles = keys.map(periodLabel);
  const rangeOf = k => k.length === 4
    ? { from: periodRange(`${k}-01`).from, to: periodRange(`${k}-12`).to, label: `Rok ${k}` } : periodRange(k);

  barChart($("#chartBalance"), {
    labels, titles,
    series: [
      { name: "Příjmy", color: SERIES[0], values: keys.map(k => sumWhere(k, c => c.type === "income")) },
      { name: "Nutné výdaje", color: SERIES[1], values: keys.map(k => data.necessity[k]?.["1"] || 0) },
      { name: "Volitelné výdaje", color: SERIES[2], values: keys.map(k => data.necessity[k]?.["0"] || 0) },
      { name: "Spoření", color: SERIES[3], values: keys.map(k => sumWhere(k, c => c.type === "saving")) },
    ],
    onClick: i => openTransactions(rangeOf(keys[i])),
  });

  const inScope = c => c.type === "expense" && (scope === "all" || (scope === "fixed" ? c.fixed : !c.fixed));
  const scoped = cats.filter(inScope)
    .map(c => ({ c, total: keys.reduce((a, k) => a + val(k, c.id), 0) }))
    .filter(x => x.total > 0)
    .sort((a, b) => b.total - a.total);
  const top = scoped.slice(0, 7).sort((a, b) => a.c.sort - b.c.sort);
  const rest = scoped.slice(7);
  const series = top.map((x, i) => ({ name: x.c.name, color: SERIES[i], values: keys.map(k => val(k, x.c.id)) }));
  if (rest.length) series.push({ name: "Ostatní kategorie", color: "var(--other)", values: keys.map(k => rest.reduce((a, x) => a + val(k, x.c.id), 0)) });
  barChart($("#chartStack"), {
    labels, titles, series, stacked: true,
    onClick: i => openTransactions(rangeOf(keys[i])),
  });

  // pivot
  const colorOf = new Map(top.map((x, i) => [x.c.id, SERIES[i]]));
  const nb = keys.length;
  let html = `<table class="data pivot"><thead><tr><th>Kategorie</th>${labels.map((l, i) => `<th class="num" title="${esc(titles[i])}">${esc(l)}</th>`).join("")}<th class="num">Celkem</th><th class="num">Ø</th></tr></thead><tbody>`;
  for (const { c, total } of scoped) {
    html += `<tr><td><span class="swatch" style="background:${colorOf.get(c.id) || "var(--other)"}"></span>${esc(c.name)}</td>` +
      keys.map(k => `<td class="num">${val(k, c.id) ? nf0.format(val(k, c.id)) : ""}</td>`).join("") +
      `<td class="num"><b>${nf0.format(total)}</b></td><td class="num">${nf0.format(total / nb)}</td></tr>`;
  }
  const colTotals = keys.map(k => scoped.reduce((a, x) => a + val(k, x.c.id), 0));
  const grand = colTotals.reduce((a, b) => a + b, 0);
  html += `</tbody><tfoot><tr><td>Celkem</td>${colTotals.map(v => `<td class="num">${nf0.format(v)}</td>`).join("")}<td class="num">${nf0.format(grand)}</td><td class="num">${nf0.format(grand / nb)}</td></tr></tfoot></table>`;
  $("#pivot").innerHTML = scoped.length ? html : '<div class="empty">Žádná data.</div>';

  // poznámky
  const r0 = rangeOf(keys[0]), r1 = rangeOf(keys[keys.length - 1]);
  const notes = await api("GET", `/api/notes?from=${r0.from}&to=${r1.to}`);
  $("#noteStats").innerHTML = notes.map(n =>
    `<div class="note-row" data-note="${esc(n.note)}"><span>${esc(n.note)}</span><span class="cnt">${n.n}×</span><span class="num">${money(n.total)}</span></div>`
  ).join("") || '<div class="empty">Žádné poznámky.</div>';
  $$("#noteStats .note-row").forEach(row =>
    row.onclick = () => openTransactions({ from: r0.from, to: r1.to, q: row.dataset.note,
      label: keys.length > 1 ? `${titles[0]} – ${titles[keys.length - 1]}` : titles[0] }));
}

/* ================================================================ year */
let annualKind = "expense";
async function renderYear() {
  if (!state.year) state.year = Number(state.meta.current_period.slice(0, 4));
  const y = await api("GET", `/api/year?year=${state.year}`);
  const first = periodRange(`${y.year}-01`), last = periodRange(`${y.year}-12`);
  $("#yearTitle").textContent = `Rok ${y.year}`;
  $("#yearRange").textContent = `${fmtDate(first.from)} – ${fmtDate(last.to)} (období Leden–Prosinec)`;
  $("#prevYear").disabled = y.year <= Math.min(...y.years);
  $("#nextYear").disabled = y.year >= Math.max(...y.years, Number(state.meta.current_period.slice(0, 4)));

  // běžné hospodaření
  const used = y.months.filter(m => m.has_data);
  const sum = k => used.reduce((a, m) => a + m[k], 0);
  const regular = sum("balance");
  const signed = v => `${v < 0 ? "−" : ""}${money(Math.abs(v))}`;
  const yearBalance = regular + y.extra_income - y.extra_expense;
  $("#yearBalance").innerHTML = `
    <div class="l-row"><span class="op"></span><span>Zůstatek z běžných měsíců</span><span class="v">${signed(regular)}</span>
      <span class="sub">${used.length} období · příjmy ${money(sum("income"))} · nutné ${money(sum("necessary"))} · volitelné ${money(sum("optional"))} · spoření ${money(sum("saving"))}</span></div>
    <div class="l-row"><span class="op">+</span><span>Mimořádné příjmy</span><span class="v pos">${money(y.extra_income)}</span></div>
    <div class="l-row"><span class="op">−</span><span>Mimořádné výdaje</span><span class="v neg">${money(y.extra_expense)}</span></div>
    <div class="l-row total"><span class="op">=</span><span>Roční bilance</span>
      <span class="v ${yearBalance >= 0 ? "pos" : "neg"}">${signed(yearBalance)}</span>
      <span class="sub">Všechny příjmy − výdaje − spoření za rok, včetně mimořádných položek</span></div>`;

  // mimořádné položky
  $("#annualNames").innerHTML = y.names.map(n => `<option value="${esc(n)}">`).join("");
  const host = $("#annualLists");
  host.innerHTML = "";
  for (const [kind, title, total] of [["income", "Mimořádné příjmy", y.extra_income], ["expense", "Mimořádné výdaje", y.extra_expense]]) {
    const list = y.items.filter(i => i.kind === kind);
    const g = document.createElement("div");
    g.className = "annual-group";
    g.innerHTML = `<h3><span>${title}</span><span>${money(total)}</span></h3>` +
      (list.length ? "" : '<div class="empty" style="padding:8px 0">Žádné.</div>');
    for (const it of list) g.appendChild(annualRow(it));
    host.appendChild(g);
  }

  // měsíce
  const row = (label, m, cls = "") => `<tr class="${cls}"><td>${label}</td>
    <td class="num">${money(m.income, false)}</td><td class="num">${money(m.necessary, false)}</td>
    <td class="num">${money(m.optional, false)}</td><td class="num">${money(m.saving, false)}</td>
    <td class="num ${m.balance >= 0 ? "pos" : "neg"}">${signed(m.balance).replace(/\s*Kč$/, "")}</td></tr>`;
  $("#yearMonths").innerHTML = `<table class="data"><thead><tr><th>Období</th><th class="num">Příjmy</th>
    <th class="num"><span class="dot nec1"></span>Nutné</th><th class="num"><span class="dot nec0"></span>Volitelné</th>
    <th class="num">Spoření</th><th class="num">Zůstatek</th></tr></thead><tbody>` +
    y.months.map(m => row(periodLabel(m.period), m, m.has_data ? "" : "empty-month")).join("") +
    `</tbody><tfoot>${row("Celkem", { income: sum("income"), necessary: sum("necessary"), optional: sum("optional"), saving: sum("saving"), balance: regular })}</tfoot></table>`;
  $$("#yearMonths tbody tr").forEach((tr, i) => {
    tr.style.cursor = "pointer";
    tr.onclick = () => { state.period = y.months[i].period; showView("overview"); };
  });
}

function annualRow(it) {
  const el = document.createElement("div");
  el.className = "annual-row";
  el.innerHTML = `<span><span class="nm">${esc(it.name)}</span>${it.note ? `<br><span class="nt">${esc(it.note)}</span>` : ""}</span>
    <span class="a">${money(it.amount)}</span>`;
  const acts = document.createElement("span");
  acts.className = "row-actions";
  acts.innerHTML = '<button title="Upravit">✎</button><button title="Smazat">🗑</button>';
  acts.children[0].onclick = () => editAnnual(el, it);
  acts.children[1].onclick = async () => {
    await api("DELETE", `/api/annual/${it.id}`);
    renderYear();
    toast(`Smazáno: ${it.name} ${money(it.amount)}`, {
      label: "Vrátit",
      run: async () => { await api("POST", "/api/annual", it); renderYear(); },
    });
  };
  el.appendChild(acts);
  return el;
}

function editAnnual(el, it) {
  el.innerHTML = `<form class="annual-form" style="grid-column:1/-1">
    <select name="kind"><option value="expense">Výdaj</option><option value="income">Příjem</option></select>
    <input name="name" list="annualNames" value="${esc(it.name)}">
    <input name="amount" inputmode="decimal" value="${String(it.amount).replace(".", ",")}">
    <input name="note" value="${esc(it.note)}" placeholder="Poznámka">
    <span><button type="submit" class="small">Uložit</button> <button type="button" class="small ghost">Zrušit</button></span>
  </form>`;
  const f = $("form", el);
  f.elements.kind.value = it.kind;
  f.querySelector("button.ghost").onclick = () => renderYear();
  f.onsubmit = async e => {
    e.preventDefault();
    const amount = parseAmount(f.elements.amount.value);
    if (!Number.isFinite(amount)) { toast("Neplatná částka"); return; }
    try {
      await api("PUT", `/api/annual/${it.id}`, { year: it.year, kind: f.elements.kind.value,
        name: f.elements.name.value, amount, note: f.elements.note.value });
      renderYear();
    } catch (ex) { toast(ex.message); }
  };
  f.elements.amount.focus();
}

/* ================================================================ recurring */
async function renderRecurring() {
  const tbody = $("#recTable tbody");
  tbody.innerHTML = "";
  const opts = cid => ["expense", "saving", "income"].map(t =>
    `<optgroup label="${TYPE_LABEL[t]}">` + catsOf(t, { includeArchived: true }).map(c =>
      `<option value="${c.id}" ${c.id === cid ? "selected" : ""}>${esc(c.name)}</option>`).join("") + "</optgroup>").join("");
  let total = 0;
  for (const r of state.meta.recurring) {
    if (r.active) total += r.amount;
    const tr = document.createElement("tr");
    tr.innerHTML = `<td><select>${opts(r.category_id)}</select></td>
      <td><input value="${esc(r.note)}" placeholder="—"></td>
      <td class="num"><input value="${String(r.amount).replace(".", ",")}" inputmode="decimal" style="width:8em;text-align:right"></td>
      <td><input type="checkbox" ${r.active ? "checked" : ""}></td>
      <td><span class="row-actions"><button title="Smazat">🗑</button></span></td>`;
    const [sel, note, amount, active] = $$("select, input", tr);
    const save = async () => {
      const a = parseAmount(amount.value);
      if (!Number.isFinite(a)) { toast("Neplatná částka"); return; }
      await api("PUT", `/api/recurring/${r.id}`, { category_id: Number(sel.value), note: note.value, amount: a, active: active.checked });
      await loadMeta(); renderRecurring();
    };
    [sel, note, amount, active].forEach(x => x.addEventListener("change", save));
    $("button", tr).onclick = async () => {
      if (!confirm("Smazat tuto šablonu?")) return;
      await api("DELETE", `/api/recurring/${r.id}`); await loadMeta(); renderRecurring();
    };
    tbody.appendChild(tr);
  }
  if (!state.meta.recurring.length) tbody.innerHTML = '<tr><td colspan="5" class="empty">Zatím žádné šablony.</td></tr>';
  $("#recTable tfoot").innerHTML = `<tr><td colspan="2">Celkem aktivní</td><td class="num">${money(total)}</td><td colspan="2"></td></tr>`;
  $("#recApply").textContent = `Zapsat do období ${periodLabel(state.meta.current_period)}`;
}

/* ================================================================ settings */
async function renderSettings() {
  $("#setStartDay").value = state.meta.settings.period_start_day;
  const dr = state.meta.data_range;
  $("#dataInfo").textContent = dr.count ? `V databázi je ${nf0.format(dr.count)} záznamů (${fmtDate(dr.min)} – ${fmtDate(dr.max)}).` : "Databáze je prázdná.";
  const tbody = $("#catTable tbody");
  tbody.innerHTML = "";
  const all = [...state.cats.values()].sort((a, b) =>
    ["income", "expense", "saving"].indexOf(a.type) - ["income", "expense", "saving"].indexOf(b.type) ||
    a.archived - b.archived || a.fixed - b.fixed || a.sort - b.sort);
  for (const c of all) {
    const tr = document.createElement("tr");
    if (c.archived) tr.className = "archived";
    tr.innerHTML = `<td><input value="${esc(c.name)}" style="width:12em"></td>
      <td><select>${Object.entries(TYPE_LABEL).map(([k, v]) => `<option value="${k}" ${k === c.type ? "selected" : ""}>${v}</option>`).join("")}</select></td>
      <td><input type="checkbox" ${c.fixed ? "checked" : ""} title="Fixní měsíční platba"></td>
      <td><input type="checkbox" ${c.archived ? "checked" : ""} title="Archivovat"></td>
      <td><input type="checkbox" ${c.necessary ? "checked" : ""} title="Nové platby budou předvyplněné jako nutné" ${c.type === "expense" ? "" : "hidden"}></td>
      <td><input type="checkbox" ${c.note_required ? "checked" : ""} title="Při zadání vyžadovat poznámku"></td>
      <td class="num">${nf0.format(c.tx_count)}</td>
      <td><select data-role="merge"><option value="">—</option>${all.filter(o => o.id !== c.id && o.type === c.type)
        .map(o => `<option value="${o.id}">${esc(o.name)}</option>`).join("")}</select></td>
      <td>${c.tx_count ? "" : '<span class="row-actions"><button title="Smazat">🗑</button></span>'}</td>`;
    const [name, type, fixed, archived, necessary, noteReq] = $$("input, select", tr);
    const save = async () => {
      try {
        await api("PUT", `/api/categories/${c.id}`, {
          name: name.value, type: type.value, fixed: fixed.checked, archived: archived.checked,
          necessary: necessary.checked, note_required: noteReq.checked,
        });
      } catch (ex) { toast(ex.message); }
      await loadMeta(); renderSettings();
    };
    [name, type, fixed, archived, necessary, noteReq].forEach(x => x.addEventListener("change", save));
    $('[data-role="merge"]', tr).onchange = async e => {
      const into = state.cats.get(Number(e.target.value));
      if (!into) return;
      if (!confirm(`Přesunout všech ${c.tx_count} záznamů z „${c.name}“ do „${into.name}“ a kategorii „${c.name}“ odstranit?`)) { e.target.value = ""; return; }
      const r = await api("POST", `/api/categories/${c.id}/merge`, { into: into.id });
      toast(`Přesunuto ${r.moved} záznamů`);
      await loadMeta(); renderSettings();
    };
    const del = $("button", tr);
    if (del) del.onclick = async () => {
      try { await api("DELETE", `/api/categories/${c.id}`); } catch (ex) { toast(ex.message); }
      await loadMeta(); renderSettings();
    };
    tbody.appendChild(tr);
  }
}

/* ================================================================ routing */
const RENDER = {
  overview: renderOverview, transactions: renderTransactions, stats: renderStats, year: renderYear,
  recurring: renderRecurring, settings: renderSettings,
};
let currentView = "overview";
function showView(name) {
  currentView = name;
  $$(".tabs button").forEach(b => b.classList.toggle("active", b.dataset.view === name));
  $$(".view").forEach(v => v.classList.toggle("active", v.id === `view-${name}`));
  try { localStorage.setItem("ct.view", name); } catch { /* ignore */ }
  scrollTo(0, 0);
  refreshCurrent();
}
async function refreshCurrent() {
  try {
    await loadMeta();
    if (currentView === "transactions") fillCatSelectKeep();
    await RENDER[currentView]();
  } catch (ex) {
    toast("Chyba: " + ex.message);
    console.error(ex);
  }
}
function fillCatSelectKeep() {
  const sel = $("#fCat"), v = sel.value;
  fillCatSelect(sel);
  sel.value = v;
  const ps = $("#fPeriod"), pv = ps.value;
  fillPeriodSelect(state.txCustom);
  ps.value = pv;
}

function wire() {
  $$(".tabs button").forEach(b => (b.onclick = () => showView(b.dataset.view)));
  $("#prevPeriod").onclick = () => { state.period = shiftPeriod(state.period, -1); renderOverview(); };
  $("#nextPeriod").onclick = () => { state.period = shiftPeriod(state.period, 1); renderOverview(); };
  $("#todayPeriod").onclick = () => { state.period = state.meta.current_period; renderOverview(); };

  let debounce;
  const reloadTx = () => { state.txLimit = 300; clearTimeout(debounce); debounce = setTimeout(renderTransactions, 200); };
  ["#fPeriod", "#fCat", "#fNec"].forEach(s => $(s).addEventListener("change", reloadTx));
  $("#fPeriod").addEventListener("change", e => {
    if (e.target.value !== "custom" && state.txCustom) {   // vlastní rozsah po změně zmizí
      const v = e.target.value;
      state.txCustom = null;
      fillPeriodSelect(null);
      e.target.value = v;
    }
  });
  $("#fQ").addEventListener("input", reloadTx);
  $("#fReset").onclick = () => openTransactions();
  $("#txMore").onclick = () => { state.txLimit += 500; renderTransactions(); };

  $$("#statRange button").forEach(b => b.onclick = () => {
    state.statRange = b.dataset.range;
    $$("#statRange button").forEach(x => x.classList.toggle("active", x === b));
    renderStats();
  });
  $("#statScope").onchange = renderStats;

  $("#prevYear").onclick = () => { state.year--; renderYear(); };
  $("#nextYear").onclick = () => { state.year++; renderYear(); };
  $$("#annualKind button").forEach(b => b.onclick = () => {
    annualKind = b.dataset.kind;
    $$("#annualKind button").forEach(x => x.classList.toggle("active", x === b));
  });
  $("#annualForm").onsubmit = async e => {
    e.preventDefault();
    const f = e.target, err = $("#annualErr");
    err.textContent = "";
    const amount = parseAmount(f.elements.amount.value);
    if (!Number.isFinite(amount) || amount === 0) { err.textContent = "Zadejte částku."; f.elements.amount.focus(); return; }
    try {
      await api("POST", "/api/annual", { year: state.year, kind: annualKind, name: f.elements.name.value,
        amount, note: f.elements.note.value });
    } catch (ex) { err.textContent = ex.message; return; }
    toast(`Přidáno: ${f.elements.name.value} ${money(amount)}`);
    f.reset();
    f.elements.name.focus();
    renderYear();
  };

  $("#recAdd").onclick = async () => {
    const c = catsOf("expense").find(x => x.fixed) || catsOf("expense")[0];
    await api("POST", "/api/recurring", { category_id: c.id, amount: 0, note: "" });
    await loadMeta(); renderRecurring();
  };
  $("#recApply").onclick = async () => {
    const r = await api("POST", "/api/recurring/apply", { period: state.meta.current_period });
    toast(`Zapsáno ${r.added}, přeskočeno ${r.skipped} (už zapsané)`);
  };

  $("#saveSettings").onclick = async () => {
    try {
      await api("PUT", "/api/settings", { period_start_day: Number($("#setStartDay").value) });
      state.period = null;
      await loadMeta();
      toast("Uloženo");
    } catch (ex) { toast(ex.message); }
  };
  $("#catAdd").onclick = async () => {
    const name = prompt("Název nové kategorie:");
    if (!name) return;
    try {
      await api("POST", "/api/categories", { name, type: "expense" });
      toast("Přidáno jako výdajová kategorie – typ lze změnit v tabulce");
    } catch (ex) { toast(ex.message); }
    await loadMeta(); renderSettings();
  };

  let rt;
  addEventListener("resize", () => {
    clearTimeout(rt);
    rt = setTimeout(() => currentView === "stats" && renderStats(), 200);
  });
  // klávesová zkratka: "n" = nový záznam
  addEventListener("keydown", e => {
    if (e.key === "n" && !e.ctrlKey && !e.metaKey && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) && !$("#editDialog").open) {
      e.preventDefault();
      if (currentView !== "overview") showView("overview");
      setTimeout(() => quickForm && quickForm.focus(), 50);
    }
  });
}

(async function init() {
  wire();
  await loadMeta();
  fillCatSelect($("#fCat"));
  fillPeriodSelect(null);
  let v = "overview";
  try { v = localStorage.getItem("ct.view") || v; } catch { /* ignore */ }
  showView(RENDER[v] ? v : "overview");
})();
