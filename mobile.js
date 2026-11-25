"use strict";
/* Doplňky pro telefonní verzi: zálohy, import dat z PC, export CSV, offline režim. */
(function () {
  const $ = s => document.querySelector(s);
  const LAST = "ct.lastBackup";
  const stamp = () => {
    const d = new Date(), p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const getLast = () => { try { return localStorage.getItem(LAST); } catch { return null; } };
  const setLast = v => { try { localStorage.setItem(LAST, v); } catch { /* ignore */ } };
  const say = msg => (typeof toast === "function" ? toast(msg) : alert(msg));

  function download(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
  async function backupFile() {
    const bytes = await CT_DB.exportBytes();
    return new File([bytes], `cashtracker-${stamp()}.db`, { type: "application/octet-stream" });
  }
  function fmt(iso) { const [y, m, d] = iso.split("-").map(Number); return `${d}. ${m}. ${y}`; }

  function renderBackupInfo() {
    const el = $("#mBackupInfo");
    if (!el) return;
    const last = getLast();
    el.textContent = last ? `Poslední záloha: ${fmt(last)}` : "Záloha zatím nebyla stažena.";
  }
  async function renderAutoBackups() {
    const host = $("#mAutoBackups");
    if (!host) return;
    const keys = await CT_DB.backups();
    host.innerHTML = keys.length ? "" : '<div class="muted small">Zatím žádné.</div>';
    for (const k of keys) {
      const m = /(\d{4}-\d{2}-\d{2})/.exec(k);
      const row = document.createElement("div");
      row.className = "backup-row";
      row.innerHTML = `<span>${m ? fmt(m[1]) : k}${k.startsWith("before-import") ? " · před nahráním dat" : " · automatická"}</span>
        <button class="small ghost">Obnovit</button>`;
      row.querySelector("button").onclick = async () => {
        if (!confirm("Nahradit současná data touto zálohou? Současný stav se uloží jako záloha „před nahráním dat“.")) return;
        try { await CT_DB.restoreBackup(k); say("Obnoveno ze zálohy"); afterImport(); }
        catch (e) { alert(e.message); }
      };
      host.appendChild(row);
    }
  }
  function afterImport() {
    state.period = null;
    refreshCurrent();
    setTimeout(() => { renderBackupInfo(); renderAutoBackups(); }, 300);
  }

  function wire() {
    $("#mBackup").onclick = async () => {
      download(await backupFile(), `cashtracker-${stamp()}.db`);
      setLast(stamp()); renderBackupInfo();
    };
    const share = $("#mShare");
    if (navigator.canShare && navigator.canShare({ files: [new File([""], "x.db", { type: "application/octet-stream" })] })) {
      share.hidden = false;
      share.onclick = async () => {
        try {
          const f = await backupFile();
          await navigator.share({ files: [f], title: f.name });
          setLast(stamp()); renderBackupInfo();
        } catch (e) { if (e.name !== "AbortError") alert("Sdílení se nepovedlo: " + e.message); }
      };
    }
    $("#mCsv").onclick = async () => {
      download(new Blob([await CT_DB.exportCsv()], { type: "text/csv;charset=utf-8" }), `cashtracker-${stamp()}.csv`);
    };
    const file = $("#mImportFile");
    $("#mImport").onclick = () => { file.value = ""; file.click(); };
    file.onchange = async () => {
      const f = file.files[0];
      if (!f) return;
      if (!confirm(`Nahrát data ze souboru „${f.name}“?\n\nVšechna současná data v telefonu se nahradí. Současný stav se předtím uloží jako záloha „před nahráním dat“.`)) return;
      try {
        await CT_DB.importBytes(new Uint8Array(await f.arrayBuffer()));
        say("Data nahrána");
        afterImport();
      } catch (e) { alert("Nahrání se nepovedlo: " + e.message); }
    };
    $("#tabs").addEventListener("click", e => {
      const b = e.target.closest("button");
      if (b) b.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
      if (b && b.dataset.view === "settings") { renderBackupInfo(); renderAutoBackups(); }
    });
    // na dotykovém displeji: tooltip zmizí při dalším dotyku nebo posunu
    const hideTip = () => { const t = $("#tooltip"); if (t) t.hidden = true; };
    addEventListener("touchstart", hideTip, { passive: true });
    addEventListener("scroll", hideTip, { passive: true });
  }

  async function remind() {
    await CT_DB.ready();
    const last = getLast();
    const days = last ? (Date.now() - new Date(last).getTime()) / 864e5 : Infinity;
    const meta = await LOCAL_API("GET", "/api/meta");
    if (meta.data_range.count > 0 && days > 30)
      setTimeout(() => say(last ? "Připomínka: stáhněte si zálohu dat (Nastavení → Data)." :
        "Tip: v Nastavení → Data si stáhněte zálohu."), 1500);
  }

  wire();
  renderBackupInfo();
  renderAutoBackups();
  remind();
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    // nová verze aplikace se po stažení hned načte (jen při aktualizaci, ne při první instalaci)
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (hadController && !reloaded) { reloaded = true; location.reload(); }
    });
    navigator.serviceWorker.register("sw.js").catch(e => console.warn("SW:", e));
  }
})();
