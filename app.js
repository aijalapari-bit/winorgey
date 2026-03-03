const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
const workspace = document.querySelector('.workspace-frame');
const colorPicker = document.getElementById('colorPicker');
const sizeRange = document.getElementById('sizeRange');
const fitBtn = document.getElementById('fitBtn');
const drawSizeRange = document.getElementById('drawSizeRange');
const importInput = document.getElementById('importInput');
const guideBtn = document.getElementById('guideBtn');
const guideDialog = document.getElementById('guideDialog');
const closeGuideBtn = document.getElementById('closeGuideBtn');
const hostMapBtn = document.getElementById('hostMapBtn');
const joinMapBtn = document.getElementById('joinMapBtn');
const sessionStatus = document.getElementById('sessionStatus');

const DEFAULT_MAP_SRC = 'gvg.jpg';
const ICON_FILES = {
  ally: 'ally.png', enemy: 'enemy.png', boss: 'boss.png',
  blueTower: 'tower_blue.png', redTower: 'tower_red.png',
  blueTree: 'tree_blue.png', redTree: 'tree_red.png',
  blueGoose: 'goose_blue.png', redGoose: 'goose_red.png',
};

const collab = {
  peer: null,
  role: null,
  roomCode: null,
  hostConn: null,
  peers: new Set(),
  suppressBroadcast: false,
  dirty: false,
};

const state = {
  tool: 'ally', color: '#ff3b30', drawSize: 4, objectSize: 44,
  scale: 1, offsetX: 0, offsetY: 0, minZoom: 0.2, maxZoom: 8,
  isPanning: false, isDrawing: false, isLeftDraggingEntity: false, isResizingEntity: false,
  spacePressed: false, points: [], objects: [], strokes: [], texts: [], selected: null,
  undoStack: [], redoStack: [], mapImage: null, iconImages: {},
};

const clone = (d) => JSON.parse(JSON.stringify(d));
const snapshot = () => clone({ objects: state.objects, strokes: state.strokes, texts: state.texts, offsetX: state.offsetX, offsetY: state.offsetY, scale: state.scale });
function applySnapshot(s) { state.objects = s.objects || []; state.strokes = s.strokes || []; state.texts = s.texts || []; state.offsetX = s.offsetX ?? state.offsetX; state.offsetY = s.offsetY ?? state.offsetY; state.scale = s.scale ?? state.scale; state.selected = null; }
function saveHistory() { state.undoStack.push(snapshot()); if (state.undoStack.length > 300) state.undoStack.shift(); state.redoStack = []; markCollabDirty(); }
function undo() { if (!state.undoStack.length) return; state.redoStack.push(snapshot()); applySnapshot(state.undoStack.pop()); render(); markCollabDirty(); }
function redo() { if (!state.redoStack.length) return; state.undoStack.push(snapshot()); applySnapshot(state.redoStack.pop()); render(); markCollabDirty(); }

function resizeCanvas() { canvas.width = workspace.clientWidth; canvas.height = workspace.clientHeight; render(); }
function fitMapToViewport() {
  if (!state.mapImage) return;
  const sx = canvas.width / state.mapImage.width;
  const sy = canvas.height / state.mapImage.height;
  state.scale = Math.max(sx, sy);
  state.offsetX = (canvas.width - state.mapImage.width * state.scale) / 2;
  state.offsetY = (canvas.height - state.mapImage.height * state.scale) / 2;
  render();
}

