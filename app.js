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

const DEFAULT_MAP_SRC = 'gvg.jpg';
const ICON_FILES = {
  ally: 'ally.png',
  enemy: 'enemy.png',
  boss: 'boss.png',
  blueTower: 'tower_blue.png',
  redTower: 'tower_red.png',
  blueTree: 'tree_blue.png',
  redTree: 'tree_red.png',
  blueGoose: 'goose_blue.png',
  redGoose: 'goose_red.png',
};

const state = {
  tool: 'ally',
  color: '#ff3b30',
  drawSize: 4,
  objectSize: 44,
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  minZoom: 0.2,
  maxZoom: 8,
  isPanning: false,
  isDrawing: false,
  isLeftDraggingEntity: false,
  isResizingEntity: false,
  spacePressed: false,
  points: [],
  objects: [],
  strokes: [],
  texts: [],
  selected: null,
  undoStack: [],
  redoStack: [],
  mapImage: null,
  iconImages: {},
};

function clone(data) {
  return JSON.parse(JSON.stringify(data));
}

function snapshot() {
  return clone({
    objects: state.objects,
    strokes: state.strokes,
    texts: state.texts,
    offsetX: state.offsetX,
    offsetY: state.offsetY,
    scale: state.scale,
  });
}

function applySnapshot(snap) {
  state.objects = snap.objects;
  state.strokes = snap.strokes;
  state.texts = snap.texts;
  state.offsetX = snap.offsetX;
  state.offsetY = snap.offsetY;
  state.scale = snap.scale;
  state.selected = null;
}

function saveHistory() {
  state.undoStack.push(snapshot());
  if (state.undoStack.length > 300) state.undoStack.shift();
  state.redoStack = [];
}

function undo() {
  if (!state.undoStack.length) return;
  state.redoStack.push(snapshot());
  applySnapshot(state.undoStack.pop());
  render();
}

function redo() {
  if (!state.redoStack.length) return;
  state.undoStack.push(snapshot());
  applySnapshot(state.redoStack.pop());
  render();
}

function resizeCanvas() {
  canvas.width = workspace.clientWidth;
  canvas.height = workspace.clientHeight;
  render();
}

function fitMapToViewport() {
  if (!state.mapImage) return;
  const sx = canvas.width / state.mapImage.width;
  const sy = canvas.height / state.mapImage.height;
  state.scale = Math.max(sx, sy);
  state.offsetX = (canvas.width - state.mapImage.width * state.scale) / 2;
  state.offsetY = (canvas.height - state.mapImage.height * state.scale) / 2;
}

function setTool(tool) {
  state.tool = tool;
  document.querySelectorAll('.tool-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.tool === tool));
}

function getScreenPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * (canvas.width / rect.width),
    y: (event.clientY - rect.top) * (canvas.height / rect.height),
  };
}

function getWorldPoint(event) {
  const p = getScreenPoint(event);
  return { x: (p.x - state.offsetX) / state.scale, y: (p.y - state.offsetY) / state.scale };
}

function drawIcon(object) {
  const img = state.iconImages[object.type];
  const size = object.size || 44;
  if (img?.complete && img.naturalWidth > 0) {
    ctx.drawImage(img, object.x - size / 2, object.y - size / 2, size, size);
  } else {
    ctx.fillStyle = '#7db6ff';
    ctx.beginPath();
    ctx.arc(object.x, object.y, size / 2, 0, Math.PI * 2);
    ctx.fill();
  }
}

function entityBox(entity) {
  if (!entity) return null;
  if (entity.kind === 'object') {
    const o = state.objects[entity.index];
    const size = o.size || 44;
    return { x: o.x - size / 2, y: o.y - size / 2, width: size, height: size };
  }
  const t = state.texts[entity.index];
  const size = t.size || 28;
  const width = Math.max(60, t.value.length * size * 0.52);
  return { x: t.x - 4, y: t.y - 4, width, height: size + 8 };
}

function pointInRect(point, rect) {
  return !!rect && point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}

function distanceToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const proj = { x: a.x + t * dx, y: a.y + t * dy };
  return Math.hypot(p.x - proj.x, p.y - proj.y);
}

