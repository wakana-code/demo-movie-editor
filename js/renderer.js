// File: js/renderer.js
'use strict';

// ===== 基本設定 =====
const FPS = 30;

const SIZES = {
  '16:9': { w: 1920, h: 1080 },
  '1:1': { w: 1080, h: 1080 },
};

const THEMES = {
  dark: { bg: '#000000', fg: '#ffffff', sub: 'rgba(255,255,255,0.6)' },
  light: { bg: '#ffffff', fg: '#0b0b0f', sub: 'rgba(0,0,0,0.55)' },
};

const FONT_FAMILY =
  'system-ui, -apple-system, "Helvetica Neue", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif';

function font(size, weight = 800) {
  return `${weight} ${Math.round(size)}px ${FONT_FAMILY}`;
}

// ===== ユーティリティ =====
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const lerp = (a, b, t) => a + (b - a) * t;
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function progress(t, start, duration) {
  return clamp((t - start) / duration, 0, 1);
}

function pick(arr, rand) {
  return arr[Math.floor(rand() * arr.length)];
}

function shuffledIndices(n, rand) {
  const arr = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ===== テキスト処理 =====
const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff\uff00-\uffef]/;

function segmentWords(text) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const segmenter = new Intl.Segmenter('ja', { granularity: 'word' });
    return Array.from(segmenter.segment(text), (s) => s.segment);
  }
  return text.match(/\s+|[A-Za-z0-9'’\-]+|./gu) || [];
}

const JA_BREAK_AFTER = new Set([
  'は', 'が', 'を', 'に', 'で', 'と', 'へ', 'も', 'の', 'や',
  'から', 'まで', 'より', '、', '。', '！', '？', '!', '?', ',',
]);

// 用途テキストをフレーズに分ける
function splitPhrases(text) {
  const raw = text.trim();
  if (!raw) return [];

  // 「/」があればユーザー指定の区切りを優先
  if (raw.includes('/')) {
    return raw.split('/').map((s) => s.trim()).filter(Boolean);
  }

  // 日本語：助詞や句読点のあとで区切る
  if (CJK_RE.test(raw)) {
    if (Array.from(raw).length <= 8) return [raw];
    const phrases = [];
    let current = '';
    for (const token of segmentWords(raw)) {
      current += token;
      const len = Array.from(current.trim()).length;
      if ((JA_BREAK_AFTER.has(token.trim()) && len >= 2) || len >= 8) {
        phrases.push(current.trim());
        current = '';
      }
    }
    const rest = current.trim();
    if (rest) {
      if (Array.from(rest).length <= 1 && phrases.length) {
        phrases[phrases.length - 1] += rest;
      } else {
        phrases.push(rest);
      }
    }
    return phrases.map((p) => p.replace(/[、。,]$/, ''));
  }

  // 英語：2〜3語ずつ
  const words = raw.split(/\s+/);
  if (words.length <= 3) return [raw];
  const size = words.length >= 9 ? 3 : 2;
  const phrases = [];
  for (let i = 0; i < words.length; i += size) {
    phrases.push(words.slice(i, i + size).join(' '));
  }
  if (phrases.length > 1 && words.length % size === 1) {
    const last = phrases.pop();
    phrases[phrases.length - 1] += ` ${last}`;
  }
  return phrases;
}

function fullTextOf(text) {
  const raw = text.trim();
  return CJK_RE.test(raw)
    ? raw.replace(/\s*\/\s*/g, '')
    : raw.replace(/\s*\/\s*/g, ' ');
}

function fitSingleLine(ctx, text, maxW, startSize, weight = 800, minSize = 12) {
  ctx.font = font(startSize, weight);
  const w = ctx.measureText(text).width;
  if (w <= maxW) return startSize;
  return Math.max(minSize, (startSize * maxW) / w);
}

function wrapLines(ctx, text, maxW) {
  const lines = [];
  let current = '';
  for (const token of segmentWords(text)) {
    const test = current + token;
    if (current.trim() && ctx.measureText(test).width > maxW) {
      lines.push(current.trim());
      current = token.trimStart();
    } else {
      current = test;
    }
  }
  if (current.trim()) lines.push(current.trim());
  return lines;
}

function fitMultiLine(ctx, text, maxW, maxH, startSize, maxLines = 3, lineHeight = 1.15) {
  let size = startSize;
  for (let i = 0; i < 40; i++) {
    ctx.font = font(size);
    const lines = wrapLines(ctx, text, maxW);
    const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const totalH = lines.length * size * lineHeight;
    if (lines.length <= maxLines && widest <= maxW && totalH <= maxH) {
      return { size, lines, lineHeight };
    }
    size *= 0.92;
  }
  ctx.font = font(size);
  return { size, lines: wrapLines(ctx, text, maxW), lineHeight };
}

// ===== 画像描画 =====
function drawCover(ctx, img, x, y, w, h, scale = 1, fx = 0.5, fy = 0.5) {
  const s = Math.max(w / img.width, h / img.height) * scale;
  const dw = img.width * s;
  const dh = img.height * s;
  const dx = clamp(x + w / 2 - dw * fx, x + w - dw, x);
  const dy = clamp(y + h / 2 - dh * fy, y + h - dh, y);
  ctx.drawImage(img, dx, dy, dw, dh);
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.rect(x, y, w, h);
  }
}

