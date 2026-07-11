(() => {
"use strict";

const TYPE_COLOR = { posts: "#e0a458", concepts: "#5fb3a5", persons: "#c4708a" };
const TYPE_LABEL = { posts: "пост", concepts: "концепт", persons: "персона" };
const TYPE_BASE_R = { posts: 2.2, concepts: 5, persons: 4 };

let graph = null;
let notes = null;
let nodeById = new Map();
let neighbors = new Map();
let linkObjs = [];

let canvas, ctx, dpr = 1;
let width = 0, height = 0;
let transform = d3.zoomIdentity;
let zoomBehavior;

let state = {
  filterType: { posts: true, concepts: true, persons: true },
  yearFrom: 1990, yearTo: 2030,
  degMin: 0,
  visible: new Set(),
  hovered: null,
  selected: null,
  ambientBright: false,
};

let pathByType = {};
let dirty = true;

// ---------------- boot / data loading ----------------

async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  const total = parseInt(res.headers.get("content-length") || "0", 10);
  if (!res.body || !total) {
    onProgress(0.5);
    return await res.json();
  }
  const reader = res.body.getReader();
  let received = 0;
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(received / total);
  }
  const blob = new Blob(chunks);
  const text = await blob.text();
  return JSON.parse(text);
}

function setBoot(pct, label) {
  const fill = document.getElementById("boot-fill");
  const status = document.getElementById("boot-status");
  if (fill) fill.style.width = Math.round(pct * 100) + "%";
  if (label && status) status.textContent = label;
}

async function loadData() {
  setBoot(0.02, "загружаю граф связей…");
  graph = await fetchWithProgress("graph.json", p => setBoot(0.02 + p * 0.28, "загружаю граф связей…"));
  setBoot(0.32, "загружаю тексты заметок…");
  notes = await fetchWithProgress("notes.json", p => setBoot(0.32 + p * 0.48, "загружаю тексты заметок…"));
  setBoot(0.82, "выращиваю граф…");
}

// ---------------- layout ----------------

function buildGraphStructures() {
  nodeById.clear();
  for (const n of graph.nodes) {
    n.x = (Math.random() - 0.5) * 800;
    n.y = (Math.random() - 0.5) * 800;
    nodeById.set(n.id, n);
  }
  neighbors.clear();
  linkObjs = [];
  for (const e of graph.edges) {
    const s = nodeById.get(e.source), t = nodeById.get(e.target);
    if (!s || !t) continue;
    linkObjs.push({ source: s, target: t });
    if (!neighbors.has(s.id)) neighbors.set(s.id, new Set());
    if (!neighbors.has(t.id)) neighbors.set(t.id, new Set());
    neighbors.get(s.id).add(t.id);
    neighbors.get(t.id).add(s.id);
  }
}

function nodeRadius(n) {
  const base = TYPE_BASE_R[n.type] || 3;
  return Math.min(base + Math.sqrt(n.deg) * 0.85, 26);
}

function runSimulation() {
  return new Promise(resolve => {
    const sim = d3.forceSimulation(graph.nodes)
      .force("link", d3.forceLink(linkObjs).id(d => d.id).distance(l => {
        const a = l.source.type, b = l.target.type;
        if (a === "concepts" && b === "concepts") return 90;
        if (a === "concepts" || b === "concepts") return 46;
        return 34;
      }).strength(0.35))
      .force("charge", d3.forceManyBody().strength(-24).distanceMax(420).theta(0.9))
      .force("center", d3.forceCenter(0, 0))
      .force("collide", d3.forceCollide(d => nodeRadius(d) + 1.4).iterations(1))
      .stop();

    const TOTAL_TICKS = 220;
    let i = 0;
    function step() {
      const batch = 10;
      for (let k = 0; k < batch && i < TOTAL_TICKS; k++, i++) sim.tick();
      setBoot(0.82 + (i / TOTAL_TICKS) * 0.18, "выращиваю граф…");
      if (i < TOTAL_TICKS) {
        setTimeout(step, 0);
      } else {
        resolve();
      }
    }
    step();
  });
}

// ---------------- filtering ----------------

function passesFilter(n) {
  if (!state.filterType[n.type]) return false;
  if (n.deg < state.degMin) return false;
  if (n.type === "posts" && n.date) {
    const y = parseInt(n.date.slice(0, 4), 10);
    if (y < state.yearFrom || y > state.yearTo) return false;
  }
  return true;
}