function setTool(tool) { state.tool = tool; document.querySelectorAll('.tool-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.tool === tool)); }
function getScreenPoint(e) { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * (canvas.width / r.width), y: (e.clientY - r.top) * (canvas.height / r.height) }; }
function getWorldPoint(e) { const p = getScreenPoint(e); return { x: (p.x - state.offsetX) / state.scale, y: (p.y - state.offsetY) / state.scale }; }

function drawIcon(o) {
  const img = state.iconImages[o.type]; const size = o.size || 44;
  if (img?.complete && img.naturalWidth > 0) ctx.drawImage(img, o.x - size / 2, o.y - size / 2, size, size);
  else { ctx.fillStyle = '#7db6ff'; ctx.beginPath(); ctx.arc(o.x, o.y, size / 2, 0, Math.PI * 2); ctx.fill(); }
}

function entityBox(entity) {
  if (!entity) return null;
  if (entity.kind === 'object') { const o = state.objects[entity.index]; if (!o) return null; const size = o.size || 44; return { x: o.x - size / 2, y: o.y - size / 2, width: size, height: size }; }
  if (entity.kind === 'text') { const t = state.texts[entity.index]; if (!t) return null; const size = t.size || 28; const width = Math.max(60, t.value.length * size * 0.52); return { x: t.x - 4, y: t.y - 4, width, height: size + 8 }; }
  return null;
}

const pointInRect = (p, r) => !!r && p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
function distanceToSegment(p, a, b) {
  const dx = b.x - a.x; const dy = b.y - a.y; const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2; t = Math.max(0, Math.min(1, t));
  const proj = { x: a.x + t * dx, y: a.y + t * dy };
  return Math.hypot(p.x - proj.x, p.y - proj.y);
}

function hitTest(world) {
  for (let i = state.objects.length - 1; i >= 0; i -= 1) if (pointInRect(world, entityBox({ kind: 'object', index: i }))) return { kind: 'object', index: i };
  for (let i = state.texts.length - 1; i >= 0; i -= 1) if (pointInRect(world, entityBox({ kind: 'text', index: i }))) return { kind: 'text', index: i };
  for (let i = state.strokes.length - 1; i >= 0; i -= 1) {
    const s = state.strokes[i];
    for (let j = 1; j < s.points.length; j += 1) if (distanceToSegment(world, s.points[j - 1], s.points[j]) <= (s.width || 5) / 2 + 5) return { kind: 'stroke', index: i };
  }
  return null;
}

function removeEntity(entity) {
  if (!entity) return;
  saveHistory();
  if (entity.kind === 'object') state.objects.splice(entity.index, 1);
  if (entity.kind === 'text') state.texts.splice(entity.index, 1);
  if (entity.kind === 'stroke') state.strokes.splice(entity.index, 1);
  state.selected = null;
  render();
}

function getResizeHandles(entity) {
  const box = entityBox(entity); if (!box) return [];
  return [{ name: 'nw', x: box.x, y: box.y }, { name: 'ne', x: box.x + box.width, y: box.y }, { name: 'se', x: box.x + box.width, y: box.y + box.height }, { name: 'sw', x: box.x, y: box.y + box.height }];
}
function hitResizeHandle(world, entity) { if (!entity || entity.kind === 'stroke') return null; return getResizeHandles(entity).find((h) => Math.hypot(world.x - h.x, world.y - h.y) <= 10 / state.scale) || null; }
function beginResize(handle, entity) {
  const box = entityBox(entity); if (!box) return;
  saveHistory(); state.isResizingEntity = true;
  const anchorByHandle = { nw: { x: box.x + box.width, y: box.y + box.height }, ne: { x: box.x, y: box.y + box.height }, se: { x: box.x, y: box.y }, sw: { x: box.x + box.width, y: box.y } };
  state.resizeMeta = { target: { ...entity }, anchor: anchorByHandle[handle.name] };
}
function applyResize(world) {
  if (!state.isResizingEntity || !state.resizeMeta) return;
  const { target, anchor } = state.resizeMeta;
  const box = { x: Math.min(anchor.x, world.x), y: Math.min(anchor.y, world.y), width: Math.max(12, Math.abs(world.x - anchor.x)), height: Math.max(12, Math.abs(world.y - anchor.y)) };
  if (target.kind === 'object') {
    const o = state.objects[target.index]; if (!o) return;
    o.x = box.x + box.width / 2; o.y = box.y + box.height / 2; o.size = Math.max(16, Math.min(160, Math.max(box.width, box.height)));
  }
  if (target.kind === 'text') {
    const t = state.texts[target.index]; if (!t) return;
    const lenFactor = Math.max(1, t.value.length * 0.52);
    t.size = Math.max(18, Math.min(120, Math.max(box.width / lenFactor, box.height - 8)));
    t.x = box.x + 4; t.y = box.y + 4;
  }
}

function renderSelection() {
  if (!state.selected || state.selected.kind === 'stroke') return;
  const box = entityBox(state.selected); if (!box) return;
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 / state.scale; ctx.strokeRect(box.x, box.y, box.width, box.height);
  getResizeHandles(state.selected).forEach((h) => { ctx.fillStyle = '#72b3ff'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5 / state.scale; ctx.beginPath(); ctx.arc(h.x, h.y, 5 / state.scale, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); });
}

function render() {
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save(); ctx.translate(state.offsetX, state.offsetY); ctx.scale(state.scale, state.scale);
  if (state.mapImage) ctx.drawImage(state.mapImage, 0, 0); else { ctx.fillStyle = '#0e1526'; ctx.fillRect(0, 0, canvas.width, canvas.height); }

  state.strokes.forEach((s) => {
    if (s.points.length < 2) return;
    ctx.strokeStyle = s.color; ctx.lineWidth = s.width / state.scale; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(s.points[0].x, s.points[0].y); s.points.slice(1).forEach((p) => ctx.lineTo(p.x, p.y)); ctx.stroke();
  });
  if (state.isDrawing && state.points.length > 1) {
    ctx.strokeStyle = state.color; ctx.lineWidth = Math.max(1, state.drawSize) / state.scale; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(state.points[0].x, state.points[0].y); state.points.slice(1).forEach((p) => ctx.lineTo(p.x, p.y)); ctx.stroke();
  }

  state.objects.forEach(drawIcon);
  state.texts.forEach((t) => { ctx.fillStyle = t.color; ctx.font = `${(t.size || 28) / state.scale}px Inter, sans-serif`; ctx.textBaseline = 'top'; ctx.fillText(t.value, t.x, t.y); });
  renderSelection();
  ctx.restore();
}

function addObject(point) { saveHistory(); state.objects.push({ x: point.x, y: point.y, type: state.tool, size: state.objectSize }); setTool('select'); state.selected = { kind: 'object', index: state.objects.length - 1 }; render(); }
function addText(point) {
  const value = prompt('Masukkan text:'); if (!value) return;
  saveHistory(); state.texts.push({ x: point.x, y: point.y, value, color: state.color, size: Math.max(18, state.objectSize - 8) });
  setTool('select'); state.selected = { kind: 'text', index: state.texts.length - 1 }; render();
}

function loadMap(src, fit = false) {
  const img = new Image();
  img.onload = () => { state.mapImage = img; if (fit) fitMapToViewport(); render(); markCollabDirty(); };
  img.src = src;
}
function loadIconImages() { Object.entries(ICON_FILES).forEach(([key, file]) => { const img = new Image(); img.src = file; state.iconImages[key] = img; img.onload = render; }); }

function getSharedPayload() {
  return { objects: state.objects, strokes: state.strokes, texts: state.texts, viewport: { scale: state.scale, offsetX: state.offsetX, offsetY: state.offsetY } };
}
function applySharedPayload(payload) {
  collab.suppressBroadcast = true;
  state.objects = payload.objects || [];
  state.strokes = payload.strokes || [];
  state.texts = payload.texts || [];
  if (payload.viewport) { state.scale = payload.viewport.scale ?? state.scale; state.offsetX = payload.viewport.offsetX ?? state.offsetX; state.offsetY = payload.viewport.offsetY ?? state.offsetY; }
  state.selected = null;
  render();
  collab.suppressBroadcast = false;
}

function updateSessionStatus() {
  if (!collab.peer) sessionStatus.textContent = 'Offline';
  else if (!collab.roomCode) sessionStatus.textContent = 'Ready';
  else sessionStatus.textContent = `${collab.role === 'host' ? 'Host' : 'Join'} • ${collab.roomCode}`;
}

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i += 1) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function broadcastState(exceptConn = null) {
  const data = { type: 'state_update', state: getSharedPayload() };
  if (collab.role === 'host') {
    collab.peers.forEach((conn) => {
      if (conn === exceptConn || !conn.open) return;
      conn.send(data);
    });
  }
  if (collab.role === 'join' && collab.hostConn?.open) collab.hostConn.send(data);
}

