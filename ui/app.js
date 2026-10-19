(() => {
  const MAX_SCAN_LINES = 25;
  // Narrowest bar worth printing. Thinner than this, scanners miss.
  const MIN_MODULE_MM = 0.25;
  const PX_TO_MM = 25.4 / 96;
  const CODE128_MIN = 32;
  const CODE128_MAX = 126;
  const API_MODE = location.protocol === "http:" || location.protocol === "https:";
  const SETTINGS_KEY = "bca-print-settings-v1";
  const ITEMS_KEY = "bca-print-items-v1";

  const viewScan = document.getElementById("viewScan");
  const viewPrint = document.getElementById("viewPrint");

  const scanMeta = document.getElementById("scanMeta");
  const scanWarn = document.getElementById("scanWarn");
  const scanError = document.getElementById("scanError");
  const scanList = document.getElementById("scanList");

  const printMeta = document.getElementById("printMeta");
  const printBtn = document.getElementById("printBtn");
  const importBtn = document.getElementById("importBtn");
  const paperSelect = document.getElementById("paperSelect");
  const columnsSelect = document.getElementById("columnsSelect");
  const columnsGroup = document.getElementById("columnsGroup");
  const orientSelect = document.getElementById("orientSelect");
  const perPageInput = document.getElementById("perPageInput");
  const perPageDown = document.getElementById("perPageDown");
  const perPageUp = document.getElementById("perPageUp");
  const pageCountEl = document.getElementById("pageCount");
  const pageTitleInput = document.getElementById("pageTitleInput");
  const footerInput = document.getElementById("footerInput");
  const showTitlesToggle = document.getElementById("showTitlesToggle");
  const vCenterToggle = document.getElementById("vCenterToggle");
  const sizeModeSelect = document.getElementById("sizeModeSelect");
  const paperHint = document.getElementById("paperHint");
  const editorList = document.getElementById("editorList");
  const previewEl = document.getElementById("preview");
  const previewTip = document.getElementById("previewTip");
  const addBtn = document.getElementById("addBtn");
  const clearBtn = document.getElementById("clearBtn");

  const importModal = document.getElementById("importModal");
  const importText = document.getElementById("importText");
  const importReplaceToggle = document.getElementById("importReplaceToggle");
  const importApplyBtn = document.getElementById("importApplyBtn");

  let useLocalApi = false;
  let lastId = -1;
  let nextItemId = 1;
  let printItems = [];
  let dragFromId = null;
  let focusItemId = null;
  let focusField = "text";
  // Printed module width for the current Fit-to-paper layout, keyed by code length.
  let fitModuleMm = new Map();

  document.querySelectorAll("[data-hide]").forEach((btn) => {
    btn.addEventListener("click", requestHide);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !e.ctrlKey && !e.shiftKey && !e.altKey) {
      if (!importModal.hidden) {
        closeImport();
        return;
      }
      requestHide();
    }
  });

  function requestHide() {
    if (!useLocalApi) {
      if (!API_MODE) window.close();
      return;
    }
    fetch("/api/hide", { method: "POST", cache: "no-store" }).catch(() => {});
  }

  function splitLines(raw) {
    return String(raw ?? "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, " ")
      .replace(/\u000b/g, " ")
      .replace(/\u2028/g, "\n")
      .replace(/\u2029/g, "\n")
      .split("\n")
      .map((line) => line.replace(/\t/g, " ").replace(/[ \t]+$/g, "").replace(/^[ \t]+/g, ""))
      .filter((line) => line.length > 0);
  }

  function parseImportLine(line) {
    const raw = String(line ?? "").trim();
    if (!raw) return null;
    const pipe = raw.split("|");
    if (pipe.length >= 2) {
      const title = pipe[0].trim();
      const text = pipe.slice(1).join("|").trim();
      if (text) return { title, text };
    }
    const tab = raw.split("\t");
    if (tab.length >= 2) {
      const title = tab[0].trim();
      const text = tab.slice(1).join("\t").trim();
      if (text) return { title, text };
    }
    return { title: "", text: raw };
  }

  function findBadChars(text) {
    const bad = [];
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code < CODE128_MIN || code > CODE128_MAX) {
        bad.push({ char: text[i], code });
      }
    }
    return bad;
  }

  function barcodeWidth(len) {
    if (len > 36) return 1.3;
    if (len > 24) return 1.6;
    return 2;
  }

  function encodeLine(line) {
    const bad = findBadChars(line);
    if (bad.length) {
      const samples = bad
        .slice(0, 5)
        .map((b) => `"${b.char}"`)
        .join(", ");
      return {
        ok: false,
        label: line,
        message: `Can't encode ${bad.length} character(s) (e.g. ${samples}).`,
      };
    }

    return { ok: true, label: line, value: line };
  }

  function setMode(mode) {
    const isPrint = mode === "print";
    viewScan.hidden = isPrint;
    viewPrint.hidden = !isPrint;
    document.body.classList.toggle("mode-print", isPrint);
    document.body.classList.toggle("mode-scan", !isPrint);
  }

  function getPaper() {
    return paperSelect.value === "zebra105" ? "zebra105" : "a4";
  }

  function getColumns() {
    const n = Number(columnsSelect.value);
    if (n >= 1 && n <= 4) return n;
    return 2;
  }

  function getOrientation() {
    return orientSelect.value === "landscape" ? "landscape" : "portrait";
  }

  function getPerPage() {
    const n = Number(perPageInput.value);
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.min(40, Math.floor(n));
  }

  function showTitles() {
    return !!showTitlesToggle.checked;
  }

  function vCenter() {
    return !!vCenterToggle.checked;
  }

  function getSizeMode() {
    const mode = sizeModeSelect.value;
    if (mode === "fit") return mode;
    return "normal";
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (s.paper) paperSelect.value = s.paper;
      if (s.orient) orientSelect.value = s.orient;
      if (s.columns) columnsSelect.value = String(s.columns);
      if (s.perPage) perPageInput.value = String(s.perPage);
      if (typeof s.pageTitle === "string") pageTitleInput.value = s.pageTitle;
      if (typeof s.footer === "string") footerInput.value = s.footer;
      if (typeof s.showTitles === "boolean") showTitlesToggle.checked = s.showTitles;
      if (typeof s.vCenter === "boolean") vCenterToggle.checked = s.vCenter;
      if (s.sizeMode === "fit" || s.sizeMode === "normal") {
        sizeModeSelect.value = s.sizeMode;
      } else if (s.fitToPaper) {
        sizeModeSelect.value = "fit";
      }
    } catch (_) {
      /* ignore */
    }
  }

  function saveSettings() {
    const payload = {
      paper: getPaper(),
      orient: getOrientation(),
      columns: getColumns(),
      perPage: getPerPage(),
      pageTitle: pageTitleInput.value,
      footer: footerInput.value,
      showTitles: showTitles(),
      vCenter: vCenter(),
      sizeMode: getSizeMode(),
    };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(payload));
    } catch (_) {
      /* ignore */
    }
  }

  function saveItems() {
    const payload = printItems.map((item) => ({
      text: String(item.text ?? ""),
      title: String(item.title ?? ""),
    }));
    try {
      localStorage.setItem(ITEMS_KEY, JSON.stringify(payload));
    } catch (_) {
      /* ignore */
    }
  }

  function loadItems() {
    try {
      const raw = localStorage.getItem(ITEMS_KEY);
      if (!raw) return;
      const list = JSON.parse(raw);
      if (!Array.isArray(list) || !list.length) return;
      const restored = [];
      for (const row of list) {
        if (!row || typeof row !== "object") continue;
        restored.push(
          makeItem(
            typeof row.text === "string" ? row.text : "",
            typeof row.title === "string" ? row.title : ""
          )
        );
      }
      if (restored.length) printItems = restored;
    } catch (_) {
      /* ignore */
    }
  }

  function syncColumnSegments() {
    const cols = String(getColumns());
    document.querySelectorAll(".seg[data-columns]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.getAttribute("data-columns") === cols);
    });
  }

  function syncSizeSegments() {
    const mode = getSizeMode();
    document.querySelectorAll(".seg[data-size]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.getAttribute("data-size") === mode);
    });
  }

  function syncOrientSegments() {
    const orient = getOrientation();
    document.querySelectorAll(".seg[data-orient]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.getAttribute("data-orient") === orient);
    });
  }

  function syncDocumentClasses() {
    const paper = getPaper();
    const orient = getOrientation();
    document.documentElement.classList.toggle("paper-a4", paper === "a4");
    document.documentElement.classList.toggle("paper-zebra105", paper === "zebra105");
    document.documentElement.classList.toggle("orient-portrait", orient === "portrait");
    document.documentElement.classList.toggle("orient-landscape", orient === "landscape");

    const isZebra = paper === "zebra105";
    paperHint.textContent = isZebra
      ? "Zebra: set printer stock to 105 × 250 mm and match orientation in the print dialog."
      : "";
  }

  function applyPaperDefaults(force) {
    const paper = getPaper();
    if (paper === "zebra105") {
      if (force || getColumns() > 2) columnsSelect.value = "1";
      if (force || getPerPage() > 6) perPageInput.value = "3";
    }
    syncColumnSegments();
  }

  // —— Scan mode ——
  function buildScanRow(item) {
    const row = document.createElement("div");
    row.className = "row" + (item.ok ? "" : " is-error");

    const label = document.createElement("p");
    label.className = "row-label";
    label.textContent = item.label;
    row.appendChild(label);

    if (!item.ok) {
      const err = document.createElement("p");
      err.className = "row-error";
      err.textContent = item.message;
      row.appendChild(err);
      return row;
    }

    const meta = document.createElement("p");
    meta.className = "row-meta";
    meta.textContent = `${item.value.length} char${item.value.length === 1 ? "" : "s"} · Code 128`;
    row.appendChild(meta);

    const wrap = document.createElement("div");
    wrap.className = "row-barcode";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    wrap.appendChild(svg);
    row.appendChild(wrap);

    try {
      JsBarcode(svg, item.value, {
        format: "CODE128",
        displayValue: false,
        margin: 16,
        height: 64,
        width: 1.6,
        background: "#ffffff",
        lineColor: "#1c1915",
      });
    } catch (err) {
      wrap.remove();
      row.classList.add("is-error");
      const fail = document.createElement("p");
      fail.className = "row-error";
      fail.textContent =
        "Could not build barcode: " + (err && err.message ? err.message : String(err));
      row.appendChild(fail);
    }

    return row;
  }

  function renderScan(raw) {
    setMode("scan");
    scanWarn.hidden = true;
    scanWarn.textContent = "";
    scanError.hidden = true;
    scanError.textContent = "";
    scanList.innerHTML = "";

    const allLines = splitLines(raw);
    if (!allLines.length) {
      scanMeta.textContent = "";
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "Select some text first, then press Ctrl+Shift+B.";
      scanList.appendChild(empty);
      return;
    }

    const globalWarnings = [];
    let lines = allLines;
    if (allLines.length > MAX_SCAN_LINES) {
      lines = allLines.slice(0, MAX_SCAN_LINES);
      globalWarnings.push(
        `Showing ${MAX_SCAN_LINES} of ${allLines.length} lines. Narrow the selection for the rest.`
      );
    }

    const items = lines.map(encodeLine);
    const okCount = items.filter((i) => i.ok).length;
    const failCount = items.length - okCount;

    scanMeta.textContent =
      items.length === 1
        ? okCount === 1
          ? "1 line → 1 barcode · Code 128"
          : "1 line · could not encode"
        : failCount === 0
          ? `${okCount} lines → ${okCount} barcodes · Code 128`
          : `${items.length} lines → ${okCount} barcodes · ${failCount} failed`;

    if (globalWarnings.length) {
      scanWarn.hidden = false;
      scanWarn.textContent = globalWarnings.join(" ");
    }

    let tooLong = 0;
    items.forEach((item) => {
      const row = buildScanRow(item);
      scanList.appendChild(row);
      const wrap = row.querySelector(".row-barcode");
      if (!wrap || wrap.clientWidth <= 0) return;
      if (wrap.scrollWidth > wrap.clientWidth + 2) {
        tooLong += 1;
        wrap.remove();
        row.classList.add("is-error");
        const fail = document.createElement("p");
        fail.className = "row-error";
        fail.textContent = "Too long to scan in this window.";
        row.appendChild(fail);
      }
    });
    if (tooLong) {
      const ready = okCount - tooLong;
      scanMeta.textContent = ready
        ? `${ready} ready · ${tooLong} too long for this window`
        : tooLong === 1
          ? "Too long to scan in this window."
          : `${tooLong} lines are too long to scan in this window.`;
    }
  }

  // —— Print mode ——
  function makeItem(text, title) {
    return { id: nextItemId++, text: String(text ?? ""), title: String(title ?? "") };
  }

  function setPerPage(n) {
    perPageInput.value = String(Math.max(1, Math.min(40, n)));
    saveSettings();
    refreshPrintPreviewOnly();
  }

  function cellInnerWidthMm(columns, paper, landscape, mode) {
    const pageW = paper === "zebra105" ? (landscape ? 250 : 105) : landscape ? 297 : 210;
    const pagePad = paper === "zebra105" ? 14 : 24;
    const fit = mode === "fit";
    let gap = 8;
    if (fit) gap = paper === "zebra105" ? 6 : 10;
    else if (paper === "zebra105") gap = 5;
    else if (columns >= 4) gap = 5;
    else if (columns >= 3) gap = 6;
    const cellPad = fit ? 5 : paper === "zebra105" ? 2 : 7;
    const inner = pageW - pagePad;
    return (inner - gap * Math.max(0, columns - 1)) / columns - cellPad;
  }

  function moduleWidthMm(len, columns, landscape, paper, mode, layoutCount) {
    if (mode === "fit") {
      const measured = fitModuleMm.get(len);
      return measured == null ? MIN_MODULE_MM : measured;
    }
    const size = barcodeSizeForPage(layoutCount, columns, landscape, paper, mode, len);
    const marginPx = paper === "zebra105" ? 2 : columns >= 3 ? 2 : 4;
    const modulePx = size.width;
    const cellMm = cellInnerWidthMm(columns, paper, landscape, mode);
    const modules = 11 * (len + 3) + 2;
    const svgW = modules * modulePx + marginPx * 2;
    if (!(svgW > 0) || !(modulePx > 0)) return 0;
    const scale = Math.min(1, cellMm / (svgW * PX_TO_MM));
    return modulePx * scale * PX_TO_MM;
  }

  function layoutSnapshot() {
    const usable = printItems.filter((item) => item.text.trim()).length;
    return {
      columns: getColumns(),
      landscape: getOrientation() === "landscape",
      paper: getPaper(),
      mode: getSizeMode(),
      count: Math.max(1, Math.min(getPerPage(), Math.max(usable, 1))),
    };
  }

  function sheetProblem(value) {
    const box = layoutSnapshot();
    const mm = moduleWidthMm(value.length, box.columns, box.landscape, box.paper, box.mode, box.count);
    return mm < MIN_MODULE_MM ? "Too small to scan on this sheet." : "";
  }

  function codeProblem(text) {
    const trimmed = String(text ?? "").trim();
    if (!trimmed) return "";
    const encoded = encodeLine(trimmed);
    if (!encoded.ok) return encoded.message;
    return sheetProblem(encoded.value);
  }

  function syncEditorProblems() {
    if (!editorList) return;
    editorList.querySelectorAll(".edit-row").forEach((row) => {
      const input = row.querySelector(".edit-code");
      const hint = row.querySelector(".edit-hint");
      const mini = row.querySelector(".edit-mini");
      if (!input || !hint) return;
      const problem = codeProblem(input.value);
      hint.textContent = problem;
      row.classList.toggle("is-bad", !!problem);
      if (!mini) return;
      const trimmed = input.value.trim();
      const encoded = trimmed ? encodeLine(trimmed) : null;
      const show = !!(encoded && encoded.ok && !problem);
      mini.classList.toggle("is-empty", !show);
      mini.innerHTML = "";
      if (!show) return;
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      mini.appendChild(svg);
      renderMini(svg, encoded.value);
    });
  }

  function setPreviewTip(tooSmallCount) {
    if (!previewTip) return;
    if (tooSmallCount > 0) {
      previewTip.textContent =
        "Some barcodes are too small to scan. Use fewer columns, or a shorter code.";
      previewTip.classList.add("is-warn");
      return;
    }
    previewTip.textContent = "What you print is what you see";
    previewTip.classList.remove("is-warn");
  }

  function barcodeHeightForLayout(countOnPage, columns, landscape, paper) {
    const rows = Math.max(1, Math.ceil(countOnPage / columns));
    if (paper === "zebra105") {
      if (landscape) {
        if (rows <= 1) return 52;
        if (rows <= 2) return 36;
        return 26;
      }
      if (rows <= 1) return 70;
      if (rows <= 2) return 52;
      if (rows <= 3) return 40;
      return 30;
    }
    if (landscape) {
      if (rows <= 2) return 64;
      if (rows <= 3) return 48;
      if (rows <= 4) return 38;
      return 28;
    }
    if (rows <= 2) return 78;
    if (rows <= 4) return 58;
    if (rows <= 6) return 46;
    if (rows <= 8) return 38;
    return 30;
  }

  function barcodeSizeForPage(countOnPage, columns, landscape, paper, _mode, valueLen) {
    const baseHeight = barcodeHeightForLayout(countOnPage, columns, landscape, paper);
    let width = barcodeWidth(valueLen);
    if (columns >= 4) width = Math.min(width, 1.15);
    else if (columns >= 3) width = Math.min(width, 1.35);

    return { height: baseHeight, width, hero: false };
  }

  function friendlyPages(n) {
    if (n <= 0) return "Nothing to print yet";
    if (n === 1) return "Fits on 1 page";
    return `${n} pages`;
  }

  function friendlyTitle(count) {
    if (count <= 0) return "Import codes to begin";
    if (count === 1) return "One barcode ready";
    return `${count} barcodes ready`;
  }

  function formatDateStamp() {
    try {
      return new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      }).format(new Date());
    } catch (_) {
      return new Date().toLocaleDateString();
    }
  }

  function moveItem(fromId, toId) {
    if (fromId === toId) return;
    const from = printItems.findIndex((i) => i.id === fromId);
    const to = printItems.findIndex((i) => i.id === toId);
    if (from < 0 || to < 0) return;
    const [item] = printItems.splice(from, 1);
    printItems.splice(to, 0, item);
    renderPrintUi();
  }

  function renderMini(svg, value) {
    try {
      JsBarcode(svg, value, {
        format: "CODE128",
        displayValue: false,
        margin: 0,
        height: 24,
        width: value.length > 28 ? 1.1 : 1.4,
        background: "transparent",
        lineColor: "#1c1915",
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  function renderEditor() {
    editorList.innerHTML = "";
    const titlesOn = showTitles();

    printItems.forEach((item, index) => {
      const trimmed = item.text.trim();
      const encoded = trimmed ? encodeLine(trimmed) : null;

      const problem = codeProblem(item.text);
      const row = document.createElement("div");
      row.className = "edit-row" + (problem ? " is-bad" : "");
      row.dataset.id = String(item.id);
      row.draggable = true;
      row.style.animationDelay = `${Math.min(index, 12) * 28}ms`;

      const handle = document.createElement("div");
      handle.className = "edit-handle";
      handle.title = "Drag to reorder";
      handle.textContent = "⠿";
      row.appendChild(handle);

      const num = document.createElement("div");
      num.className = "edit-num";
      num.textContent = String(index + 1);
      row.appendChild(num);

      const main = document.createElement("div");
      main.className = "edit-main";

      if (titlesOn) {
        const titleInput = document.createElement("input");
        titleInput.type = "text";
        titleInput.className = "edit-title";
        titleInput.value = item.title;
        titleInput.placeholder = "Title (optional)";
        titleInput.addEventListener("input", () => {
          item.title = titleInput.value;
          refreshPrintPreviewOnly();
        });
        titleInput.addEventListener("focus", () => {
          focusItemId = item.id;
          focusField = "title";
        });
        titleInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            const textEl = row.querySelector(".edit-code");
            if (textEl) textEl.focus();
          }
        });
        main.appendChild(titleInput);
      }

      const input = document.createElement("input");
      input.type = "text";
      input.className = "edit-code";
      input.value = item.text;
      input.placeholder = "Barcode value";
      input.spellcheck = false;
      input.addEventListener("input", () => {
        item.text = input.value;
        const nextTrim = item.text.trim();
        const next = nextTrim ? encodeLine(nextTrim) : null;
        const problem = codeProblem(item.text);
        row.classList.toggle("is-bad", !!problem);
        hint.textContent = problem;
        mini.classList.toggle("is-empty", !(next && next.ok && !problem));
        if (next && next.ok && !problem) {
          mini.innerHTML = "";
          const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
          mini.appendChild(svg);
          renderMini(svg, next.value);
        } else {
          mini.innerHTML = "";
        }
        refreshPrintPreviewOnly();
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          printItems.splice(index + 1, 0, makeItem(""));
          focusItemId = printItems[index + 1].id;
          focusField = titlesOn ? "title" : "text";
          renderPrintUi();
        } else if (e.key === "Backspace" && input.value === "" && printItems.length > 1) {
          e.preventDefault();
          printItems.splice(index, 1);
          focusItemId = printItems[Math.max(0, index - 1)].id;
          focusField = "text";
          renderPrintUi();
        }
      });
      input.addEventListener("focus", () => {
        focusItemId = item.id;
        focusField = "text";
      });
      main.appendChild(input);

      const mini = document.createElement("div");
      mini.className = "edit-mini" + (encoded && encoded.ok && !problem ? "" : " is-empty");
      if (encoded && encoded.ok && !problem) {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        mini.appendChild(svg);
        renderMini(svg, encoded.value);
      }
      main.appendChild(mini);

      const hint = document.createElement("p");
      hint.className = "edit-hint";
      if (problem) hint.textContent = problem;
      main.appendChild(hint);

      row.appendChild(main);

      const tools = document.createElement("div");
      tools.className = "edit-tools";

      const dup = document.createElement("button");
      dup.type = "button";
      dup.className = "icon-btn";
      dup.title = "Duplicate";
      dup.textContent = "⧉";
      dup.addEventListener("click", () => {
        printItems.splice(index + 1, 0, makeItem(item.text, item.title));
        focusItemId = printItems[index + 1].id;
        renderPrintUi();
      });
      tools.appendChild(dup);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "icon-btn danger";
      remove.title = "Remove";
      remove.textContent = "✕";
      remove.addEventListener("click", () => {
        printItems.splice(index, 1);
        if (!printItems.length) printItems.push(makeItem(""));
        focusItemId = printItems[Math.min(index, printItems.length - 1)].id;
        renderPrintUi();
      });
      tools.appendChild(remove);

      row.appendChild(tools);

      row.addEventListener("dragstart", (e) => {
        dragFromId = item.id;
        row.classList.add("is-dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(item.id));
      });
      row.addEventListener("dragend", () => {
        dragFromId = null;
        row.classList.remove("is-dragging");
        editorList.querySelectorAll(".is-drag-over").forEach((el) => el.classList.remove("is-drag-over"));
      });
      row.addEventListener("dragover", (e) => {
        e.preventDefault();
        row.classList.add("is-drag-over");
      });
      row.addEventListener("dragleave", () => row.classList.remove("is-drag-over"));
      row.addEventListener("drop", (e) => {
        e.preventDefault();
        row.classList.remove("is-drag-over");
        const from = Number(e.dataTransfer.getData("text/plain") || dragFromId);
        moveItem(from, item.id);
      });

      editorList.appendChild(row);
    });

    if (focusItemId != null) {
      const row = editorList.querySelector(`.edit-row[data-id="${focusItemId}"]`);
      const sel =
        focusField === "title"
          ? row && row.querySelector(".edit-title")
          : row && row.querySelector(".edit-code");
      if (sel) {
        sel.focus();
        sel.select();
      }
      focusItemId = null;
      focusField = "text";
    }
  }

  function appendCellTitle(cell, titlesOn, title) {
    if (!titlesOn) return;
    const t = document.createElement("p");
    t.className = "sheet-cell-title";
    if (title) {
      t.textContent = title;
    } else {
      t.textContent = "\u00a0";
      t.setAttribute("aria-hidden", "true");
    }
    cell.appendChild(t);
  }

  // Scale the title, barcode, and caption together until they fill the tile.
  // Bar height can grow with that same scale, but only up to twice the symbol
  // width — taller than that would mean stretching the bars to the tile.
  function layoutFitTrios() {
    const FILL = 0.96;
    const MAX_BAR_RATIO = 2;
    const TITLE_EM = 0.2;
    const LABEL_EM = 0.15;
    const GAP_EM = 0.045;
    fitModuleMm = new Map();
    let tooSmall = 0;

    previewEl.querySelectorAll(".sheet.is-fit .sheet-trio").forEach((trio) => {
      const cell = trio.closest(".sheet-cell");
      const svg = trio.querySelector("svg");
      if (!cell || !svg) return;
      const modules = Number(trio.dataset.modules);
      const margin = Number(trio.dataset.margin) || 0;
      const value = trio.dataset.value || "";
      const titlesOn = trio.dataset.titles === "1";
      const cs = getComputedStyle(cell);
      const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      const availW = Math.max(0, cell.clientWidth - padX) * FILL;
      const availH = Math.max(0, cell.clientHeight - padY) * FILL;
      if (!(availW > 8) || !(availH > 8) || !(modules > 0) || !value) return;

      const gaps = (titlesOn ? 1 : 0) + 1;
      const titleFactor = titlesOn ? TITLE_EM * 1.2 * 2 : 0;
      const labelFactor = LABEL_EM * 1.25;
      const extra = titleFactor + labelFactor + gaps * GAP_EM;
      const symbolBudget = Math.max(8, availW - margin * 2);
      let mw = symbolBudget / modules;
      const maxBh = symbolBudget * MAX_BAR_RATIO;
      let bh = (availH - margin * 2) / (1 + extra);
      bh = Math.max(12, Math.min(maxBh, bh));

      const paint = () => {
        const width = Math.max(0.2, Math.round(mw * 100) / 100);
        const height = Math.max(8, Math.round(bh));
        JsBarcode(svg, value, {
          format: "CODE128",
          displayValue: false,
          margin,
          height,
          width,
          background: "transparent",
          lineColor: "#111111",
        });
        const drawnW = svg.width && svg.width.baseVal ? svg.width.baseVal.value : 0;
        trio.style.gap = bh * GAP_EM + "px";
        trio.style.width = (drawnW || symbolBudget) + "px";
        const titleEl = trio.querySelector(".sheet-cell-title");
        if (titleEl) titleEl.style.fontSize = bh * TITLE_EM + "px";
        const labelEl = trio.querySelector(".sheet-cell-label");
        if (labelEl) {
          // Keep the caption on one line, as large as the symbol width allows.
          const maxLabel = symbolBudget / Math.max(1, value.length * 0.62);
          labelEl.style.fontSize = Math.max(8, Math.min(bh * LABEL_EM, maxLabel)) + "px";
        }
        return {
          tw: trio.offsetWidth,
          th: trio.offsetHeight,
          moduleMm: width * PX_TO_MM,
        };
      };

      let painted;
      try {
        painted = paint();
      } catch (_) {
        cell.classList.add("is-bad");
        return;
      }

      // Code 128 can pack digits tighter than the worst-case module count.
      const usedW = Math.max(0.2, Math.round(mw * 100) / 100);
      const drawnW = svg.width && svg.width.baseVal ? svg.width.baseVal.value : 0;
      if (drawnW > margin * 2 && drawnW < availW * 0.98) {
        const trueModules = (drawnW - margin * 2) / usedW;
        if (trueModules > 0) {
          mw = symbolBudget / trueModules;
          const bhFit = (availH - margin * 2) / (1 + extra);
          bh = Math.max(12, Math.min(mw * trueModules * MAX_BAR_RATIO, Math.max(bh, bhFit)));
          try {
            painted = paint();
          } catch (_) {
            /* keep the previous draw */
          }
        }
      }

      if (painted.th > 0 && painted.th < availH - 1 && bh < maxBh - 0.5) {
        const labelCapped = bh * LABEL_EM >= symbolBudget / Math.max(1, value.length * 0.62);
        const grow = labelCapped ? 1 + titleFactor + gaps * GAP_EM : 1 + extra;
        bh = Math.min(maxBh, bh + (availH - painted.th) / grow);
        try {
          painted = paint();
        } catch (_) {
          /* keep the previous draw */
        }
      }

      if (painted.tw > availW + 0.5 || painted.th > availH + 0.5) {
        const s = Math.min(availW / Math.max(painted.tw, 1), availH / Math.max(painted.th, 1));
        if (s > 0 && s < 1) {
          bh *= s;
          mw *= s;
          try {
            painted = paint();
          } catch (_) {
            /* keep the previous draw */
          }
        }
      }

      const prev = fitModuleMm.get(value.length);
      if (prev == null || painted.moduleMm < prev) fitModuleMm.set(value.length, painted.moduleMm);
      if (painted.moduleMm >= MIN_MODULE_MM) return;

      tooSmall += 1;
      const titleEl = trio.querySelector(".sheet-cell-title");
      const titleText = titleEl ? titleEl.textContent : "";
      cell.className = "sheet-cell is-bad";
      cell.replaceChildren();
      appendCellTitle(cell, titlesOn, titleText && titleText.trim() ? titleText : "");
      const err = document.createElement("p");
      err.className = "sheet-cell-error";
      err.textContent = "Too small to scan.";
      cell.appendChild(err);
      const label = document.createElement("p");
      label.className = "sheet-cell-label";
      label.textContent = value;
      cell.appendChild(label);
    });

    return tooSmall;
  }

  function refreshPrintPreviewOnly() {
    saveItems();
    const usable = printItems.filter((i) => i.text.trim());
    const columns = getColumns();
    const orient = getOrientation();
    const landscape = orient === "landscape";
    const paper = getPaper();
    const perPage = getPerPage();
    const pages = usable.length ? Math.ceil(usable.length / perPage) : 0;
    const titlesOn = showTitles();
    const pageTitle = pageTitleInput.value.trim();
    const footer = footerInput.value.trim() || "BarCode Anywhere - Anton";
    const dateStamp = formatDateStamp();

    pageCountEl.textContent = friendlyPages(pages);
    printMeta.textContent = friendlyTitle(usable.length);

    previewEl.innerHTML = "";

    if (!usable.length) {
      fitModuleMm = new Map();
      const empty = document.createElement("p");
      empty.className = "preview-empty";
      empty.textContent = "Click Import to paste a list — or add codes on the left.";
      previewEl.appendChild(empty);
      setPreviewTip(0);
      syncEditorProblems();
      return;
    }

    const sizeMode = getSizeMode();
    const fit = sizeMode === "fit";
    // Size every page like the first one, so a short last page does not grow its barcodes.
    const layoutCount = Math.min(perPage, usable.length);
    const layoutRows = Math.max(1, Math.ceil(layoutCount / columns));
    let tooSmallCount = 0;

    for (let p = 0; p < pages; p++) {
      const slice = usable.slice(p * perPage, (p + 1) * perPage);
      const pageSize = barcodeSizeForPage(
        layoutCount,
        columns,
        landscape,
        paper,
        sizeMode,
        24
      );
      const sheet = document.createElement("div");
      sheet.className =
        "sheet paper-" + paper + (landscape ? " is-landscape" : "") + (fit ? " is-fit" : "");
      sheet.style.animationDelay = `${p * 60}ms`;

      const header = document.createElement("div");
      header.className = "sheet-header" + (pageTitle ? "" : " is-empty");
      if (pageTitle) {
        const h = document.createElement("p");
        h.className = "sheet-page-title";
        h.textContent = pageTitle;
        header.appendChild(h);
      }
      sheet.appendChild(header);

      const grid = document.createElement("div");
      grid.className =
        "sheet-grid cols-" + columns + (vCenter() && !fit ? " is-vcenter" : "");
      grid.style.setProperty("--layout-rows", String(layoutRows));

      slice.forEach((item) => {
        const text = item.text.trim();
        const cell = document.createElement("div");
        const encoded = encodeLine(text);
        const title = (item.title || "").trim();
        const size = encoded.ok
          ? barcodeSizeForPage(
              layoutCount,
              columns,
              landscape,
              paper,
              sizeMode,
              encoded.value.length
            )
          : pageSize;

        if (!encoded.ok) {
          cell.className = "sheet-cell is-bad";
          appendCellTitle(cell, titlesOn, title);
          const label = document.createElement("p");
          label.className = "sheet-cell-label";
          label.textContent = text;
          cell.appendChild(label);
          const err = document.createElement("p");
          err.className = "sheet-cell-error";
          err.textContent = encoded.message;
          cell.appendChild(err);
          grid.appendChild(cell);
          return;
        }

        const marginPx = paper === "zebra105" ? 2 : columns >= 3 ? 2 : 4;
        if (!fit) {
          const moduleMm = moduleWidthMm(
            encoded.value.length,
            columns,
            landscape,
            paper,
            sizeMode,
            layoutCount
          );
          if (moduleMm < MIN_MODULE_MM) {
            tooSmallCount += 1;
            cell.className = "sheet-cell is-bad";
            appendCellTitle(cell, titlesOn, title);
            const err = document.createElement("p");
            err.className = "sheet-cell-error";
            err.textContent = "Too small to scan.";
            cell.appendChild(err);
            const label = document.createElement("p");
            label.className = "sheet-cell-label";
            label.textContent = encoded.value;
            cell.appendChild(label);
            grid.appendChild(cell);
            return;
          }
        }

        cell.className = "sheet-cell";
        const parent = fit ? document.createElement("div") : cell;
        if (fit) {
          parent.className = "sheet-trio";
          parent.dataset.value = encoded.value;
          parent.dataset.modules = String(11 * (encoded.value.length + 3) + 2);
          parent.dataset.margin = String(marginPx);
          parent.dataset.titles = titlesOn ? "1" : "0";
        }
        appendCellTitle(parent, titlesOn, title);

        const bars = document.createElement("div");
        bars.className = "sheet-cell-bars";
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        bars.appendChild(svg);
        parent.appendChild(bars);
        try {
          JsBarcode(svg, encoded.value, {
            format: "CODE128",
            displayValue: false,
            margin: marginPx,
            height: size.height,
            width: size.width,
            background: "transparent",
            lineColor: "#111111",
          });
        } catch (err) {
          cell.classList.add("is-bad");
          const fail = document.createElement("p");
          fail.className = "sheet-cell-error";
          fail.textContent = err && err.message ? err.message : String(err);
          parent.appendChild(fail);
        }

        const label = document.createElement("p");
        label.className = "sheet-cell-label";
        label.textContent = encoded.value;
        parent.appendChild(label);
        if (fit) cell.appendChild(parent);
        grid.appendChild(cell);
      });

      sheet.appendChild(grid);

      const foot = document.createElement("div");
      foot.className = "sheet-footer";
      foot.innerHTML =
        `<span>${escapeHtml(footer)}</span>` +
        `<span class="sheet-footer-date">${escapeHtml(dateStamp)} · <strong>${p + 1}</strong> / ${pages}</span>`;
      sheet.appendChild(foot);

      previewEl.appendChild(sheet);
    }
    if (fit) tooSmallCount += layoutFitTrios();
    setPreviewTip(tooSmallCount);
    syncEditorProblems();
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderPrintUi() {
    setMode("print");
    syncColumnSegments();
    syncOrientSegments();
    syncSizeSegments();
    syncDocumentClasses();
    renderEditor();
    refreshPrintPreviewOnly();
  }

  function openPrintWorkspace() {
    if (!printItems.length) printItems = [makeItem("")];
    renderPrintUi();
  }

  function openImport() {
    importModal.hidden = false;
    importText.focus();
  }

  function closeImport() {
    importModal.hidden = true;
  }

  function applyImport() {
    const lines = String(importText.value || "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n");
    const parsed = [];
    for (const line of lines) {
      const item = parseImportLine(line);
      if (item) parsed.push(makeItem(item.text, item.title));
    }
    if (!parsed.length) {
      importText.focus();
      return;
    }
    if (importReplaceToggle.checked) {
      printItems = parsed;
    } else {
      const onlyEmpty =
        printItems.length === 1 && !printItems[0].text.trim() && !printItems[0].title.trim();
      printItems = onlyEmpty ? parsed : printItems.concat(parsed);
    }
    if (parsed.some((p) => p.title)) showTitlesToggle.checked = true;
    closeImport();
    importText.value = "";
    focusItemId = printItems[0].id;
    saveSettings();
    renderPrintUi();
  }

  printBtn.addEventListener("click", () => {
    refreshPrintPreviewOnly();
    window.print();
  });

  importBtn.addEventListener("click", openImport);
  importApplyBtn.addEventListener("click", applyImport);
  document.querySelectorAll("[data-import-close]").forEach((el) => {
    el.addEventListener("click", closeImport);
  });

  addBtn.addEventListener("click", () => {
    printItems.push(makeItem(""));
    focusItemId = printItems[printItems.length - 1].id;
    focusField = showTitles() ? "title" : "text";
    renderPrintUi();
  });

  clearBtn.addEventListener("click", () => {
    printItems = [makeItem("")];
    focusItemId = printItems[0].id;
    renderPrintUi();
  });

  document.querySelectorAll(".seg[data-columns]").forEach((btn) => {
    btn.addEventListener("click", () => {
      columnsSelect.value = btn.getAttribute("data-columns");
      syncColumnSegments();
      saveSettings();
      refreshPrintPreviewOnly();
    });
  });

  document.querySelectorAll(".seg[data-orient]").forEach((btn) => {
    btn.addEventListener("click", () => {
      orientSelect.value = btn.getAttribute("data-orient");
      syncOrientSegments();
      syncDocumentClasses();
      saveSettings();
      refreshPrintPreviewOnly();
    });
  });

  perPageDown.addEventListener("click", () => setPerPage(getPerPage() - 1));
  perPageUp.addEventListener("click", () => setPerPage(getPerPage() + 1));
  perPageInput.addEventListener("change", () => {
    saveSettings();
    refreshPrintPreviewOnly();
  });
  perPageInput.addEventListener("input", () => {
    saveSettings();
    refreshPrintPreviewOnly();
  });

  paperSelect.addEventListener("change", () => {
    applyPaperDefaults(true);
    syncDocumentClasses();
    saveSettings();
    refreshPrintPreviewOnly();
  });

  columnsSelect.addEventListener("change", () => {
    syncColumnSegments();
    saveSettings();
    refreshPrintPreviewOnly();
  });

  orientSelect.addEventListener("change", () => {
    syncOrientSegments();
    syncDocumentClasses();
    saveSettings();
    refreshPrintPreviewOnly();
  });

  pageTitleInput.addEventListener("input", () => {
    saveSettings();
    refreshPrintPreviewOnly();
  });
  footerInput.addEventListener("input", () => {
    saveSettings();
    refreshPrintPreviewOnly();
  });
  showTitlesToggle.addEventListener("change", () => {
    saveSettings();
    renderPrintUi();
  });
  vCenterToggle.addEventListener("change", () => {
    saveSettings();
    refreshPrintPreviewOnly();
  });
  document.querySelectorAll(".seg[data-size]").forEach((btn) => {
    btn.addEventListener("click", () => {
      sizeModeSelect.value = btn.getAttribute("data-size");
      syncSizeSegments();
      saveSettings();
      refreshPrintPreviewOnly();
    });
  });
  sizeModeSelect.addEventListener("change", () => {
    syncSizeSegments();
    saveSettings();
    refreshPrintPreviewOnly();
  });

  window.addEventListener("beforeprint", () => {
    if (getSizeMode() === "fit" && !viewPrint.hidden) layoutFitTrios();
  });
  window.addEventListener("afterprint", () => {
    if (getSizeMode() === "fit" && !viewPrint.hidden) refreshPrintPreviewOnly();
  });

  function applyPayload(text, mode) {
    if (mode === "print") {
      // Print opens its own workspace; Import supplies codes.
      openPrintWorkspace();
      return;
    }
    renderScan(text);
  }

  async function pullState() {
    try {
      const res = await fetch("/api/state", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (data.id === lastId) return;
      lastId = data.id;
      applyPayload(data.text || "", data.mode === "print" ? "print" : "scan");
    } catch (_) {
      /* server may be restarting */
    }
  }

  function readHashPayload() {
    if (location.hash.length > 1) {
      try {
        return decodeURIComponent(location.hash.slice(1).replace(/\+/g, " "));
      } catch (_) {
        return location.hash.slice(1);
      }
    }
    return "";
  }

  function startLocalApi() {
    useLocalApi = true;
    setMode("scan");
    renderScan("");
    pullState();
    setInterval(pullState, 50);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") pullState();
    });
    window.addEventListener("focus", pullState);
  }

  function startStandalone() {
    document.querySelectorAll("[data-hide]").forEach((btn) => {
      btn.hidden = true;
    });
    openPrintWorkspace();
  }

  async function detectLocalApi() {
    if (!API_MODE) return false;
    try {
      const res = await fetch("/api/health", {
        cache: "no-store",
        signal: AbortSignal.timeout(700),
      });
      if (!res.ok) return false;
      const type = res.headers.get("content-type") || "";
      if (!type.includes("text/plain")) return false;
      return (await res.text()).trim() === "ok";
    } catch (_) {
      return false;
    }
  }

  loadSettings();
  loadItems();
  syncColumnSegments();
  syncOrientSegments();
  syncDocumentClasses();
  document.documentElement.classList.add("is-booting");

  detectLocalApi().then((local) => {
    document.documentElement.classList.remove("is-booting");
    if (local) {
      startLocalApi();
      return;
    }
    if (!API_MODE) {
      const mode = new URLSearchParams(location.search).get("mode") === "print" ? "print" : "scan";
      applyPayload(readHashPayload(), mode);
      return;
    }
    startStandalone();
  });
})();