function recomputeVisible() {
  state.visible = new Set();
  for (const n of graph.nodes) if (passesFilter(n)) state.visible.add(n.id);
  rebuildPaths();
  dirty = true;
}

function rebuildPaths() {
  pathByType = { posts: new Path2D(), concepts: new Path2D(), persons: new Path2D() };
  for (const n of graph.nodes) {
    if (!state.visible.has(n.id)) continue;
    const r = nodeRadius(n);
    const p = pathByType[n.type];
    p.moveTo(n.x + r, n.y);
    p.arc(n.x, n.y, r, 0, Math.PI * 2);
  }
}

// ---------------- canvas rendering ----------------

function resizeCanvas() {
  const stage = document.getElementById("stage");
  width = stage.clientWidth;
  height = stage.clientHeight;
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = width + "px";
  canvas.style.height = height + "px";
  dirty = true;
}

function viewportBounds() {
  const inv = transform.invert([0, 0]);
  const inv2 = transform.invert([width, height]);
  return { x0: inv[0], y0: inv[1], x1: inv2[0], y1: inv2[1] };
}

function draw() {
  dirty = false;
  ctx.save();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#12161c";
  ctx.fillRect(0, 0, width, height);

  ctx.translate(transform.x, transform.y);
  ctx.scale(transform.k, transform.k);

  const bounds = viewportBounds();
  const pad = 60 / transform.k;

  const ambientAlpha = state.ambientBright ? 0.10 : 0.028;
  ctx.lineWidth = 1 / transform.k;
  ctx.strokeStyle = `rgba(122,138,148,${ambientAlpha})`;
  ctx.beginPath();
  for (const l of linkObjs) {
    if (!state.visible.has(l.source.id) || !state.visible.has(l.target.id)) continue;
    if (l.source.x < bounds.x0 - pad && l.target.x < bounds.x0 - pad) continue;
    if (l.source.x > bounds.x1 + pad && l.target.x > bounds.x1 + pad) continue;
    if (l.source.y < bounds.y0 - pad && l.target.y < bounds.y0 - pad) continue;
    if (l.source.y > bounds.y1 + pad && l.target.y > bounds.y1 + pad) continue;
    ctx.moveTo(l.source.x, l.source.y);
    ctx.lineTo(l.target.x, l.target.y);
  }
  ctx.stroke();

  const focusId = state.selected || state.hovered;
  if (focusId && neighbors.has(focusId)) {
    const fn = nodeById.get(focusId);
    ctx.strokeStyle = "rgba(231,224,205,0.55)";
    ctx.lineWidth = 1.2 / transform.k;
    ctx.beginPath();
    for (const nb of neighbors.get(focusId)) {
      if (!state.visible.has(nb)) continue;
      const other = nodeById.get(nb);
      ctx.moveTo(fn.x, fn.y);
      ctx.lineTo(other.x, other.y);
    }
    ctx.stroke();
  }

  const dimOthers = !!focusId;
  for (const type of ["posts", "persons", "concepts"]) {
    if (!dimOthers) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = TYPE_COLOR[type];
      ctx.fill(pathByType[type]);
    } else {
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = TYPE_COLOR[type];
      ctx.fill(pathByType[type]);
    }
  }
  ctx.globalAlpha = 1;

  if (dimOthers) {
    const fset = neighbors.get(focusId) || new Set();
    for (const type of ["posts", "persons", "concepts"]) {
      ctx.beginPath();
      for (const id of [focusId, ...fset]) {
        if (!state.visible.has(id)) continue;
        const n = nodeById.get(id);
        if (n.type !== type) continue;
        const r = nodeRadius(n);
        ctx.moveTo(n.x + r, n.y);
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      }
      ctx.fillStyle = TYPE_COLOR[type];
      ctx.fill();
    }
    const fn2 = nodeById.get(focusId);
    if (fn2) {
      ctx.beginPath();
      ctx.arc(fn2.x, fn2.y, nodeRadius(fn2) + 3.5 / transform.k, 0, Math.PI * 2);
      ctx.strokeStyle = "#e7e0cd";
      ctx.lineWidth = 1.4 / transform.k;
      ctx.stroke();
    }
  }

  const showAllLabelThreshold = 1.4;
  ctx.font = `${11 / transform.k}px "IBM Plex Mono", monospace`;
  ctx.textBaseline = "middle";
  const labelSet = new Set();
  if (focusId) {
    labelSet.add(focusId);
    for (const nb of (neighbors.get(focusId) || [])) labelSet.add(nb);
  }
  for (const n of graph.nodes) {
    if (!state.visible.has(n.id)) continue;
    if (n.x < bounds.x0 - pad || n.x > bounds.x1 + pad || n.y < bounds.y0 - pad || n.y > bounds.y1 + pad) continue;
    const big = n.deg >= 14 || transform.k >= showAllLabelThreshold;
    if (!big && !labelSet.has(n.id)) continue;
    const r = nodeRadius(n);
    ctx.fillStyle = labelSet.has(n.id) && focusId ? "#e7e0cd" : "rgba(169,164,150,0.85)";
    ctx.fillText(truncate(n.title, 34), n.x + r + 4 / transform.k, n.y);
  }

  ctx.restore();
}