function wireConn(conn) {
  conn.on('data', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'state_update' && msg.state) {
      applySharedPayload(msg.state);
      if (collab.role === 'host') broadcastState(conn);
    }
  });
  conn.on('close', () => {
    collab.peers.delete(conn);
    if (collab.hostConn === conn) collab.hostConn = null;
  });
}

function initPeer(id) {
  return new Promise((resolve, reject) => {
    if (!window.Peer) { reject(new Error('PeerJS unavailable')); return; }
    const peer = new window.Peer(id || undefined, { debug: 0 });
    peer.on('open', () => resolve(peer));
    peer.on('error', reject);
  });
}

function markCollabDirty() { if (!collab.suppressBroadcast) collab.dirty = true; }
setInterval(() => {
  if (!collab.dirty) return;
  collab.dirty = false;
  broadcastState();
}, 180);

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const before = getWorldPoint(e); const factor = e.deltaY < 0 ? 1.08 : 0.92;
  state.scale = Math.min(state.maxZoom, Math.max(state.minZoom, state.scale * factor));
  const s = getScreenPoint(e); state.offsetX = s.x - before.x * state.scale; state.offsetY = s.y - before.y * state.scale;
  render(); markCollabDirty();
});

canvas.addEventListener('mousedown', (e) => {
  const world = getWorldPoint(e);
  if (e.button === 0 && state.spacePressed) { state.isPanning = true; state.panStart = { x: e.clientX, y: e.clientY }; return; }
  if (e.button !== 0) return;

  const resizeHandle = hitResizeHandle(world, state.selected);
  if (resizeHandle) { beginResize(resizeHandle, state.selected); return; }

  const hit = hitTest(world);
  if (hit?.kind === 'object' || hit?.kind === 'text') {
    saveHistory(); state.selected = hit; state.isLeftDraggingEntity = true;
    if (hit.kind === 'object') state.dragOffset = { x: world.x - state.objects[hit.index].x, y: world.y - state.objects[hit.index].y };
    else state.dragOffset = { x: world.x - state.texts[hit.index].x, y: world.y - state.texts[hit.index].y };
    render(); return;
  }

  state.selected = null;
  if (state.tool === 'draw') { saveHistory(); state.isDrawing = true; state.points = [world]; return; }
  if (state.tool === 'text') { addText(world); return; }
  if (state.tool === 'select') { render(); return; }
  if (ICON_FILES[state.tool]) addObject(world);
});