function hitTest(world) {
  for (let i = state.objects.length - 1; i >= 0; i -= 1) {
    if (pointInRect(world, entityBox({ kind: 'object', index: i }))) return { kind: 'object', index: i };
  }

  for (let i = state.texts.length - 1; i >= 0; i -= 1) {
    if (pointInRect(world, entityBox({ kind: 'text', index: i }))) return { kind: 'text', index: i };
  }

  for (let i = state.strokes.length - 1; i >= 0; i -= 1) {
    const stroke = state.strokes[i];
    for (let j = 1; j < stroke.points.length; j += 1) {
      if (distanceToSegment(world, stroke.points[j - 1], stroke.points[j]) <= (stroke.width || 5) / 2 + 5) {
        return { kind: 'stroke', index: i };
      }
    }
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

function renderSelection() {
  if (!state.selected || state.selected.kind === 'stroke') return;
  const box = entityBox(state.selected);
  if (!box) return;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2 / state.scale;
  ctx.strokeRect(box.x, box.y, box.width, box.height);

  const handles = getResizeHandles(state.selected);
  handles.forEach((h) => {
    ctx.fillStyle = '#72b3ff';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5 / state.scale;
    ctx.beginPath();
    ctx.arc(h.x, h.y, 5 / state.scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  });
}

function getResizeHandles(entity) {
  const box = entityBox(entity);
  if (!box) return [];
  return [
    { name: 'nw', x: box.x, y: box.y },
    { name: 'ne', x: box.x + box.width, y: box.y },
    { name: 'se', x: box.x + box.width, y: box.y + box.height },
    { name: 'sw', x: box.x, y: box.y + box.height },
  ];
}

function hitResizeHandle(world, entity) {
  if (!entity || entity.kind === 'stroke') return null;
  const handles = getResizeHandles(entity);
  return handles.find((h) => Math.hypot(world.x - h.x, world.y - h.y) <= 10 / state.scale) || null;
}

function beginResize(handle, entity) {
  if (!handle || !entity) return;
  const box = entityBox(entity);
  if (!box) return;
  saveHistory();
  state.isResizingEntity = true;

  const anchorByHandle = {
    nw: { x: box.x + box.width, y: box.y + box.height },
    ne: { x: box.x, y: box.y + box.height },
    se: { x: box.x, y: box.y },
    sw: { x: box.x + box.width, y: box.y },
  };

  state.resizeMeta = {
    handle: handle.name,
    target: { ...entity },
    anchor: anchorByHandle[handle.name],
  };
}

function applyResize(world) {
  if (!state.isResizingEntity || !state.resizeMeta) return;
  const { target, anchor } = state.resizeMeta;
  const box = {
    x: Math.min(anchor.x, world.x),
    y: Math.min(anchor.y, world.y),
    width: Math.max(12, Math.abs(world.x - anchor.x)),
    height: Math.max(12, Math.abs(world.y - anchor.y)),
  };

  if (target.kind === 'object') {
    const obj = state.objects[target.index];
    if (!obj) return;
    obj.x = box.x + box.width / 2;
    obj.y = box.y + box.height / 2;
    obj.size = Math.max(16, Math.min(160, Math.max(box.width, box.height)));
  }

  if (target.kind === 'text') {
    const text = state.texts[target.index];
    if (!text) return;
    const lenFactor = Math.max(1, (text.value || '').length * 0.52);
    const byWidth = box.width / lenFactor;
    const byHeight = box.height - 8;
    text.size = Math.max(18, Math.min(120, Math.max(byWidth, byHeight)));
    text.x = box.x + 4;
    text.y = box.y + 4;
  }
}

function render() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.save();
  ctx.translate(state.offsetX, state.offsetY);
  ctx.scale(state.scale, state.scale);

  if (state.mapImage) {
    ctx.drawImage(state.mapImage, 0, 0);
  } else {
    ctx.fillStyle = '#0e1526';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  state.strokes.forEach((stroke) => {
    if (stroke.points.length < 2) return;
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width / state.scale;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
    stroke.points.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
    ctx.stroke();
  });

  if (state.isDrawing && state.points.length > 1) {
    ctx.strokeStyle = state.color;
    ctx.lineWidth = Math.max(1, state.drawSize) / state.scale;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(state.points[0].x, state.points[0].y);
    state.points.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
    ctx.stroke();
  }

  state.objects.forEach(drawIcon);

  state.texts.forEach((t) => {
    ctx.fillStyle = t.color;
    ctx.font = `${(t.size || 28) / state.scale}px Inter, sans-serif`;
    ctx.textBaseline = 'top';
    ctx.fillText(t.value, t.x, t.y);
  });

  renderSelection();
  ctx.restore();
}

function addObject(point) {
  saveHistory();
  state.objects.push({ x: point.x, y: point.y, type: state.tool, size: state.objectSize });

  // one-shot placement: after placing once, user must re-select object tool
  setTool('select');
  state.selected = { kind: 'object', index: state.objects.length - 1 };
  render();
}

function addText(point) {
  const value = prompt('Masukkan text:');
  if (!value) return;
  saveHistory();
  state.texts.push({ x: point.x, y: point.y, value, color: state.color, size: Math.max(18, state.objectSize - 8) });

  // one-shot placement: after placing once, user must re-select add text
  setTool('select');
  state.selected = { kind: 'text', index: state.texts.length - 1 };
  render();
}

function loadMap(src, fit = false) {
  const img = new Image();
  img.onload = () => {
    state.mapImage = img;
    if (fit) fitMapToViewport();
    render();
  };
  img.src = src;
}

function loadIconImages() {
  Object.entries(ICON_FILES).forEach(([key, file]) => {
    const img = new Image();
    img.src = file;
    state.iconImages[key] = img;
    img.onload = render;
  });
}

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  const before = getWorldPoint(event);
  const factor = event.deltaY < 0 ? 1.08 : 0.92;
  state.scale = Math.min(state.maxZoom, Math.max(state.minZoom, state.scale * factor));
  const screen = getScreenPoint(event);
  state.offsetX = screen.x - before.x * state.scale;
  state.offsetY = screen.y - before.y * state.scale;
  render();
});

canvas.addEventListener('mousedown', (event) => {
  const world = getWorldPoint(event);

  if (event.button === 0 && state.spacePressed) {
    state.isPanning = true;
    state.panStart = { x: event.clientX, y: event.clientY };
    return;
  }

  if (event.button !== 0) return;

  const resizeHandle = hitResizeHandle(world, state.selected);
  if (resizeHandle) {
    beginResize(resizeHandle, state.selected);
    return;
  }

  const hit = hitTest(world);

  // left-hold drag for icon/text
  if (hit?.kind === 'object' || hit?.kind === 'text') {
    saveHistory();
    state.selected = hit;
    state.isLeftDraggingEntity = true;
    if (hit.kind === 'object') {
      state.dragOffset = { x: world.x - state.objects[hit.index].x, y: world.y - state.objects[hit.index].y };
    } else {
      state.dragOffset = { x: world.x - state.texts[hit.index].x, y: world.y - state.texts[hit.index].y };
    }
    render();
    return;
  }

  state.selected = null;

  if (state.tool === 'draw') {
    saveHistory();
    state.isDrawing = true;
    state.points = [world];
    return;
  }

  if (state.tool === 'text') {
    addText(world);
    return;
  }

  if (state.tool === 'select') {
    render();
    return;
  }

  if (ICON_FILES[state.tool]) addObject(world);
});

canvas.addEventListener('mousemove', (event) => {
  if (state.isPanning) {
    const dx = event.clientX - state.panStart.x;
    const dy = event.clientY - state.panStart.y;
    state.panStart = { x: event.clientX, y: event.clientY };
    state.offsetX += dx;
    state.offsetY += dy;
    render();
    return;
  }

  const world = getWorldPoint(event);

  if (state.isLeftDraggingEntity && state.selected) {
    if (state.selected.kind === 'object') {
      state.objects[state.selected.index].x = world.x - state.dragOffset.x;
      state.objects[state.selected.index].y = world.y - state.dragOffset.y;
    }
    if (state.selected.kind === 'text') {
      state.texts[state.selected.index].x = world.x - state.dragOffset.x;
      state.texts[state.selected.index].y = world.y - state.dragOffset.y;
    }
    render();
    return;
  }

  if (state.isResizingEntity) {
    applyResize(world);
    render();
    return;
  }

  if (state.isDrawing) {
    state.points.push(world);
    render();
  }
});

canvas.addEventListener('mouseup', () => {
  state.isPanning = false;
  state.isLeftDraggingEntity = false;
  state.isResizingEntity = false;
  state.resizeMeta = null;

  if (state.isDrawing && state.points.length > 1) {
    state.strokes.push({ points: [...state.points], color: state.color, width: Math.max(1, state.drawSize) });
  }

  state.isDrawing = false;
  state.points = [];
  render();
});

canvas.addEventListener('dblclick', (event) => {
  if (event.button !== 0) return;
  const world = getWorldPoint(event);
  const hit = hitTest(world);
  removeEntity(hit);
});

canvas.addEventListener('mouseleave', () => {
  state.isPanning = false;
  state.isDrawing = false;
  state.isLeftDraggingEntity = false;
  state.isResizingEntity = false;
  state.resizeMeta = null;
  state.points = [];
});

document.addEventListener('keydown', (event) => {
  if (event.code === 'Space') {
    state.spacePressed = true;
    event.preventDefault();
  }

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); undo(); }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); }
  if (event.key === 'Delete' && state.selected) { event.preventDefault(); removeEntity(state.selected); }
});

