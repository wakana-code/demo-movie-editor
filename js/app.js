// File: js/app.js
'use strict';

const STORAGE_KEY = 'demo-maker:v1';

const DEFAULT_SETTINGS = {
  size: '16:9',
  theme: 'dark',
  accent: '#6e56ff',
  introText: 'you can now',
  useCase: 'edit documents with AI in seconds',
  montageSeconds: 3.5,
  appName: 'MyApp',
  endSub: '',
  seed: 1,
};

const $ = (selector) => document.querySelector(selector);

const els = {
  canvas: $('#preview'),
  playBtn: $('#playBtn'),
  seek: $('#seek'),
  timeLabel: $('#timeLabel'),
  sections: $('#sections'),
  exportBtn: $('#exportBtn'),
  cancelBtn: $('#cancelBtn'),
  progress: $('#progress'),
  progressBar: $('#progressBar'),
  exportHint: $('#exportHint'),
  downloadLink: $('#downloadLink'),
  panelFieldset: $('#panelFieldset'),
  fileInput: $('#fileInput'),
  pickBtn: $('#pickBtn'),
  dropzone: $('#dropzone'),
  thumbs: $('#thumbs'),
  imageInfo: $('#imageInfo'),
  shuffleBtn: $('#shuffleBtn'),
  clearBtn: $('#clearBtn'),
  montageValue: $('#montageValue'),
  toast: $('#toast'),
};

const ctx = els.canvas.getContext('2d', { alpha: false });

const state = {
  settings: loadSettings(),
  images: [], // { id, bitmap, url }
  timeline: null,
  time: 0,
  playing: false,
  exporting: false,
  abort: null,
  downloadUrl: null,
};

let nextImageId = 1;
let anchorWall = 0;
let anchorTime = 0;
let rebuildTimer = 0;
let toastTimer = 0;

// ===== 設定の保存 =====
function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return { ...DEFAULT_SETTINGS, ...saved };
  } catch (_) {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
  } catch (_) {
    // 保存できなくても動作は続ける
  }
}

function currentProject() {
  return { ...state.settings, images: state.images.map((img) => img.bitmap) };
}

// ===== タイムライン構築と描画 =====
function rebuild() {
  const { w, h } = SIZES[state.settings.size] || SIZES['16:9'];
  if (els.canvas.width !== w || els.canvas.height !== h) {
    els.canvas.width = w;
    els.canvas.height = h;
  }
  state.timeline = buildTimeline(currentProject(), ctx);
  els.seek.max = String(state.timeline.duration);
  els.seek.step = String(1 / FPS);
  state.time = Math.min(state.time, state.timeline.duration);
  anchorWall = performance.now();
  anchorTime = state.time;
  renderSections();
  renderImageInfo();
  draw();
}

function scheduleRebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(rebuild, 150);
}

function frameTime(t) {
  const tl = state.timeline;
  const f = Math.min(Math.floor(t * FPS + 1e-6), tl.totalFrames - 1);
  return Math.max(0, f) / FPS;
}

function formatTime(t) {
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

function draw() {
  const tl = state.timeline;
  if (!tl) return;
  renderFrame(ctx, tl, frameTime(state.time));
  els.seek.value = String(state.time);
  els.timeLabel.textContent = `${formatTime(state.time)} / ${formatTime(tl.duration)}`;
  const playhead = els.sections.querySelector('.playhead');
  if (playhead && tl.duration > 0) {
    playhead.style.left = `${(state.time / tl.duration) * 100}%`;
  }
}

function renderSections() {
  const tl = state.timeline;
  els.sections.innerHTML = '';
  for (const seg of tl.segments) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `section section-${seg.type}`;
    btn.style.flexGrow = String(seg.duration);
    btn.textContent = seg.label;
    btn.title = `${seg.label}（${seg.duration.toFixed(1)}秒）`;
    btn.addEventListener('click', () => seekTo(seg.start));
    els.sections.appendChild(btn);
  }
  const playhead = document.createElement('div');
  playhead.className = 'playhead';
  els.sections.appendChild(playhead);
}