canvas.addEventListener('mousemove', (e) => {
  if (state.isPanning) {
    const dx = e.clientX - state.panStart.x; const dy = e.clientY - state.panStart.y;
    state.panStart = { x: e.clientX, y: e.clientY }; state.offsetX += dx; state.offsetY += dy;
    render(); markCollabDirty(); return;
  }
  const world = getWorldPoint(e);
  if (state.isLeftDraggingEntity && state.selected) {
    if (state.selected.kind === 'object') { state.objects[state.selected.index].x = world.x - state.dragOffset.x; state.objects[state.selected.index].y = world.y - state.dragOffset.y; }
    if (state.selected.kind === 'text') { state.texts[state.selected.index].x = world.x - state.dragOffset.x; state.texts[state.selected.index].y = world.y - state.dragOffset.y; }
    render(); markCollabDirty(); return;
  }
  if (state.isResizingEntity) { applyResize(world); render(); markCollabDirty(); return; }
  if (state.isDrawing) { state.points.push(world); render(); }
});

canvas.addEventListener('mouseup', () => {
  state.isPanning = false; state.isLeftDraggingEntity = false; state.isResizingEntity = false; state.resizeMeta = null;
  if (state.isDrawing && state.points.length > 1) { state.strokes.push({ points: [...state.points], color: state.color, width: Math.max(1, state.drawSize) }); markCollabDirty(); }
  state.isDrawing = false; state.points = []; render();
});
canvas.addEventListener('dblclick', (e) => { if (e.button !== 0) return; const hit = hitTest(getWorldPoint(e)); if (hit) removeEntity(hit); });
canvas.addEventListener('mouseleave', () => { state.isPanning = false; state.isDrawing = false; state.isLeftDraggingEntity = false; state.isResizingEntity = false; state.resizeMeta = null; state.points = []; });

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space') { state.spacePressed = true; e.preventDefault(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  if (e.key === 'Delete' && state.selected) { e.preventDefault(); removeEntity(state.selected); }
});
document.addEventListener('keyup', (e) => { if (e.code === 'Space') state.spacePressed = false; });