function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }

function ensureLoop() {
  requestAnimationFrame(() => {
    if (dirty) draw();
    ensureLoop();
  });
}

// ---------------- hit testing ----------------

function screenToGraph(px, py) {
  const [x, y] = transform.invert([px, py]);
  return { x, y };
}

function hitTest(px, py) {
  const { x, y } = screenToGraph(px, py);
  let best = null, bestD = Infinity;
  const searchR = 18 / transform.k;
  for (const n of graph.nodes) {
    if (!state.visible.has(n.id)) continue;
    const dx = n.x - x, dy = n.y - y;
    const d = Math.sqrt(dx * dx + dy * dy);
    const r = Math.max(nodeRadius(n), 6);
    if (d <= Math.max(r, searchR) && d < bestD) { bestD = d; best = n; }
  }
  return best;
}

// ---------------- interaction wiring ----------------

let dragNode = null, dragMoved = false, downPos = null;

function setupCanvasEvents() {
  zoomBehavior = d3.zoom()
    .scaleExtent([0.08, 8])
    .filter((event) => {
      if (event.type === "wheel") return true;
      if (event.button !== undefined && event.button !== 0) return false;
      const rect = canvas.getBoundingClientRect();
      const px = (event.clientX ?? (event.touches && event.touches[0].clientX)) - rect.left;
      const py = (event.clientY ?? (event.touches && event.touches[0].clientY)) - rect.top;
      return !hitTest(px, py);
    })
    .on("zoom", (event) => {
      transform = event.transform;
      dirty = true;
      hideSearchResults();
    });

  d3.select(canvas).call(zoomBehavior);

  canvas.addEventListener("pointerdown", (e) => {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const hit = hitTest(px, py);
    downPos = { px, py };
    dragMoved = false;
    if (hit) {
      dragNode = hit;
      canvas.setPointerCapture(e.pointerId);
    }
  });

  canvas.addEventListener("pointermove", (e) => {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;

    if (dragNode) {
      if (downPos && (Math.abs(px - downPos.px) > 3 || Math.abs(py - downPos.py) > 3)) dragMoved = true;
      const { x, y } = screenToGraph(px, py);
      dragNode.x = x; dragNode.y = y;
      rebuildPaths();
      dirty = true;
      return;
    }

    const hit = hitTest(px, py);
    if (hit !== state.hovered) {
      state.hovered = hit ? hit.id : null;
      dirty = true;
      updateHoverTip(hit, px, py);
    } else if (hit) {
      updateHoverTip(hit, px, py);
    }
  });

  canvas.addEventListener("pointerup", (e) => {
    if (dragNode) {
      if (!dragMoved) selectNode(dragNode.id);
      dragNode = null;
    }
    downPos = null;
  });

  canvas.addEventListener("pointerleave", () => {
    state.hovered = null;
    document.getElementById("hover-tip").hidden = true;
    dirty = true;
  });

  window.addEventListener("resize", resizeCanvas);
}