// ===== 再生 =====
function play() {
  const tl = state.timeline;
  if (state.time >= tl.duration - 1e-3) state.time = 0;
  state.playing = true;
  anchorWall = performance.now();
  anchorTime = state.time;
  els.playBtn.textContent = '❚❚ 一時停止';
  requestAnimationFrame(tick);
}

function pause() {
  state.playing = false;
  els.playBtn.textContent = '▶ 再生';
}

function tick(now) {
  if (!state.playing) return;
  const tl = state.timeline;
  state.time = anchorTime + Math.max(0, now - anchorWall) / 1000;
  if (state.time >= tl.duration) {
    state.time = tl.duration;
    pause();
  }
  draw();
  if (state.playing) requestAnimationFrame(tick);
}

function seekTo(t) {
  state.time = clamp(t, 0, state.timeline.duration);
  anchorWall = performance.now();
  anchorTime = state.time;
  draw();
}

// ===== 画像 =====
async function addImageFiles(files) {
  if (state.exporting) return;
  const list = Array.from(files).filter((f) => f.type.startsWith('image/'));
  if (!list.length) return;

  for (const file of list) {
    try {
      let bitmap = await createImageBitmap(file);
      const MAX = 1920;
      const scale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height));
      if (scale < 1) {
        const small = await createImageBitmap(bitmap, {
          resizeWidth: Math.round(bitmap.width * scale),
          resizeHeight: Math.round(bitmap.height * scale),
          resizeQuality: 'high',
        });
        bitmap.close();
        bitmap = small;
      }
      state.images.push({ id: nextImageId++, bitmap, url: URL.createObjectURL(file) });
    } catch (e) {
      console.warn(e);
      showToast(`${file.name || '画像'} を読み込めませんでした`);
    }
  }
  renderThumbs();
  rebuild();
}

function removeImage(id) {
  const index = state.images.findIndex((img) => img.id === id);
  if (index < 0) return;
  const [img] = state.images.splice(index, 1);
  rebuild();
  img.bitmap.close();
  URL.revokeObjectURL(img.url);
  renderThumbs();
}

function clearImages() {
  const old = state.images;
  state.images = [];
  rebuild();
  for (const img of old) {
    img.bitmap.close();
    URL.revokeObjectURL(img.url);
  }
  renderThumbs();
}

function renderThumbs() {
  els.thumbs.innerHTML = '';
  for (const img of state.images) {
    const item = document.createElement('div');
    item.className = 'thumb';
    const image = document.createElement('img');
    image.src = img.url;
    image.alt = '';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'thumb-del';
    del.textContent = '×';
    del.title = '削除';
    del.addEventListener('click', () => removeImage(img.id));
    item.append(image, del);
    els.thumbs.appendChild(item);
  }
  els.clearBtn.hidden = state.images.length === 0;
}

function renderImageInfo() {
  const n = state.images.length;
  const cuts = state.timeline.cutCount;
  let note = '';
  if (n === 0) {
    note = '（画像がないのでサンプル模様で表示中）';
  } else if (n < cuts) {
    note = '（足りない分はズーム・回転・分割などで自動で水増し）';
  }
  els.imageInfo.textContent = `画像 ${n}枚 ／ 切り替え ${cuts}回 ${note}`;
}

