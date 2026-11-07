// Timeline editor: clips chained in one track, ends trimmed with handles, order changed by dragging.
// Plain ES module, no dependencies. Talks to the API of ../server.py, or to any object shaped like restApi().
//
//   import { openTimeline } from '/timeline/timeline.js';
//   openTimeline({ api: '/api/timeline', title: 'My project' });

const enc = encodeURIComponent;
const PREF_KEY = 'timeline-editor.v1';
const MIN_FRAMES = 2;
const EDGE = 48; // px from the track's edge where dragging scrolls it
const MAX_UNDO = 200;
// Undo history per timeline id. Module-wide, so it outlives a closed window while the page stays open.
const histories = new Map();

function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) node.append(kid);
  return node;
}

function pref(key, fallback) {
  try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}')[key] ?? fallback; } catch { return fallback; }
}
function setPref(key, value) {
  try {
    const all = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    all[key] = value;
    localStorage.setItem(PREF_KEY, JSON.stringify(all));
  } catch {}
}

// Pointer capture keeps a drag going outside the element; a pen or a synthetic event may not allow it.
const capture = (node, e) => { try { node.setPointerCapture(e.pointerId); } catch {} };
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const len = (c) => c.out - c.in;
// First frame and the frame after the last of a trimmed clip (as the server counts them).
const frames = (c) => {
  const a = Math.round(c.in * c.fps);
  return [a, Math.max(a + 1, Math.round(c.out * c.fps))];
};

function fmt(s) {
  s = Math.max(0, s);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}