function updateHoverTip(hit, px, py) {
  const tip = document.getElementById("hover-tip");
  if (!hit) { tip.hidden = true; return; }
  tip.hidden = false;
  tip.style.left = px + "px";
  tip.style.top = py + "px";
  tip.innerHTML = `<span class="ht-type">${TYPE_LABEL[hit.type]}</span>${escapeHtml(hit.title)}`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ---------------- panel / selection ----------------

function selectNode(id, { center = true } = {}) {
  const n = nodeById.get(id);
  const note = notes[id];
  if (!n || !note) return;
  state.selected = id;
  dirty = true;

  document.getElementById("panel").classList.add("open");
  document.getElementById("panel-eyebrow").textContent =
    (note.date ? note.date + " · " : "") + `${(neighbors.get(id) || new Set()).size} связей`;
  document.getElementById("panel-title").textContent = note.title;
  const stamp = document.getElementById("panel-stamp");
  stamp.textContent = TYPE_LABEL[note.type];
  stamp.className = "panel-stamp type-" + note.type;
  document.getElementById("panel-meta").textContent = note.tags && note.tags.length ? note.tags.map(t => "#" + t).join("  ") : "";
  document.getElementById("panel-body").innerHTML = note.html;

  fillLinkList("panel-links-section", "panel-links", note.links);
  fillLinkList("panel-backlinks-section", "panel-backlinks", note.backlinks);

  wireInternalLinks(document.getElementById("panel-body"));
  document.getElementById("panel").scrollTop = 0;
  const pc = document.querySelector(".panel-card");
  if (pc) pc.scrollTop = 0;

  if (center) centerOn(n);
}

function fillLinkList(sectionId, listId, ids) {
  const section = document.getElementById(sectionId);
  const list = document.getElementById(listId);
  list.innerHTML = "";
  if (!ids || !ids.length) { section.hidden = true; return; }
  section.hidden = false;
  for (const id of ids) {
    const meta = notes[id];
    if (!meta) continue;
    const el = document.createElement("div");
    el.className = "pl-item type-" + meta.type;
    el.textContent = meta.title;
    el.addEventListener("click", () => selectNode(id));
    list.appendChild(el);
  }
}

function wireInternalLinks(container) {
  container.querySelectorAll("a.wikilink").forEach(a => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const id = a.getAttribute("data-id");
      if (id && notes[id]) selectNode(id);
    });
  });
}

function closePanel() {
  document.getElementById("panel").classList.remove("open");
  state.selected = null;
  dirty = true;
}

function centerOn(n) {
  const targetK = Math.max(transform.k, 1.1);
  const t = d3.zoomIdentity.translate(width / 2, height / 2).scale(targetK).translate(-n.x, -n.y);
  d3.select(canvas).transition().duration(500).call(zoomBehavior.transform, t);
}

// ---------------- search ----------------

function setupSearch() {
  const input = document.getElementById("search-input");
  const results = document.getElementById("search-results");

  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { hideSearchResults(); return; }
    const matches = [];
    for (const n of graph.nodes) {
      if (n.title.toLowerCase().includes(q)) matches.push(n);
      if (matches.length >= 40) break;
    }
    matches.sort((a, b) => b.deg - a.deg);
    results.innerHTML = "";
    if (!matches.length) {
      results.innerHTML = `<div class="sr-item" style="color:var(--muted)">ничего не найдено</div>`;
    } else {
      for (const m of matches.slice(0, 25)) {
        const el = document.createElement("div");
        el.className = "sr-item";
        el.innerHTML = `<span class="sr-title">${escapeHtml(m.title)}</span><span class="sr-type">${TYPE_LABEL[m.type]}</span>`;
        el.addEventListener("click", () => {
          selectNode(m.id);
          hideSearchResults();
          input.value = m.title;
        });
        results.appendChild(el);
      }
    }
    results.classList.add("show");
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { input.blur(); hideSearchResults(); }
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".tb-search")) hideSearchResults();
  });
}

function hideSearchResults() {
  document.getElementById("search-results").classList.remove("show");
}

// ---------------- filters UI ----------------