document.addEventListener('keyup', (event) => {
  if (event.code === 'Space') state.spacePressed = false;
});

document.querySelectorAll('.tool-btn').forEach((btn) => btn.addEventListener('click', () => setTool(btn.dataset.tool)));

colorPicker.addEventListener('input', (event) => {
  state.color = event.target.value;
});

drawSizeRange.addEventListener('input', (event) => {
  state.drawSize = Number(event.target.value);
  render();
});

sizeRange.addEventListener('input', (event) => {
  const size = Number(event.target.value);
  state.objectSize = size;

  if (state.selected?.kind === 'object') {
    saveHistory();
    state.objects[state.selected.index].size = size;
  }

  if (state.selected?.kind === 'text') {
    saveHistory();
    state.texts[state.selected.index].size = Math.max(18, size - 8);
  }

  render();
});

document.getElementById('undoBtn').addEventListener('click', undo);
document.getElementById('redoBtn').addEventListener('click', redo);

document.getElementById('clearDrawBtn').addEventListener('click', () => {
  if (!state.strokes.length) return;
  saveHistory();
  state.strokes = [];
  render();
});

document.getElementById('clearObjectsBtn').addEventListener('click', () => {
  if (!state.objects.length && !state.texts.length) return;
  saveHistory();
  state.objects = [];
  state.texts = [];
  state.selected = null;
  render();
});

