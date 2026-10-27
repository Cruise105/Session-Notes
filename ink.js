// Freehand ink pages for the S Pen.
// Pen (or mouse on a PC) draws; fingers scroll; the S Pen side button erases.

export const PAGE_W = 1000, PAGE_H = 1414;
const LINE_GAP = 46, TOP = 110, MARGIN = 90;

export const INK_COLORS = [
  { id: 'ink', label: 'Black', light: '#1f1a14', dark: '#ece4d4' },
  { id: 'red', label: 'Red', light: '#b3261e', dark: '#ff8a7a' },
  { id: 'blue', label: 'Blue', light: '#1d4f91', dark: '#8ab4f8' },
];
export const INK_SIZES = [{ id: 1, label: 'Fine', w: 2.2 }, { id: 2, label: 'Medium', w: 3.6 }, { id: 3, label: 'Bold', w: 6 }];

const isDark = () => document.documentElement.dataset.themeResolved === 'dark';
const colorFor = id => { const c = INK_COLORS.find(x => x.id === id) || INK_COLORS[0]; return isDark() ? c.dark : c.light; };
const sizeFor = id => (INK_SIZES.find(x => x.id === id) || INK_SIZES[1]).w;

function drawStroke(ctx, s) {
  const p = s.pts, base = sizeFor(s.w);
  ctx.strokeStyle = colorFor(s.c);
  ctx.fillStyle = colorFor(s.c);
  if (p.length <= 3) {
    ctx.beginPath(); ctx.arc(p[0], p[1], base * (0.35 + 0.9 * (p[2] ?? 0.5)) / 2, 0, Math.PI * 2); ctx.fill();
    return;
  }
  for (let i = 3; i < p.length; i += 3) {
    const pr = ((p[i - 1] ?? 0.5) + (p[i + 2] ?? 0.5)) / 2;
    ctx.lineWidth = base * (0.35 + 0.9 * pr);
    ctx.beginPath(); ctx.moveTo(p[i - 3], p[i - 2]); ctx.lineTo(p[i], p[i + 1]); ctx.stroke();
  }
}

function drawPaper(ctx) {
  const dark = isDark();
  ctx.fillStyle = dark ? '#221e19' : '#fbf8f1';
  ctx.fillRect(0, 0, PAGE_W, PAGE_H);
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = dark ? 'rgba(160,190,230,.16)' : 'rgba(70,110,170,.22)';
  for (let y = TOP; y < PAGE_H - 30; y += LINE_GAP) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(PAGE_W, y); ctx.stroke(); }
  ctx.strokeStyle = dark ? 'rgba(255,120,110,.22)' : 'rgba(200,60,50,.3)';
  ctx.beginPath(); ctx.moveTo(MARGIN, 0); ctx.lineTo(MARGIN, PAGE_H); ctx.stroke();
}

export function renderThumb(canvas, strokes) {
  const cssW = canvas.clientWidth || 120, dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssW * dpr * PAGE_H / PAGE_W);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(canvas.width / PAGE_W, 0, 0, canvas.width / PAGE_W, 0, 0);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  drawPaper(ctx);
  for (const s of strokes || []) drawStroke(ctx, s);
}