const fmtTick = (s) => (s % 60 === 0 && s ? `${s / 60}m` : s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s}s`);

// ---------- API ----------

export function restApi(base = '/api/timeline') {
  base = base.replace(/\/$/, '');
  async function call(path, body, method) {
    const res = await fetch(base + path, {
      method: method || (body ? 'POST' : 'GET'),
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) throw Object.assign(new Error((data && data.detail) || `${res.status} ${res.statusText}`), { status: res.status });
    return data;
  }
  return {
    list: () => call(''),
    get: (id) => call(`/${enc(id)}`),
    create: (body) => call('', body),
    save: (id, body) => call(`/${enc(id)}`, body, 'PUT'),
    remove: (id) => call(`/${enc(id)}`, null, 'DELETE'),
    exportStart: (id, mode) => call(`/${enc(id)}/export`, { mode }),
    exportStatus: (job) => call(`/exports/${enc(job)}`),
    exportCancel: (job) => call(`/exports/${enc(job)}/cancel`, {}),
    mediaUrl: (c) => `${base}/media/${enc(c.key)}?v=${enc(c.vtag)}`,
    thumbUrl: (c, frame) => `${base}/thumb/${enc(c.key)}?v=${enc(c.vtag)}&f=${frame}`,
  };
}

// ---------- the editor ----------

export class TimelineEditor {
  constructor(root, opts = {}) {
    this.root = root;
    this.opts = opts;
    this.api = !opts.api || typeof opts.api === 'string' ? restApi(opts.api) : opts.api;
    this.t = null;          // the timeline shown: {id, name, rev, clips: [...]}
    this.views = new Map(); // clip id -> its elements
    this.pps = pref('pps', 40); // pixels per second
    this.T = 0;             // playhead, seconds into the timeline
    this.idx = 0;           // clip under the playhead
    this.playing = false;
    this.selected = null;
    this.trim = null;       // {id, origIn} while a start is being trimmed
    this.editSeq = 0;
    this.sentSeq = 0;
    this.build();
    this.load(opts.timeline);
  }

  // ---------- DOM ----------

  build() {
    const b = (label, onclick, title, cls) => el('button', { type: 'button', class: cls || '', title, onclick }, label);
    this.select = el('select', { class: 'tle-select', title: 'Timeline', onchange: () => this.switchTo(this.select.value) });
    this.modeSel = el('select', { class: 'tle-select', title: 'What to export' },
      el('option', { value: 'video' }, 'Entire Timeline'), el('option', { value: 'range' }, 'In/Out Marker'),
      el('option', { value: 'clips' }, 'Separate clips'));
    this.modeSel.value = pref('mode', 'video');
    this.exportBtn = b('Export…', () => this.export(), 'Render the timeline with its cuts', 'tle-primary');
    this.cancelBtn = b('Cancel export', () => this.exportJob && this.api.exportCancel(this.exportJob), '', 'tle-small');
    this.cancelBtn.hidden = true;
    this.statusText = el('span', { class: 'tle-status-text' });
    this.saveText = el('span', { class: 'tle-save', title: 'Edits are saved on their own' });
    this.bar = el('div', { class: 'tle-bar' }, el('div'));
    this.bar.hidden = true;

    this.players = [0, 1].map(() => {
      const v = el('video', { class: 'tle-video', preload: 'auto', playsInline: true });
      v.addEventListener('timeupdate', () => this.step());
      v.addEventListener('ended', () => this.step());
      v.addEventListener('seeked', () => {
        if (v._pending != null) { const t = v._pending; v._pending = null; v.currentTime = t; }
      });
      return v;
    });
    this.active = 0;
    this.players[0].classList.add('tle-on');
    this.screen = el('div', { class: 'tle-screen', onclick: () => this.toggle() }, ...this.players);
    this.playBtn = b('▶', () => this.toggle(), 'Play / pause (Space)', 'tle-play');
    this.timeText = el('span', { class: 'tle-time' }, '0:00.0 / 0:00.0');
    this.info = el('span', { class: 'tle-info' });
    this.undoBtn = b('↶ Undo', () => this.undo(), '', 'tle-small');
    this.redoBtn = b('↷ Redo', () => this.redo(), '', 'tle-small');
    this.zoom = el('input', {
      type: 'range', min: 0, max: 100, step: 1, class: 'tle-zoom', title: 'Zoom (Ctrl + mouse wheel on the track)',
      oninput: () => this.setZoom(5 * Math.pow(60, this.zoom.value / 100)),
    });
    this.zoom.value = String(Math.round(100 * Math.log(this.pps / 5) / Math.log(60)));
    this.inBtn = b('[ Set In', () => this.setMark(0), 'Set the in marker at the playhead (I)', 'tle-small');
    this.outBtn = b('Set Out ]', () => this.setMark(1), 'Set the out marker at the playhead (O)', 'tle-small');
    this.markText = el('span', { class: 'tle-mark-text' });
    this.clearBtn = b('✕', () => this.clearMarks(), 'Remove the in and out markers', 'tle-small');

    this.ruler = el('div', { class: 'tle-ruler', title: 'Click or drag to move the playhead', onpointerdown: (e) => this.scrub(e) });
    this.track = el('div', { class: 'tle-track' });
    this.slot = el('div', { class: 'tle-slot' });
    this.slot.hidden = true;
    this.playhead = el('div', { class: 'tle-playhead' });
    this.empty = el('div', { class: 'tle-empty' }, 'Loading…');
    this.range = el('div', { class: 'tle-range', title: 'Range between the in and out markers' });
    this.range.hidden = true;
    this.lane = el('div', { class: 'tle-lane' }, this.ruler, this.track, this.playhead);
    this.track.append(this.slot, this.range);
    this.scroller = el('div', { class: 'tle-scroller' }, this.lane, this.empty);
    this.scroller.addEventListener('wheel', (e) => this.wheel(e), { passive: false });

    this.root.classList.add('tle');
    this.root.append(
      el('div', { class: 'tle-head' },
        this.opts.title ? el('b', { class: 'tle-title' }, this.opts.title) : null,
        this.select,
        b('New', () => this.create(false), 'A new timeline with every clip'),
        b('Duplicate', () => this.create(true), 'A copy of this timeline, cuts included'),
        b('Rename', () => this.rename(), 'Rename this timeline'),
        this.delBtn = b('Delete', () => this.remove(), 'Delete this timeline', 'tle-danger'),
        el('span', { class: 'tle-grow' }),
        this.modeSel, this.exportBtn,
        this.opts.onClose ? b('✕', () => this.opts.onClose(), 'Close (Esc)', 'tle-close') : null),
      this.screen,
      el('div', { class: 'tle-transport' }, this.playBtn, this.timeText, this.info, el('span', { class: 'tle-grow' }),
        el('div', { class: 'tle-marks' }, this.inBtn, this.outBtn, this.markText, this.clearBtn),
        el('span', { class: 'tle-grow' }),
        this.undoBtn, this.redoBtn, el('span', { class: 'tle-muted' }, 'Zoom'), this.zoom),
      this.scroller,
      el('div', { class: 'tle-status' }, this.bar, this.statusText, this.cancelBtn, el('span', { class: 'tle-grow' }), this.saveText));

    this.onKey = (e) => this.key(e);
    this.root.addEventListener('keydown', this.onKey);
    this.onResize = () => this.layout();
    window.addEventListener('resize', this.onResize);
    this.updateUndo();
  }

  status(text, bad = false) {
    this.statusText.textContent = text || '';
    this.statusText.classList.toggle('tle-bad', bad);
  }

  // ---------- loading and saving ----------

  async load(want) {
    try {
      const r = await this.api.list();
      this.list = r.timelines;
      const id = [want, pref('active'), this.list[0]?.id].find((x) => x && this.list.some((t) => t.id === x));
      await this.switchTo(id, true);
    } catch (e) {
      this.empty.textContent = 'Could not load the timeline: ' + e.message;
    }
  }

  fillSelect() {
    this.select.replaceChildren(...this.list.map((t) => el('option', { value: t.id }, t.name)));
    if (this.t) this.select.value = this.t.id;
    this.delBtn.disabled = this.list.length < 2;
  }

  async switchTo(id, first = false) {
    if (!first) await this.flush();
    this.pause();
    try {
      this.apply(await this.api.get(id));
    } catch (e) { this.status('Could not open the timeline: ' + e.message, true); return; }
    setPref('active', id);
    this.fillSelect();
    this.updateUndo();
    this.seek(0);
  }

  apply(t) {
    this.t = t;
    const item = this.list?.find((x) => x.id === t.id);
    if (item) item.name = t.name;
    this.render();
  }

  saveState(text, bad = false) {
    this.saveText.textContent = text;
    this.saveText.classList.toggle('tle-bad', bad);
  }

  touch() {
    this.editSeq++;
    this.saveState('Unsaved changes…');
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 300);
  }

  async flush(extra = {}) {
    clearTimeout(this.saveTimer);
    while (this.saving) await this.saving;
    if (!this.t || (this.sentSeq === this.editSeq && !extra.name)) return;
    const seq = this.editSeq;
    const t = this.t;
    const body = { rev: t.rev, ...extra, marks: t.marks || [null, null],
      clips: t.clips.map((c) => ({ id: c.id, key: c.key, in: c.in, out: c.out })) };
    this.saveState('Saving…');
    this.saving = (async () => {
      try {
        const r = await this.api.save(t.id, body);
        if (this.editSeq === seq) this.saveState('All changes saved');
        if (this.t !== t) return;
        // Edits made meanwhile stay; only the revision is taken over then.
        if (this.editSeq === seq && !this.dragging) this.apply(r);
        else t.rev = r.rev;
        if (extra.name) this.fillSelect();
      } catch (e) {
        if (e.status === 409) {
          this.status('The timeline changed meanwhile and was reloaded.', true);
          this.saveState('');
          if (this.t === t) this.apply(await this.api.get(t.id));
        } else {
          this.status('Saving failed: ' + e.message, true);
          this.saveState('Not saved', true);
        }
      } finally {
        this.sentSeq = seq;
      }
    })();
    await this.saving;
    this.saving = null;
  }

  async create(copy) {
    await this.flush();
    const name = prompt('Name of the new timeline', copy ? `${this.t.name} copy` : `Timeline ${this.list.length + 1}`);
    if (name == null) return;
    try {
      const t = await this.api.create({ name, copy_of: copy ? this.t.id : '' });
      this.list.push({ id: t.id, name: t.name });
      await this.switchTo(t.id, true);
    } catch (e) { this.status(e.message, true); }
  }

  async rename() {
    const name = prompt('Rename the timeline', this.t.name);
    if (!name || !name.trim() || name === this.t.name) return;
    await this.flush({ name: name.trim() });
  }

  async remove() {
    if (!confirm(`Delete the timeline “${this.t.name}”? The clips themselves stay.`)) return;
    try {
      await this.api.remove(this.t.id);
      histories.delete(this.t.id);
      this.list = this.list.filter((x) => x.id !== this.t.id);
      this.t = null;
      await this.switchTo(this.list[0].id, true);
    } catch (e) { this.status(e.message, true); }
  }

  // ---------- undo ----------
  // A step remembers the order and trims of all clips before an edit. Clips are found by id, so a
  // step still applies after the server added clips (they keep their place) or reloaded the timeline.

  snapshot() { return this.t.clips.map((c) => ({ id: c.id, version: c.version, in: c.in, out: c.out })); }

  get history() {
    let h = histories.get(this.t.id);
    if (!h) histories.set(this.t.id, (h = { undo: [], redo: [] }));
    return h;
  }

  record(before, label) {
    const h = this.history;
    h.undo.push({ clips: before, label });
    if (h.undo.length > MAX_UNDO) h.undo.shift();
    h.redo = [];
    this.updateUndo();
  }

  restore(snap) {
    const byId = new Map(this.t.clips.map((c) => [c.id, c]));
    const known = new Set(snap.map((x) => x.id));
    const clips = snap.filter((x) => byId.has(x.id)).map((x) => {
      const c = byId.get(x.id);
      // A clip rendered again since has other footage: its old trims don't belong to it.
      if (c.version === x.version) { c.in = x.in; c.out = Math.min(x.out, c.duration); }
      return c;
    });
    this.t.clips.forEach((c, i) => { if (!known.has(c.id)) clips.splice(Math.min(i, clips.length), 0, c); });
    this.t.clips = clips;
  }

  travel(from, to, verb) {
    if (this.dragging || !this.t) return;
    const h = this.history;
    const entry = h[from].pop();
    if (!entry) return;
    h[to].push({ clips: this.snapshot(), label: entry.label });
    this.pause();
    this.restore(entry.clips);
    this.render();
    this.touch();
    this.seek(this.T);
    this.updateUndo();
    this.status(`${verb} ${entry.label}.`);
  }

  undo() { this.travel('undo', 'redo', 'Undid'); }
  redo() { this.travel('redo', 'undo', 'Redid'); }

  updateUndo() {
    const h = this.t ? this.history : { undo: [], redo: [] };
    const u = h.undo.at(-1), r = h.redo.at(-1);
    this.undoBtn.disabled = !u;
    this.redoBtn.disabled = !r;
    this.undoBtn.title = u ? `Undo ${u.label} (Ctrl+Z)` : 'Nothing to undo';
    this.redoBtn.title = r ? `Redo ${r.label} (Ctrl+Y)` : 'Nothing to redo';
  }

  // ---------- drawing ----------

  clip(id) { return this.t.clips.find((c) => c.id === id); }
  total() { return this.t ? this.t.clips.reduce((s, c) => s + len(c), 0) : 0; }
  startOf(i) { let s = 0; for (let k = 0; k < i; k++) s += len(this.t.clips[k]); return s; }

  render() {
    const ids = new Set(this.t.clips.map((c) => c.id));
    for (const [id, v] of this.views) if (!ids.has(id)) { v.el.remove(); this.views.delete(id); }
    for (const c of this.t.clips) {
      if (!this.views.has(c.id)) this.track.append(this.makeView(c.id).el);
      this.updateView(c);
    }
    if (this.selected && !ids.has(this.selected)) this.selected = null;
    this.empty.hidden = this.t.clips.length > 0;
    this.empty.textContent = 'No clips yet. Finished clips show up here.';
    this.layout();
    this.showInfo();
  }

  makeView(id) {
    const v = {
      start: el('img', { class: 'tle-thumb', alt: '', draggable: false, loading: 'lazy' }),
      end: el('img', { class: 'tle-thumb', alt: '', draggable: false, loading: 'lazy' }),
      label: el('span', { class: 'tle-label' }),
      dur: el('span', { class: 'tle-dur' }),
      hl: el('div', { class: 'tle-handle tle-l', title: 'Drag to trim the start' }),
      hr: el('div', { class: 'tle-handle tle-r', title: 'Drag to trim the end' }),
    };
    v.el = el('div', { class: 'tle-clip' },
      el('div', { class: 'tle-frames' }, v.start, v.end),
      el('div', { class: 'tle-meta' }, v.label, v.dur), v.hl, v.hr);
    v.hl.addEventListener('pointerdown', (e) => this.startTrim(e, id, 'l'));
    v.hr.addEventListener('pointerdown', (e) => this.startTrim(e, id, 'r'));
    v.el.addEventListener('pointerdown', (e) => { if (!e.target.classList.contains('tle-handle')) this.startMove(e, id); });
    this.views.set(id, v);
    return v;
  }

  updateView(c, thumbs = true) {
    const v = this.views.get(c.id);
    v.label.textContent = c.group ? `${c.label} · ${c.group}` : c.label;
    v.dur.textContent = `${len(c).toFixed(1)}s`;
    v.el.title = `${c.label}${c.group ? ` (${c.group})` : ''}\n${fmt(c.in)} – ${fmt(c.out)} of ${fmt(c.duration)}`;
    v.el.classList.toggle('tle-cut-l', c.in > 0.001);
    v.el.classList.toggle('tle-cut-r', c.out < c.duration - 0.05);
    v.el.classList.toggle('tle-selected', this.selected === c.id);
    if (thumbs) {
      const [a, b] = frames(c);
      this.setThumb(v.start, this.api.thumbUrl(c, a));
      this.setThumb(v.end, this.api.thumbUrl(c, b - 1));
    }
  }

  // A changed thumbnail is swapped in once it has loaded, so the old one shows meanwhile.
  setThumb(img, url) {
    if (img.dataset.url === url) return;
    img.dataset.url = url;
    if (!img.getAttribute('src')) { img.src = url; return; }
    img.classList.add('tle-pending');
    const next = new Image();
    next.onload = next.onerror = () => {
      if (img.dataset.url !== url) return;
      img.src = url;
      img.classList.remove('tle-pending');
    };
    next.src = url;
  }

  // Positions every clip. `drag` leaves a slot for a clip being moved; a start being trimmed keeps
  // the clips after it in place until the handle is let go.
  layout(drag = null) {
    if (!this.t) return;
    const pps = this.pps;
    let x = 0, k = 0;
    for (const c of this.t.clips) {
      if (drag && c.id === drag.id) continue;
      if (drag && k === drag.at) { drag.slotX = x; x += drag.w; }
      k++;
      const v = this.views.get(c.id);
      let left = x;
      if (this.trim && this.trim.id === c.id) {
        left = x + (c.in - this.trim.origIn) * pps;
        x += (c.out - this.trim.origIn) * pps;
      } else x += len(c) * pps;
      v.el.style.transform = `translateX(${left}px)`;
      v.el.style.width = `${len(c) * pps}px`;
      v.el.classList.toggle('tle-narrow', len(c) * pps < 90);
    }
    if (drag && k === drag.at) { drag.slotX = x; x += drag.w; }
    const width = Math.max(x + 240, this.scroller.clientWidth);
    this.lane.style.width = `${width}px`;
    this.drawRuler(width);
    this.drawPlayhead();
    this.drawRange();
  }

  // ---------- in and out markers ----------
  // Positions on the timeline, in seconds, saved with it. A marker that is not set stands for the
  // timeline's start (in) or end (out).

  markRange() {
    const [a, b] = this.t?.marks || [null, null];
    if (a == null && b == null) return null;
    const total = this.total();
    const from = clamp(a ?? 0, 0, total), to = clamp(b ?? total, 0, total);
    return to > from ? [from, to] : null;
  }

  setMark(which) {
    if (!this.t?.clips.length) return;
    const m = [...(this.t.marks || [null, null])];
    m[which] = this.T;
    // A marker on the wrong side of the one just set goes away.
    if (m[0] != null && m[1] != null && m[1] <= m[0]) m[1 - which] = null;
    this.t.marks = m;
    this.touch();
    this.drawRange();
  }

  clearMarks() {
    if (!this.t) return;
    this.t.marks = [null, null];
    this.touch();
    this.drawRange();
  }

  drawRange() {
    if (!this.t) return;
    const [a, b] = this.t.marks || [null, null];
    const r = this.markRange();
    this.range.hidden = !r;
    if (r) {
      this.range.style.transform = `translateX(${r[0] * this.pps}px)`;
      this.range.style.width = `${Math.max(2, (r[1] - r[0]) * this.pps)}px`;
      this.range.classList.toggle('tle-open-l', a == null);
      this.range.classList.toggle('tle-open-r', b == null);
    }
    this.markText.textContent = r ? `${fmt(r[0])} – ${fmt(r[1])}` : 'No range';
    this.markText.classList.toggle('tle-muted', !r);
    this.clearBtn.disabled = a == null && b == null;
  }

  drawRuler(width) {
    const pps = this.pps;
    const step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((s) => s * pps >= 70) || 600;
    if (this.rulerKey === `${width}|${pps}`) return;
    this.rulerKey = `${width}|${pps}`;
    const ticks = [];
    for (let s = 0; s * pps < width; s += step) {
      ticks.push(el('span', { class: 'tle-tick', style: `left:${s * pps}px` }, fmtTick(Math.round(s * 10) / 10)));
    }
    this.ruler.replaceChildren(...ticks);
    this.ruler.style.backgroundSize = `${(step * pps) / 5}px 100%`;
  }

  drawPlayhead() {
    this.playhead.style.transform = `translateX(${this.T * this.pps}px)`;
    this.timeText.textContent = `${fmt(this.T)} / ${fmt(this.total())}`;
  }

  showInfo() {
    const c = this.selected && this.clip(this.selected);
    const n = this.t.clips.length;
    this.info.textContent = c
      ? `${c.label}${c.group ? ` · ${c.group}` : ''} · ${fmt(c.in)} – ${fmt(c.out)} of ${fmt(c.duration)}`
      : `${n} clip${n === 1 ? '' : 's'}`;
  }

  setZoom(pps, anchorPx = this.scroller.clientWidth / 2) {
    const t = (this.scroller.scrollLeft + anchorPx) / this.pps;
    this.pps = clamp(pps, 5, 300);
    setPref('pps', this.pps);
    this.layout();
    this.scroller.scrollLeft = t * this.pps - anchorPx;
  }

  wheel(e) {
    if (e.ctrlKey) {
      e.preventDefault();
      const px = e.clientX - this.scroller.getBoundingClientRect().left;
      this.setZoom(this.pps * Math.pow(1.0015, -e.deltaY), px);
      this.zoom.value = String(Math.round(100 * Math.log(this.pps / 5) / Math.log(60)));
    } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      this.scroller.scrollLeft += e.deltaY;
    }
  }

  // ---------- dragging ----------

  // Calls step(lastEvent) every frame while the pointer is near an edge, scrolling the track.
  autoScroll(ev, step) {
    this.lastEv = ev;
    if (this.scrollRaf) return;
    const tick = () => {
      const r = this.scroller.getBoundingClientRect();
      const x = this.lastEv.clientX;
      const d = x < r.left + EDGE ? x - r.left - EDGE : x > r.right - EDGE ? x - r.right + EDGE : 0;
      if (!d || !this.dragging) { this.scrollRaf = null; return; }
      this.scroller.scrollLeft += d / 3;
      step(this.lastEv);
      this.scrollRaf = requestAnimationFrame(tick);
    };
    this.scrollRaf = requestAnimationFrame(tick);
  }

  startMove(e, id) {
    if (e.button !== 0) return;
    e.preventDefault();
    const v = this.views.get(id);
    const c = this.clip(id);
    const x0 = e.clientX;
    const grab = e.clientX - v.el.getBoundingClientRect().left;
    let drag = null;
    capture(v.el, e);

    const move = (ev) => {
      if (!drag) {
        if (Math.abs(ev.clientX - x0) < 5) return;
        this.pause();
        this.dragging = true;
        drag = { id, w: len(c) * this.pps, at: this.t.clips.indexOf(c), before: this.snapshot() };
        v.el.classList.add('tle-dragging');
        this.track.classList.add('tle-moving');
        this.slot.hidden = false;
      }
      const left = ev.clientX - this.track.getBoundingClientRect().left - grab;
      v.el.style.transform = `translateX(${left}px)`;
      // The slot goes where the dragged clip's middle is.
      const mid = left + drag.w / 2;
      let acc = 0, at = 0;
      for (const o of this.t.clips) {
        if (o.id === id) continue;
        const w = len(o) * this.pps;
        if (mid < acc + w / 2) break;
        acc += w;
        at++;
      }
      drag.at = at;
      this.layout(drag);
      v.el.style.transform = `translateX(${left}px)`;
      this.slot.style.transform = `translateX(${drag.slotX}px)`;
      this.slot.style.width = `${drag.w}px`;
      this.autoScroll(ev, move);
    };
    const up = () => {
      v.el.removeEventListener('pointermove', move);
      v.el.removeEventListener('pointerup', up);
      v.el.removeEventListener('pointercancel', up);
      if (!drag) { this.pick(id); return; }
      this.dragging = false;
      const from = this.t.clips.indexOf(c);
      this.t.clips.splice(from, 1);
      this.t.clips.splice(drag.at, 0, c);
      v.el.classList.remove('tle-dragging');
      this.slot.hidden = true;
      this.layout();
      requestAnimationFrame(() => this.track.classList.remove('tle-moving'));
      if (from !== drag.at) {
        this.record(drag.before, `move of ${c.label}`);
        this.touch();
        this.selected = id;
        this.render();
        this.seek(this.startOf(drag.at));
      }
    };
    v.el.addEventListener('pointermove', move);
    v.el.addEventListener('pointerup', up);
    v.el.addEventListener('pointercancel', up);
  }

  startTrim(e, id, edge) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const c = this.clip(id);
    const v = this.views.get(id);
    const handle = edge === 'l' ? v.hl : v.hr;
    const x0 = e.clientX, scroll0 = this.scroller.scrollLeft;
    const orig = { in: c.in, out: c.out };
    const before = this.snapshot();
    const min = MIN_FRAMES / c.fps;
    const snap = (t) => Math.round(t * c.fps) / c.fps;
    this.pause();
    this.dragging = true;
    this.selected = id;
    if (edge === 'l') this.trim = { id, origIn: c.in };
    v.el.classList.add('tle-trimming');
    capture(handle, e);

    const move = (ev) => {
      const dt = (ev.clientX - x0 + this.scroller.scrollLeft - scroll0) / this.pps;
      if (edge === 'l') c.in = clamp(snap(orig.in + dt), 0, c.out - min);
      else c.out = Math.min(clamp(snap(orig.out + dt), c.in + min, c.duration), c.duration);
      this.layout();
      this.updateView(c, false);
      this.showInfo();
      const i = this.t.clips.indexOf(c);
      // The monitor shows the frame at the handle.
      this.T = edge === 'l' ? this.startOf(i) : this.startOf(i) + len(c) - 0.5 / c.fps;
      this.showFrame(c, edge === 'l' ? c.in + 0.5 / c.fps : c.out - 0.5 / c.fps, i);
      this.autoScroll(ev, move);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      this.dragging = false;
      this.trim = null;
      v.el.classList.remove('tle-trimming');
      this.layout();
      this.render();
      if (c.in !== orig.in || c.out !== orig.out) {
        this.record(before, `${edge === 'l' ? 'start' : 'end'} trim of ${c.label}`);
        this.touch();
      }
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }

  pick(id) {
    this.selected = id;
    this.render();
    this.seek(this.startOf(this.t.clips.findIndex((c) => c.id === id)));
  }

  scrub(e) {
    if (e.button !== 0 || !this.t) return;
    capture(this.ruler, e);
    const at = (ev) => this.seek((ev.clientX - this.ruler.getBoundingClientRect().left) / this.pps);
    at(e);
    const up = () => {
      this.ruler.removeEventListener('pointermove', at);
      this.ruler.removeEventListener('pointerup', up);
    };
    this.ruler.addEventListener('pointermove', at);
    this.ruler.addEventListener('pointerup', up);
  }

  key(e) {
    if (e.target.matches('input, select, textarea')) return;
    const c = this.t?.clips[this.idx];
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'y')) {
      e.preventDefault();
      if (k === 'y' || e.shiftKey) this.redo(); else this.undo();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === ' ') { e.preventDefault(); this.toggle(); }
    else if (k === 'i') { e.preventDefault(); this.setMark(0); }
    else if (k === 'o') { e.preventDefault(); this.setMark(1); }
    else if (e.key === 'Home') { e.preventDefault(); this.seek(0); }
    else if (e.key === 'End') { e.preventDefault(); this.seek(this.total()); }
    else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && c) {
      e.preventDefault();
      this.pause();
      this.seek(this.T + (e.key === 'ArrowLeft' ? -1 : 1) / c.fps);
    }
  }

  // ---------- monitor ----------

  get player() { return this.players[this.active]; }
  get standby() { return this.players[1 - this.active]; }

  // Loads clip c into player p (if not loaded) and seeks to t, the time in the clip's file.
  async cue(p, c, t) {
    const url = this.api.mediaUrl(c);
    const token = (p._token = (p._token || 0) + 1);
    if (p.dataset.url !== url) {
      p.dataset.url = url;
      p.src = url;
      await new Promise((res) => {
        p.addEventListener('loadedmetadata', res, { once: true });
        p.addEventListener('error', res, { once: true });
      });
      if (p._token !== token) return false;
    }
    p.dataset.clip = c.id;
    if (p.seeking) p._pending = t;
    else p.currentTime = t;
    return true;
  }

  swap() {
    this.player.classList.remove('tle-on');
    this.active = 1 - this.active;
    this.player.classList.add('tle-on');
  }

  showFrame(c, t, i) {
    this.idx = i;
    this.cue(this.player, c, t);
    this.drawPlayhead();
  }

  async seek(T) {
    if (!this.t) return;
    const clips = this.t.clips;
    this.T = clamp(T, 0, this.total());
    this.drawPlayhead();
    if (!clips.length) return;
    let i = 0, s = 0;
    while (i < clips.length - 1 && s + len(clips[i]) <= this.T) s += len(clips[i++]);
    const c = clips[i];
    this.idx = i;
    const ok = await this.cue(this.player, c, Math.min(c.in + (this.T - s), c.out - 0.5 / c.fps));
    if (ok && this.playing) this.player.play().catch(() => {});
  }

  toggle() { if (this.playing) this.pause(); else this.play(); }

  async play() {
    if (!this.t?.clips.length) return;
    if (this.T >= this.total() - 0.05) this.T = 0;
    this.playing = true;
    this.playBtn.textContent = '❚❚';
    await this.seek(this.T);
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.tick());
  }

  pause() {
    this.playing = false;
    this.playBtn.textContent = '▶';
    cancelAnimationFrame(this.raf);
    for (const p of this.players) p.pause();
  }

  tick() {
    if (!this.playing) return;
    this.step();
    if (this.playing) this.raf = requestAnimationFrame(() => this.tick());
  }

  // Moves the playhead and makes the cut at a clip's end. Runs every frame, and on the players'
  // timeupdate events too: a page in the background gets no animation frames.
  step() {
    if (!this.playing) return;
    const clips = this.t.clips;
    const c = clips[this.idx], next = clips[this.idx + 1];
    const p = this.player;
    if (c && p.dataset.clip === c.id && !p.seeking) {
      const local = p.currentTime;
      this.T = this.startOf(this.idx) + (local - c.in);
      // The next clip waits, cued, in the second player: the cut then needs no loading.
      if (next && c.out - local < 1.5 && this.standby.dataset.clip !== next.id) {
        this.standby.dataset.clip = next.id;
        this.cue(this.standby, next, next.in + 0.5 / next.fps);
      }
      if (local >= c.out - 0.03 || p.ended) {
        if (!next) {
          this.pause();
          this.T = this.total();
        } else {
          this.idx++;
          const s = this.standby;
          if (s.dataset.clip === next.id && s.readyState >= 2 && !s.seeking && Math.abs(s.currentTime - next.in) < 0.1) {
            s.play().catch(() => {});
            p.pause();
            this.swap();
          } else {
            p.pause();
            this.cue(p, next, next.in).then((ok) => ok && this.playing && p.play().catch(() => {}));
          }
        }
      }
    }
    this.drawPlayhead();
    this.follow();
  }

  // Keeps the playhead in view while playing.
  follow() {
    const x = this.T * this.pps, s = this.scroller;
    if (x < s.scrollLeft || x > s.scrollLeft + s.clientWidth - 40) s.scrollLeft = x - 80;
  }

  // ---------- export ----------

  async export() {
    await this.flush();
    if (!this.t?.clips.length) return;
    const mode = this.modeSel.value;
    setPref('mode', mode);
    if (mode === 'range' && !this.markRange()) {
      this.status('Set an in or out marker first: move the playhead there and click Set In or Set Out.', true);
      return;
    }
    this.exportBtn.disabled = true;
    this.status(mode === 'clips' ? 'Choose a folder for the clips… (the dialog may open behind this window)'
      : 'Choose where to save the video… (the dialog may open behind this window)');
    let job;
    try {
      job = await this.api.exportStart(this.t.id, mode);
    } catch (e) {
      this.status('Export failed: ' + e.message, true);
      this.exportBtn.disabled = false;
      return;
    }
    if (job.cancelled) { this.status('Export cancelled.'); this.exportBtn.disabled = false; return; }
    this.exportJob = job.id;
    this.bar.hidden = this.cancelBtn.hidden = false;
    while (job.state === 'running' && !this.closed) {
      this.bar.firstChild.style.width = `${Math.round(job.progress * 100)}%`;
      this.status(`Exporting “${this.t.name}”… ${Math.round(job.progress * 100)}%`);
      await new Promise((r) => setTimeout(r, 500));
      try { job = await this.api.exportStatus(job.id); } catch (e) { this.status(e.message, true); break; }
    }
    this.bar.hidden = this.cancelBtn.hidden = true;
    this.exportJob = null;
    this.exportBtn.disabled = false;
    if (job.state === 'done') {
      this.status(job.files.length === 1 ? `Exported to ${job.files[0]}` : `Exported ${job.files.length} clips to ${job.target}`);
    } else if (job.state === 'cancelled') this.status('Export cancelled.');
    else if (job.state === 'error') this.status('Export failed: ' + job.error, true);
  }

  // ---------- teardown ----------

  async destroy() {
    this.closed = true;
    this.pause();
    for (const p of this.players) { p.removeAttribute('src'); p.load(); }
    window.removeEventListener('resize', this.onResize);
    this.root.removeEventListener('keydown', this.onKey);
    await this.flush();
  }
}

// The editor in a modal window. Returns the editor; it is destroyed when the window closes.
export function openTimeline(opts = {}) {
  const dlg = el('dialog', { class: 'tle-dialog' });
  document.body.append(dlg);
  const editor = new TimelineEditor(dlg, { ...opts, onClose: () => dlg.close() });
  dlg.addEventListener('close', async () => {
    await editor.destroy();
    dlg.remove();
    opts.onClosed?.();
  });
  dlg.showModal();
  return editor;
}