function clipRect(ctx, x, y, w, h) {
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
}

// 画像がないときのサンプル模様
const patternCache = new Map();

function getPatternSources(seed) {
  if (patternCache.has(seed)) return patternCache.get(seed);
  if (patternCache.size > 5) patternCache.clear();

  const rand = mulberry32(seed * 7919 + 13);
  const list = [];
  for (let i = 0; i < 8; i++) {
    const c = document.createElement('canvas');
    c.width = 960;
    c.height = 600;
    const g = c.getContext('2d');
    const hue = Math.floor(rand() * 360);
    const grad = g.createLinearGradient(0, 0, 960, 600);
    grad.addColorStop(0, `hsl(${hue}, 80%, 55%)`);
    grad.addColorStop(1, `hsl(${(hue + 60) % 360}, 85%, 40%)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 960, 600);

    g.fillStyle = 'rgba(255,255,255,0.2)';
    if (i % 3 === 0) {
      for (let k = 0; k < 6; k++) {
        g.beginPath();
        g.arc(rand() * 960, rand() * 600, 40 + rand() * 160, 0, Math.PI * 2);
        g.fill();
      }
    } else if (i % 3 === 1) {
      g.save();
      g.translate(480, 300);
      g.rotate(-0.5);
      for (let k = -12; k < 12; k++) g.fillRect(k * 70, -800, 30, 1600);
      g.restore();
    } else {
      for (let k = 0; k < 5; k++) {
        g.fillRect(rand() * 900, rand() * 540, 80 + rand() * 300, 40 + rand() * 200);
      }
    }

    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.font = font(64);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(`SAMPLE ${i + 1}`, 480, 300);
    list.push(c);
  }
  patternCache.set(seed, list);
  return list;
}

// ===== モンタージュ =====
const EFFECTS_FIRST = ['plain', 'plain', 'plain', 'zoomIn', 'zoomOut'];
const EFFECTS_REPEAT = ['zoomIn', 'zoomOut', 'rotate', 'mirror', 'mono', 'duo', 'grid', 'split', 'card'];

function buildCuts(sourceCount, seconds, rand) {
  const startInterval = 0.42;
  const endInterval = 2 / FPS;
  const cuts = [];

  // だんだん切り替えが速くなる
  let t = 0;
  while (t < seconds - 1e-6) {
    const p = t / seconds;
    const d = Math.max(endInterval, startInterval * Math.pow(endInterval / startInterval, Math.pow(p, 0.75)));
    cuts.push({ start: t, dur: d });
    t += d;
  }
  const k = seconds / t;
  let acc = 0;
  for (const c of cuts) {
    c.dur *= k;
    c.start = acc;
    acc += c.dur;
  }

  // 画像と加工を割り当てる（1周目はほぼそのまま、2周目以降は加工して水増し）
  let order = [];
  let prevLast = -1;
  cuts.forEach((c, i) => {
    const k2 = i % sourceCount;
    if (k2 === 0) {
      order = shuffledIndices(sourceCount, rand);
      if (sourceCount > 1 && order[0] === prevLast) {
        [order[0], order[1]] = [order[1], order[0]];
      }
    }
    c.src = order[k2];
    if (k2 === sourceCount - 1) prevLast = c.src;
    c.effect = i < sourceCount ? pick(EFFECTS_FIRST, rand) : pick(EFFECTS_REPEAT, rand);
    c.extra = [0, 1, 2].map(() => Math.floor(rand() * sourceCount));
    c.fx = 0.3 + rand() * 0.4;
    c.fy = 0.3 + rand() * 0.4;
    c.rot = (rand() * 2 - 1) * 0.14;
    c.spin = (rand() * 2 - 1) * 0.05;
  });
  return cuts;
}

function findCut(cuts, t) {
  for (let i = cuts.length - 1; i >= 0; i--) {
    if (t >= cuts[i].start) return cuts[i];
  }
  return cuts[0];
}

function drawCut(ctx, c, q, sources, env) {
  const { W, H, theme, accent } = env;
  const img = sources[c.src];
  const unit = Math.min(W, H);

  switch (c.effect) {
    case 'zoomIn':
      drawCover(ctx, img, 0, 0, W, H, lerp(1.15, 1.5, easeOutCubic(q)), c.fx, c.fy);
      break;

    case 'zoomOut':
      drawCover(ctx, img, 0, 0, W, H, lerp(1.5, 1.12, easeOutCubic(q)), c.fx, c.fy);
      break;

    case 'rotate':
      ctx.translate(W / 2, H / 2);
      ctx.rotate(c.rot + c.spin * q);
      ctx.translate(-W / 2, -H / 2);
      drawCover(ctx, img, 0, 0, W, H, 1.4, c.fx, c.fy);
      break;

    case 'mirror':
      ctx.translate(W, 0);
      ctx.scale(-1, 1);
      drawCover(ctx, img, 0, 0, W, H, lerp(1.05, 1.15, q), c.fx, c.fy);
      break;

    case 'mono':
      ctx.filter = 'grayscale(1) contrast(1.25)';
      drawCover(ctx, img, 0, 0, W, H, lerp(1.1, 1.2, q), c.fx, c.fy);
      ctx.filter = 'none';
      break;

    case 'duo':
      ctx.filter = 'grayscale(1) contrast(1.2)';
      drawCover(ctx, img, 0, 0, W, H, lerp(1.1, 1.18, q), c.fx, c.fy);
      ctx.filter = 'none';
      ctx.globalCompositeOperation = 'color';
      ctx.fillStyle = accent;
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
      break;

    case 'grid': {
      const gap = Math.round(unit * 0.012);
      const cw = (W - gap) / 2;
      const ch = (H - gap) / 2;
      const srcs = [c.src, ...c.extra];
      ctx.fillStyle = theme.bg;
      ctx.fillRect(0, 0, W, H);
      for (let j = 0; j < 4; j++) {
        const x = (j % 2) * (cw + gap);
        const y = Math.floor(j / 2) * (ch + gap);
        ctx.save();
        clipRect(ctx, x, y, cw, ch);
        drawCover(ctx, sources[srcs[j]], x, y, cw, ch, lerp(1.05, 1.15, q), c.fx, c.fy);
        ctx.restore();
      }
      break;
    }

    case 'split': {
      const gap = Math.round(unit * 0.01);
      const half = (W - gap) / 2;
      const off = (1 - easeOutCubic(clamp(q * 3, 0, 1))) * H * 0.2;
      ctx.fillStyle = theme.bg;
      ctx.fillRect(0, 0, W, H);
      ctx.save();
      clipRect(ctx, 0, 0, half, H);
      drawCover(ctx, img, 0, -off, half, H, 1.1, c.fx, c.fy);
      ctx.restore();
      ctx.save();
      clipRect(ctx, half + gap, 0, half, H);
      drawCover(ctx, sources[c.extra[0]], half + gap, off, half, H, 1.1, c.fx, c.fy);
      ctx.restore();
      break;
    }

    case 'card': {
      ctx.fillStyle = accent;
      ctx.fillRect(0, 0, W, H);
      const s = lerp(0.9, 1, easeOutBack(clamp(q * 2.5, 0, 1)));
      const cw = W * 0.72 * s;
      const ch = H * 0.72 * s;
      const x = (W - cw) / 2;
      const y = (H - ch) / 2;
      const r = unit * 0.03;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.35)';
      ctx.shadowBlur = unit * 0.04;
      ctx.shadowOffsetY = unit * 0.015;
      roundRectPath(ctx, x, y, cw, ch, r);
      ctx.fillStyle = '#000';
      ctx.fill();
      ctx.restore();
      ctx.save();
      roundRectPath(ctx, x, y, cw, ch, r);
      ctx.clip();
      drawCover(ctx, img, x, y, cw, ch, 1.02, c.fx, c.fy);
      ctx.restore();
      break;
    }

    default:
      drawCover(ctx, img, 0, 0, W, H, lerp(1.0, 1.06, q), c.fx, c.fy);
  }
}

// ===== 各セクション =====
function makeIntroSegment(text, mctx, env) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const { W, H } = env;

  const size = fitSingleLine(mctx, words.join(' '), W * 0.82, H * 0.17);
  mctx.font = font(size);
  const space = mctx.measureText(' ').width;
  const widths = words.map((w) => mctx.measureText(w).width);
  const total = widths.reduce((a, b) => a + b, 0) + space * (words.length - 1);
  const xs = [];
  let x = (W - total) / 2;
  for (const w of widths) {
    xs.push(x);
    x += w + space;
  }

  const STEP = 0.55;
  const ANIM = 0.45;
  const HOLD = 0.6;

  return {
    type: 'intro',
    label: 'オープニング',
    duration: (words.length - 1) * STEP + ANIM + HOLD,
    draw(ctx, lt) {
      ctx.font = font(size);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = env.theme.fg;
      words.forEach((w, i) => {
        const p = easeOutCubic(progress(lt, i * STEP, ANIM));
        if (p <= 0) return;
        ctx.globalAlpha = p;
        ctx.filter = p < 1 ? `blur(${(1 - p) * size * 0.08}px)` : 'none';
        ctx.fillText(w, xs[i], H / 2 + (1 - p) * size * 0.3);
      });
      ctx.filter = 'none';
      ctx.globalAlpha = 1;
    },
  };
}

function makeMontageSegment(sources, seconds, rand, env) {
  const secs = clamp(Number(seconds) || 3.5, 1.5, 10);
  const PAUSE = 0.5; // 一呼吸
  const cuts = buildCuts(sources.length, secs, rand);

  return {
    type: 'montage',
    label: '画像モンタージュ',
    duration: secs + PAUSE,
    cutCount: cuts.length,
    draw(ctx, lt) {
      if (lt >= secs) return;
      const c = findCut(cuts, lt);
      const q = clamp((lt - c.start) / c.dur, 0, 1);
      ctx.save();
      drawCut(ctx, c, q, sources, env);
      ctx.restore();
      // 始まりの「バーン」フラッシュ
      if (lt < 0.12) {
        ctx.globalAlpha = 1 - lt / 0.12;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, env.W, env.H);
        ctx.globalAlpha = 1;
      }
    },
  };
}

function makeUseCaseSegment(text, mctx, env) {
  const full = fullTextOf(text);
  if (!full) return null;
  const { W, H } = env;

  const phrases = splitPhrases(text);
  const multi = phrases.length > 1;
  const PHRASE = 0.5;
  const GAP = 0.15;
  const BOOM_HOLD = 2.2;
  const FADE = 0.3;

  const phraseSizes = phrases.map((p) => fitSingleLine(mctx, p, W * 0.86, H * 0.15));
  const layout = fitMultiLine(mctx, full, W * 0.84, H * 0.62, H * 0.13, 3);
  mctx.font = font(layout.size);
  const widest = Math.max(...layout.lines.map((l) => mctx.measureText(l).width));

  const boomStart = multi ? phrases.length * PHRASE + GAP : 0;
  const duration = boomStart + BOOM_HOLD;

  return {
    type: 'usecase',
    label: '用途',
    duration,
    draw(ctx, lt) {
      const { theme, accent } = env;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = theme.fg;

      // フレーズを1つずつ
      if (lt < boomStart) {
        const i = Math.floor(lt / PHRASE);
        if (i >= phrases.length) return;
        const p = easeOutCubic(progress(lt - i * PHRASE, 0, 0.14));
        const s = lerp(1.2, 1, p);
        ctx.globalAlpha = p;
        ctx.translate(W / 2, H / 2);
        ctx.scale(s, s);
        ctx.font = font(phraseSizes[i]);
        ctx.fillText(phrases[i], 0, 0);
        return;
      }

      // 全文ドーン
      const ft = lt - boomStart;
      const scale = lerp(1.8, 1, easeOutBack(progress(ft, 0, 0.24)));
      const alpha = clamp(ft / 0.06, 0, 1) * (1 - progress(lt, duration - FADE, FADE));
      const shake = ft < 0.45 ? (1 - ft / 0.45) * H * 0.01 : 0;
      const dx = Math.sin(ft * 95) * shake;
      const dy = Math.cos(ft * 71) * shake;

      const { size, lines, lineHeight } = layout;
      const lh = size * lineHeight;
      const totalH = lines.length * lh;

      ctx.globalAlpha = alpha;
      ctx.save();
      ctx.translate(W / 2 + dx, H / 2 + dy);
      ctx.scale(scale, scale);
      ctx.font = font(size);
      lines.forEach((line, i) => {
        ctx.fillText(line, 0, -totalH / 2 + lh * (i + 0.5));
      });
      const u = easeOutCubic(progress(ft, 0.18, 0.4));
      if (u > 0) {
        const bw = widest * u;
        ctx.fillStyle = accent;
        ctx.fillRect(-bw / 2, totalH / 2 + size * 0.18, bw, Math.max(4, size * 0.08));
      }
      ctx.restore();

      if (ft < 0.1) {
        ctx.globalAlpha = 0.25 * (1 - ft / 0.1);
        ctx.fillStyle = theme.fg;
        ctx.fillRect(0, 0, W, H);
      }
      ctx.globalAlpha = 1;
    },
  };
}

function makeEndingSegment(name, sub, mctx, env) {
  const chars = Array.from(name.trim());
  if (!chars.length) return null;
  const { W, H } = env;

  const text = chars.join('');
  const size = fitSingleLine(mctx, text, W * 0.78, H * 0.13);
  mctx.font = font(size);
  const fullW = mctx.measureText(text).width;
  const cursorW = Math.max(4, size * 0.07);
  const gap = size * 0.08;
  const x0 = (W - fullW - gap - cursorW) / 2;

  const subText = sub.trim();
  const subSize = subText ? fitSingleLine(mctx, subText, W * 0.8, size * 0.3, 500, 10) : 0;
  const cy = subText ? H / 2 - size * 0.2 : H / 2;

  const START = 0.35;
  const INTERVAL = 0.09;
  const HOLD = 2.2;
  const FADE = 0.45;
  const typeEnd = START + chars.length * INTERVAL;
  const duration = typeEnd + HOLD;

  return {
    type: 'ending',
    label: 'エンディング',
    duration,
    draw(ctx, lt) {
      const { theme, accent } = env;
      const fade = 1 - progress(lt, duration - FADE, FADE);
      const typed = lt < START ? 0 : Math.min(chars.length, Math.floor((lt - START) / INTERVAL) + 1);
      const str = chars.slice(0, typed).join('');

      ctx.globalAlpha = fade;
      ctx.font = font(size);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = theme.fg;
      ctx.fillText(str, x0, cy);

      // カーソル（入力中は点灯、それ以外は点滅）
      const typing = lt >= START && lt < typeEnd;
      const blinkOn = Math.floor(lt / 0.5) % 2 === 0;
      if (typing || blinkOn) {
        const cx = x0 + ctx.measureText(str).width + (typed ? gap : 0);
        ctx.fillStyle = accent;
        ctx.fillRect(cx, cy - size * 0.55, cursorW, size * 1.1);
      }

      if (subText) {
        const sp = easeOutCubic(progress(lt, typeEnd + 0.15, 0.5));
        if (sp > 0) {
          ctx.globalAlpha = fade * sp;
          ctx.font = font(subSize, 500);
          ctx.textAlign = 'center';
          ctx.fillStyle = theme.sub;
          ctx.fillText(subText, W / 2, cy + size * 0.95 + (1 - sp) * subSize * 0.5);
        }
      }
      ctx.globalAlpha = 1;
    },
  };
}

// ===== タイムライン =====
// 第2段階で、用途とエンディングの間にデモ動画のセクションを追加する
function buildTimeline(project, mctx) {
  const { w: W, h: H } = SIZES[project.size] || SIZES['16:9'];
  const theme = THEMES[project.theme] || THEMES.dark;
  const accent = project.accent || '#6e56ff';
  const seed = project.seed || 1;
  const rand = mulberry32(seed * 9973);
  const hasImages = project.images && project.images.length > 0;
  const sources = hasImages ? project.images : getPatternSources(seed);
  const env = { W, H, theme, accent };

  const segments = [];
  const add = (seg) => {
    if (seg && seg.duration > 0) segments.push(seg);
  };

  add(makeIntroSegment(project.introText || '', mctx, env));
  const montage = makeMontageSegment(sources, project.montageSeconds, rand, env);
  add(montage);
  add(makeUseCaseSegment(project.useCase || '', mctx, env));
  add(makeEndingSegment(project.appName || '', project.endSub || '', mctx, env));

  let t = 0;
  for (const seg of segments) {
    seg.start = t;
    t += seg.duration;
  }

  return {
    W,
    H,
    theme,
    accent,
    segments,
    duration: t,
    totalFrames: Math.max(1, Math.round(t * FPS)),
    cutCount: montage.cutCount,
  };
}

function findSegment(tl, t) {
  for (const seg of tl.segments) {
    if (t >= seg.start && t < seg.start + seg.duration) return seg;
  }
  return tl.segments[tl.segments.length - 1] || null;
}

// プレビューと書き出しの両方がこの関数で1フレームを描く
function renderFrame(ctx, tl, t) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  ctx.fillStyle = tl.theme.bg;
  ctx.fillRect(0, 0, tl.W, tl.H);

  const seg = findSegment(tl, t);
  if (!seg) return;
  ctx.save();
  seg.draw(ctx, t - seg.start);
  ctx.restore();
}