// Opens the full-screen editor inside `root`. Returns nothing; calls onChange(strokes) as you write.
export function openInkEditor(root, page, { onChange, onClose, onDelete }) {
  let strokes = (page.strokes || []).map(s => ({ ...s, pts: s.pts.slice() }));
  let tool = 'pen', color = page.lastColor || 'ink', size = page.lastSize || 2;
  const undo = [], redo = [];

  root.innerHTML = `
    <div class="ink-bar" role="toolbar" aria-label="Ink tools">
      <div class="ink-group">
        <button class="ink-btn" data-tool="pen" aria-pressed="true" title="Pen">${icon('pen')}<span>Pen</span></button>
        <button class="ink-btn" data-tool="eraser" aria-pressed="false" title="Eraser (or hold the S Pen button)">${icon('eraser')}<span>Eraser</span></button>
      </div>
      <div class="ink-group">${INK_COLORS.map(c => `<button class="ink-swatch" data-color="${c.id}" aria-label="${c.label}" aria-pressed="false"><i style="--sw:${c.light};--swd:${c.dark}"></i></button>`).join('')}</div>
      <div class="ink-group">${INK_SIZES.map(s => `<button class="ink-size" data-size="${s.id}" aria-label="${s.label}" aria-pressed="false"><i style="--d:${4 + s.id * 3}px"></i></button>`).join('')}</div>
      <div class="ink-group">
        <button class="ink-btn" data-act="undo" title="Undo">${icon('undo')}</button>
        <button class="ink-btn" data-act="redo" title="Redo">${icon('redo')}</button>
      </div>
      <div class="ink-spacer"></div>
      <button class="ink-btn danger-text" data-act="delete" title="Delete this page">${icon('trash')}</button>
      <button class="btn primary" data-act="done">Done</button>
    </div>
    <div class="ink-scroll"><div class="ink-page"><canvas></canvas></div>
      <p class="ink-hint">Write with the S Pen. Scroll with your finger. Hold the pen's side button to erase.</p></div>`;

  const scroller = root.querySelector('.ink-scroll');
  const canvas = root.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  let scale = 1;

  function layout() {
    const cssW = canvas.parentElement.clientWidth, dpr = window.devicePixelRatio || 1;
    canvas.style.height = (cssW * PAGE_H / PAGE_W) + 'px';
    canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssW * dpr * PAGE_H / PAGE_W);
    scale = cssW / PAGE_W;
    ctx.setTransform(canvas.width / PAGE_W, 0, 0, canvas.width / PAGE_W, 0, 0);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    redraw();
  }
  function redraw() { drawPaper(ctx); for (const s of strokes) drawStroke(ctx, s); }

  function syncBar() {
    root.querySelectorAll('[data-tool]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tool === tool)));
    root.querySelectorAll('[data-color]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.color === color)));
    root.querySelectorAll('[data-size]').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.size === size)));
    root.querySelector('[data-act="undo"]').disabled = !undo.length;
    root.querySelector('[data-act="redo"]').disabled = !redo.length;
  }

  let saveT;
  function changed() {
    syncBar();
    clearTimeout(saveT);
    saveT = setTimeout(() => onChange(strokes, { color, size }), 350);
  }

  // ---- pointer handling
  let active = null; // { id, kind:'draw'|'erase'|'scroll', ... }
  const toPage = e => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) / scale, (e.clientY - r.top) / scale]; };
  const wantsErase = e => tool === 'eraser' || (e.buttons & 32) || e.button === 5 || (e.pointerType === 'pen' && (e.buttons & 2));

  function eraseAt(x, y, removed) {
    const r = 14;
    for (let i = strokes.length - 1; i >= 0; i--) {
      const p = strokes[i].pts;
      for (let j = 0; j < p.length; j += 3) {
        if (Math.abs(p[j] - x) < r && Math.abs(p[j + 1] - y) < r) { removed.push({ stroke: strokes[i], index: i }); strokes.splice(i, 1); break; }
      }
    }
  }

  const capture = e => { try { canvas.setPointerCapture(e.pointerId); } catch (_) {} };
  canvas.addEventListener('pointerdown', e => {
    if (active && active.kind !== 'scroll') return; // palm while writing
    if (e.pointerType === 'touch') {
      if (active) return;
      active = { id: e.pointerId, kind: 'scroll', y: e.clientY, top: scroller.scrollTop };
      capture(e);
      return;
    }
    if (active && active.kind === 'scroll') active = null; // pen wins over a resting palm
    e.preventDefault();
    capture(e);
    const [x, y] = toPage(e);
    if (wantsErase(e)) {
      active = { id: e.pointerId, kind: 'erase', removed: [] };
      eraseAt(x, y, active.removed); redraw();
    } else {
      const pr = e.pointerType === 'pen' ? Math.max(0.12, e.pressure || 0.5) : 0.5;
      active = { id: e.pointerId, kind: 'draw', stroke: { c: color, w: size, pts: [x, y, pr] }, pen: e.pointerType === 'pen' };
      drawStroke(ctx, active.stroke);
    }
  });

  canvas.addEventListener('pointermove', e => {
    if (!active || e.pointerId !== active.id) return;
    if (active.kind === 'scroll') { scroller.scrollTop = active.top - (e.clientY - active.y); return; }
    let evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    if (!evs.length) evs = [e];
    if (active.kind === 'erase') { for (const ev of evs) { const [x, y] = toPage(ev); eraseAt(x, y, active.removed); } redraw(); return; }
    const p = active.stroke.pts;
    for (const ev of evs) {
      const [x, y] = toPage(ev);
      const lx = p[p.length - 3], ly = p[p.length - 2];
      if (Math.abs(x - lx) + Math.abs(y - ly) < 0.8) continue;
      const pr = active.pen ? Math.max(0.12, ev.pressure || 0.5) : 0.5;
      p.push(x, y, pr);
      const seg = { c: active.stroke.c, w: active.stroke.w, pts: p.slice(-6) };
      drawStroke(ctx, seg);
    }
  });

  function finish(e) {
    if (!active || e.pointerId !== active.id) return;
    if (active.kind === 'draw') {
      strokes.push(active.stroke); undo.push({ type: 'add', stroke: active.stroke }); redo.length = 0; changed();
    } else if (active.kind === 'erase' && active.removed.length) {
      undo.push({ type: 'erase', items: active.removed }); redo.length = 0; changed();
    }
    active = null;
  }
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);
  canvas.addEventListener('contextmenu', e => e.preventDefault());

  root.querySelector('.ink-bar').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.tool) tool = b.dataset.tool;
    if (b.dataset.color) { color = b.dataset.color; tool = 'pen'; }
    if (b.dataset.size) { size = +b.dataset.size; tool = 'pen'; }
    const act = b.dataset.act;
    if (act === 'undo' && undo.length) {
      const op = undo.pop(); redo.push(op);
      if (op.type === 'add') strokes.splice(strokes.lastIndexOf(op.stroke), 1);
      else op.items.slice().reverse().forEach(it => strokes.splice(Math.min(it.index, strokes.length), 0, it.stroke));
      redraw(); changed();
    }
    if (act === 'redo' && redo.length) {
      const op = redo.pop(); undo.push(op);
      if (op.type === 'add') strokes.push(op.stroke);
      else op.items.forEach(it => { const i = strokes.indexOf(it.stroke); if (i >= 0) strokes.splice(i, 1); });
      redraw(); changed();
    }
    if (act === 'delete') { onDelete(); return; }
    if (act === 'done') { clearTimeout(saveT); onChange(strokes, { color, size }); close(); return; }
    syncBar();
  });

  const ro = new ResizeObserver(() => layout());
  ro.observe(canvas.parentElement);
  function close() { ro.disconnect(); onClose(); }
  syncBar();
  layout();
  return { redraw: layout };
}

export function icon(name) {
  const p = {
    pen: '<path d="M4 20l4-1 11-11-3-3L5 16l-1 4z"/><path d="M14 6l3 3"/>',
    eraser: '<path d="M8 20h12"/><path d="M4.5 15.5l9-9a2 2 0 012.8 0l2.2 2.2a2 2 0 010 2.8L11 19H8z"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>',
    redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 000 12h3"/>',
    trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>',
  }[name];
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}