fitBtn.addEventListener('click', () => {
  fitMapToViewport();
  render();
});

function exportStrategy() {
  const data = {
    objects: state.objects,
    strokes: state.strokes,
    texts: state.texts,
    viewport: { scale: state.scale, offsetX: state.offsetX, offsetY: state.offsetY },
    version: 2,
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'fourzy-gvg-strategy.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

function importStrategy(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      saveHistory();
      state.objects = data.objects || [];
      state.strokes = data.strokes || [];
      state.texts = data.texts || [];
      if (data.viewport) {
        state.scale = data.viewport.scale ?? state.scale;
        state.offsetX = data.viewport.offsetX ?? state.offsetX;
        state.offsetY = data.viewport.offsetY ?? state.offsetY;
      }
      state.selected = null;
      render();
    } catch {
      alert('File strategy tidak valid.');
    }
  };
  reader.readAsText(file);
}

document.getElementById('exportBtn').addEventListener('click', exportStrategy);
document.getElementById('importBtn').addEventListener('click', () => importInput.click());
importInput.addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  if (file) importStrategy(file);
  importInput.value = '';
});

window.addEventListener('resize', resizeCanvas);


guideBtn.addEventListener('click', () => guideDialog.showModal());
closeGuideBtn.addEventListener('click', () => guideDialog.close());


function startSplash() {
  const splash = document.getElementById('splashScreen');
  setTimeout(() => splash.classList.add('hide'), 1400);
}

resizeCanvas();
loadIconImages();
loadMap(DEFAULT_MAP_SRC, true);
startSplash();
render();