// ===== 書き出し =====
function makeFileName() {
  const base = (state.settings.appName || 'demo').replace(/[\\/:*?"<>|\s]+/g, '_');
  const kind = state.settings.size === '1:1' ? 'square' : 'landscape';
  return `${base}_${kind}.mp4`;
}

function setExportUI(exporting) {
  els.exportBtn.disabled = exporting;
  els.playBtn.disabled = exporting;
  els.cancelBtn.hidden = !exporting;
  els.progress.hidden = !exporting;
  els.panelFieldset.disabled = exporting;
  if (exporting) {
    els.progressBar.style.width = '0%';
    els.downloadLink.hidden = true;
  }
}

async function startExport() {
  if (state.exporting) return;
  pause();
  state.exporting = true;
  state.abort = new AbortController();
  setExportUI(true);

  try {
    const blob = await exportMp4(currentProject(), {
      signal: state.abort.signal,
      onProgress: (p) => {
        const pct = Math.round(p * 100);
        els.progressBar.style.width = `${pct}%`;
        els.exportHint.textContent = `書き出し中… ${pct}%`;
      },
    });
    if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl);
    state.downloadUrl = URL.createObjectURL(blob);
    const name = makeFileName();
    els.downloadLink.href = state.downloadUrl;
    els.downloadLink.download = name;
    els.downloadLink.textContent = `⬇ ${name}（${(blob.size / 1024 / 1024).toFixed(1)} MB）`;
    els.downloadLink.hidden = false;
    els.downloadLink.click();
    els.exportHint.textContent = '書き出し完了！ダウンロードフォルダを確認してください。';
  } catch (e) {
    if (e.name === 'AbortError') {
      els.exportHint.textContent = '書き出しを中止しました。';
    } else {
      console.error(e);
      els.exportHint.textContent = `エラー：${e.message}`;
    }
  } finally {
    state.exporting = false;
    state.abort = null;
    setExportUI(false);
  }
}

// ===== その他 =====
function showToast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 2500);
}

function updateMontageLabel() {
  els.montageValue.textContent = `${Number(state.settings.montageSeconds).toFixed(1)}秒`;
}

function bindSettings() {
  document.querySelectorAll('[data-key]').forEach((el) => {
    const key = el.dataset.key;
    el.value = state.settings[key];
    el.addEventListener('input', () => {
      state.settings[key] = el.type === 'range' ? Number(el.value) : el.value;
      if (key === 'montageSeconds') updateMontageLabel();
      saveSettings();
      scheduleRebuild();
    });
  });
}

function bindEvents() {
  els.playBtn.addEventListener('click', () => (state.playing ? pause() : play()));
  els.seek.addEventListener('input', () => seekTo(Number(els.seek.value)));

  els.exportBtn.addEventListener('click', startExport);
  els.cancelBtn.addEventListener('click', () => state.abort && state.abort.abort());

  // Finderのダイアログで選ぶ
  els.pickBtn.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => {
    addImageFiles(els.fileInput.files);
    els.fileInput.value = '';
  });

  els.shuffleBtn.addEventListener('click', () => {
    state.settings.seed = (state.settings.seed || 1) + 1;
    saveSettings();
    rebuild();
  });
  els.clearBtn.addEventListener('click', clearImages);

  // ⌘V で貼り付け
  document.addEventListener('paste', (e) => {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    const files = [];
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length) {
      e.preventDefault();
      addImageFiles(files);
      showToast(`${files.length}枚 貼り付けました`);
    }
  });

  // ドラッグ＆ドロップ（画面のどこに落としてもOK）
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    els.dropzone.classList.add('over');
  });
  window.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null) els.dropzone.classList.remove('over');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    els.dropzone.classList.remove('over');
    if (e.dataTransfer && e.dataTransfer.files.length) addImageFiles(e.dataTransfer.files);
  });

  // スペースキーで再生／停止
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (e.code === 'Space' && !['input', 'textarea', 'select', 'button'].includes(tag)) {
      e.preventDefault();
      if (!state.exporting) state.playing ? pause() : play();
    }
  });
}

function init() {
  bindSettings();
  bindEvents();
  updateMontageLabel();
  renderThumbs();
  rebuild();
  if (typeof VideoEncoder === 'undefined') {
    els.exportHint.textContent = '⚠ このブラウザは書き出しに対応していません。Google Chrome で開いてください（プレビューは使えます）。';
    els.exportBtn.disabled = true;
  }
}

init();