function setupFilters() {
  document.getElementById("filters-toggle").addEventListener("click", () => {
    const p = document.getElementById("filters-panel");
    p.hidden = !p.hidden;
  });

  document.querySelectorAll('.chip input[type=checkbox]').forEach(cb => {
    cb.addEventListener("change", () => {
      state.filterType[cb.dataset.type] = cb.checked;
      recomputeVisible();
    });
  });

  const years = graph.nodes.filter(n => n.date).map(n => parseInt(n.date.slice(0, 4), 10));
  const minY = Math.min(...years), maxY = Math.max(...years);
  const yf = document.getElementById("year-from"), yt = document.getElementById("year-to");
  yf.min = yt.min = minY; yf.max = yt.max = maxY;
  yf.value = minY; yt.value = maxY;
  state.yearFrom = minY; state.yearTo = maxY;
  document.getElementById("year-from-lbl").textContent = minY;
  document.getElementById("year-to-lbl").textContent = maxY;

  function syncYears() {
    let a = parseInt(yf.value, 10), b = parseInt(yt.value, 10);
    if (a > b) [a, b] = [b, a];
    state.yearFrom = a; state.yearTo = b;
    document.getElementById("year-from-lbl").textContent = a;
    document.getElementById("year-to-lbl").textContent = b;
    recomputeVisible();
  }
  yf.addEventListener("input", syncYears);
  yt.addEventListener("input", syncYears);

  const degMin = document.getElementById("deg-min");
  degMin.addEventListener("input", () => {
    state.degMin = parseInt(degMin.value, 10);
    document.getElementById("deg-min-lbl").textContent = state.degMin;
    recomputeVisible();
  });

  document.getElementById("filters-reset").addEventListener("click", () => {
    document.querySelectorAll('.chip input[type=checkbox]').forEach(cb => { cb.checked = true; state.filterType[cb.dataset.type] = true; });
    yf.value = minY; yt.value = maxY; syncYears();
    degMin.value = 0; state.degMin = 0; document.getElementById("deg-min-lbl").textContent = "0";
    recomputeVisible();
  });

  document.getElementById("cnt-posts").textContent = graph.nodes.filter(n => n.type === "posts").length;
  document.getElementById("cnt-concepts").textContent = graph.nodes.filter(n => n.type === "concepts").length;
  document.getElementById("cnt-persons").textContent = graph.nodes.filter(n => n.type === "persons").length;
}

function setupTopbarMisc() {
  document.getElementById("tb-counts").textContent =
    `${graph.nodes.filter(n=>n.type==="posts").length} постов · ${graph.nodes.filter(n=>n.type==="concepts").length} концептов · ${graph.nodes.filter(n=>n.type==="persons").length} персон`;

  document.getElementById("panel-close").addEventListener("click", closePanel);

  document.getElementById("focus-toggle").addEventListener("click", (e) => {
    state.ambientBright = !state.ambientBright;
    e.target.textContent = "Связи: " + (state.ambientBright ? "ярко" : "тускло");
    e.target.classList.toggle("active", state.ambientBright);
    dirty = true;
  });

  document.getElementById("zoom-in").addEventListener("click", () => d3.select(canvas).transition().duration(200).call(zoomBehavior.scaleBy, 1.4));
  document.getElementById("zoom-out").addEventListener("click", () => d3.select(canvas).transition().duration(200).call(zoomBehavior.scaleBy, 1 / 1.4));
  document.getElementById("zoom-reset").addEventListener("click", () => fitToView(600));
}

function fitToView(duration = 0) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const n of graph.nodes) {
    if (n.x < x0) x0 = n.x; if (n.x > x1) x1 = n.x;
    if (n.y < y0) y0 = n.y; if (n.y > y1) y1 = n.y;
  }
  const w = x1 - x0, h = y1 - y0;
  const k = Math.min(width / (w * 1.15), height / (h * 1.15), 2.2);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const t = d3.zoomIdentity.translate(width / 2, height / 2).scale(k).translate(-cx, -cy);
  if (duration > 0) {
    d3.select(canvas).transition().duration(duration).call(zoomBehavior.transform, t);
  } else {
    d3.select(canvas).call(zoomBehavior.transform, t);
  }
}

// ---------------- boot sequence ----------------

async function main() {
  canvas = document.getElementById("graph-canvas");
  ctx = canvas.getContext("2d");

  await loadData();
  buildGraphStructures();

  // Показать блок графа ДО замера размеров холста (экран загрузки всё ещё
  // поверх него, так что визуально ничего не меняется) — иначе canvas
  // получает нулевой размер и весь граф рисуется невидимым.
  document.getElementById("app").hidden = false;
  resizeCanvas();

  await runSimulation();

  recomputeVisible();
  setupCanvasEvents();
  setupSearch();
  setupFilters();
  setupTopbarMisc();

  fitToView(0);

  setBoot(1, "готово");
  document.getElementById("boot").style.opacity = "0";
  document.getElementById("boot").style.transition = "opacity .4s ease";
  setTimeout(() => { document.getElementById("boot").hidden = true; }, 400);

  ensureLoop();
}

main().catch(err => {
  console.error(err);
  setBoot(1, "ошибка загрузки: " + err.message);
});

})();