document.querySelectorAll('.tool-btn').forEach((btn) => btn.addEventListener('click', () => setTool(btn.dataset.tool)));
colorPicker.addEventListener('input', (e) => { state.color = e.target.value; markCollabDirty(); });
drawSizeRange.addEventListener('input', (e) => { state.drawSize = Number(e.target.value); render(); });
sizeRange.addEventListener('input', (e) => {
  const size = Number(e.target.value); state.objectSize = size;
  if (state.selected?.kind === 'object') { saveHistory(); state.objects[state.selected.index].size = size; }
  if (state.selected?.kind === 'text') { saveHistory(); state.texts[state.selected.index].size = Math.max(18, size - 8); }
  render();
});

document.getElementById('undoBtn').addEventListener('click', undo);
document.getElementById('redoBtn').addEventListener('click', redo);
document.getElementById('clearDrawBtn').addEventListener('click', () => { if (!state.strokes.length) return; saveHistory(); state.strokes = []; render(); });
document.getElementById('clearObjectsBtn').addEventListener('click', () => { if (!state.objects.length && !state.texts.length) return; saveHistory(); state.objects = []; state.texts = []; state.selected = null; render(); });
fitBtn.addEventListener('click', () => { fitMapToViewport(); markCollabDirty(); });

function exportStrategy() {
  const data = { ...getSharedPayload(), version: 4 };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'fourzy-gvg-strategy.json'; a.click(); URL.revokeObjectURL(a.href);
}
function importStrategy(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try { saveHistory(); applySharedPayload(JSON.parse(reader.result)); markCollabDirty(); }
    catch { alert('File strategy tidak valid.'); }
  };
  reader.readAsText(file);
}

document.getElementById('exportBtn').addEventListener('click', exportStrategy);
document.getElementById('importBtn').addEventListener('click', () => importInput.click());
importInput.addEventListener('change', (e) => { const file = e.target.files?.[0]; if (file) importStrategy(file); importInput.value = ''; });

guideBtn.addEventListener('click', () => guideDialog.showModal());
closeGuideBtn.addEventListener('click', () => guideDialog.close());

hostMapBtn.addEventListener('click', async () => {
  try {
    const roomCode = makeRoomCode();
    const peer = await initPeer(roomCode);
    if (collab.peer) collab.peer.destroy();
    collab.peer = peer; collab.role = 'host'; collab.roomCode = roomCode; collab.peers.clear(); collab.hostConn = null;

    peer.on('connection', (conn) => {
      collab.peers.add(conn);
      wireConn(conn);
      conn.on('open', () => conn.send({ type: 'state_update', state: getSharedPayload() }));
    });

    updateSessionStatus();
    navigator.clipboard?.writeText(roomCode).catch(() => {});
    alert(`Host aktif: ${roomCode}`);
  } catch {
    alert('Gagal membuat host map. Coba lagi.');
  }
});

joinMapBtn.addEventListener('click', async () => {
  const roomCode = prompt('Masukkan kode room host:')?.trim().toUpperCase();
  if (!roomCode) return;
  try {
    const peer = await initPeer();
    if (collab.peer) collab.peer.destroy();
    collab.peer = peer; collab.role = 'join'; collab.roomCode = roomCode; collab.peers.clear();

    const conn = peer.connect(roomCode, { reliable: true });
    collab.hostConn = conn;
    wireConn(conn);
    conn.on('open', () => updateSessionStatus());

    updateSessionStatus();
  } catch {
    alert('Gagal join room. Pastikan kode benar dan host online.');
  }
});

window.addEventListener('resize', resizeCanvas);
function startSplash() { const splash = document.getElementById('splashScreen'); setTimeout(() => splash.classList.add('hide'), 1400); }

resizeCanvas();
loadIconImages();
loadMap(DEFAULT_MAP_SRC, true);
startSplash();
updateSessionStatus();
render();
