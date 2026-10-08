// Auto-subtitles: word-timed transcript + a CapCut-style Canvas2D renderer
// shared by the editor preview overlay and the exporter (so both match).
// Word times are source-recording ms, like zoom/effect segments.

import type { Transcript } from "./native";

export type CaptionWord = { text: string; startMs: number; endMs: number };

export type HighlightMode = "none" | "color" | "pill" | "karaoke";
export type CaptionAnim = "none" | "fade" | "pop" | "slide";

export type CaptionStyle = {
  font: string;
  fontWeight: number;
  /** Percent of the output frame height. */
  fontSize: number;
  uppercase: boolean;
  textColor: string;
  strokeColor: string;
  /** Outline thickness as a percent of the font size. */
  strokeWidth: number;
  /** 0..1 drop-shadow strength. */
  shadow: number;
  bgEnabled: boolean;
  bgColor: string;
  bgOpacity: number;
  highlight: HighlightMode;
  highlightColor: string;
  /** Text color of the active word inside the pill. */
  pillTextColor: string;
  popActive: boolean;
  /** Only show words once they've been spoken. */
  revealWords: boolean;
  wordsPerPage: number;
  animation: CaptionAnim;
};

/** Caption block placement, normalized over the output frame (x/y = center). */
export type CaptionBox = { x: number; y: number; maxWidth: number };

export type CaptionsState = {
  enabled: boolean;
  words: CaptionWord[];
  language: string;
  style: CaptionStyle;
  box: CaptionBox;
};

export type CaptionPreset = { id: string; name: string; style: CaptionStyle };

export const CAPTION_FONTS: { id: string; label: string; css: string }[] = [
  { id: "system", label: "SF Pro", css: 'system-ui, -apple-system, "Helvetica Neue", sans-serif' },
  { id: "helvetica", label: "Helvetica Neue", css: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
  { id: "avenir", label: "Avenir Next", css: '"Avenir Next", Avenir, sans-serif' },
  { id: "futura", label: "Futura", css: "Futura, sans-serif" },
  { id: "gill", label: "Gill Sans", css: '"Gill Sans", sans-serif' },
  { id: "impact", label: "Impact", css: "Impact, sans-serif" },
  { id: "arialblack", label: "Arial Black", css: '"Arial Black", sans-serif' },
  { id: "rounded", label: "Arial Rounded", css: '"Arial Rounded MT Bold", sans-serif' },
  { id: "georgia", label: "Georgia", css: "Georgia, serif" },
  { id: "rockwell", label: "Rockwell", css: "Rockwell, serif" },
  { id: "typewriter", label: "American Typewriter", css: '"American Typewriter", serif' },
  { id: "marker", label: "Marker Felt", css: '"Marker Felt", fantasy' },
  { id: "chalk", label: "Chalkboard", css: '"Chalkboard SE", fantasy' },
  { id: "menlo", label: "Menlo", css: "Menlo, monospace" },
];

const fontCss = (id: string) =>
  (CAPTION_FONTS.find((f) => f.id === id) ?? CAPTION_FONTS[0]).css;

const base: CaptionStyle = {
  font: "system",
  fontWeight: 800,
  fontSize: 5.5,
  uppercase: false,
  textColor: "#ffffff",
  strokeColor: "#000000",
  strokeWidth: 0,
  shadow: 0.6,
  bgEnabled: false,
  bgColor: "#000000",
  bgOpacity: 0.6,
  highlight: "pill",
  highlightColor: "#7c5cff",
  pillTextColor: "#ffffff",
  popActive: false,
  revealWords: false,
  wordsPerPage: 4,
  animation: "pop",
};

export const BUILTIN_PRESETS: CaptionPreset[] = [
  { id: "pill", name: "Pill", style: base },
  {
    id: "bold-pop",
    name: "Bold Pop",
    style: { ...base, font: "impact", fontWeight: 400, fontSize: 7, uppercase: true, strokeWidth: 12, highlight: "color", highlightColor: "#ffe14d", popActive: true, wordsPerPage: 3 },
  },
  {
    id: "karaoke",
    name: "Karaoke",
    style: { ...base, fontWeight: 900, strokeWidth: 10, shadow: 0.3, highlight: "karaoke", highlightColor: "#3ddc97", wordsPerPage: 5, animation: "fade" },
  },
  {
    id: "one-word",
    name: "One Word",
    style: { ...base, font: "arialblack", fontSize: 8, uppercase: true, strokeWidth: 14, highlight: "none", wordsPerPage: 1, animation: "pop" },
  },
  {
    id: "classic",
    name: "Classic",
    style: { ...base, fontWeight: 600, fontSize: 4.5, shadow: 0, bgEnabled: true, highlight: "none", wordsPerPage: 8, animation: "none" },
  },
  {
    id: "typewriter",
    name: "Typewriter",
    style: { ...base, font: "typewriter", fontWeight: 600, fontSize: 5, highlight: "none", revealWords: true, wordsPerPage: 6, animation: "none" },
  },
  {
    id: "neon",
    name: "Neon",
    style: { ...base, font: "futura", fontWeight: 700, uppercase: true, shadow: 1, highlight: "color", highlightColor: "#ff3cac", popActive: true, wordsPerPage: 3, animation: "slide" },
  },
  {
    id: "soft-box",
    name: "Soft Box",
    style: { ...base, font: "rounded", fontWeight: 400, fontSize: 5, shadow: 0, bgEnabled: true, bgColor: "#ffffff", bgOpacity: 0.92, textColor: "#16161a", highlight: "pill", highlightColor: "#ffd23f", pillTextColor: "#16161a", wordsPerPage: 5, animation: "slide" },
  },
];

export const DEFAULT_CAPTION_STYLE = BUILTIN_PRESETS[0].style;
export const DEFAULT_CAPTION_BOX: CaptionBox = { x: 0.5, y: 0.82, maxWidth: 0.8 };

export const defaultCaptionsState = (): CaptionsState => ({
  enabled: true,
  words: [],
  language: "",
  style: DEFAULT_CAPTION_STYLE,
  box: DEFAULT_CAPTION_BOX,
});

// ---- User presets (app-wide, not per project) ------------------------------

const PRESETS_KEY = "oss.captionPresets";

export function loadUserPresets(): CaptionPreset[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PRESETS_KEY) ?? "[]") as CaptionPreset[];
    return raw.map((p) => ({ ...p, style: { ...base, ...p.style } }));
  } catch {
    return [];
  }
}

export function saveUserPresets(presets: CaptionPreset[]) {
  localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
}

// ---- Transcript → words ----------------------------------------------------

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/**
 * whisper-1's word list has no punctuation; the segment text does. Re-attach
 * it by walking both token streams and matching normalized spellings.
 */
export function wordsFromTranscript(t: Transcript): CaptionWord[] {
  const tokens = t.segments.flatMap((s) => s.text.trim().split(/\s+/).filter(Boolean));
  let j = 0;
  return t.words
    .filter((w) => w.text.trim())
    .map((w) => {
      const n = norm(w.text);
      let text = w.text.trim();
      for (let k = j; k < Math.min(tokens.length, j + 4); k++) {
        if (norm(tokens[k]) === n) {
          text = tokens[k];
          j = k + 1;
          break;
        }
      }
      return { text, startMs: w.start * 1000, endMs: Math.max(w.start, w.end) * 1000 };
    });
}

// ---- Pages -------------------------------------------------------------------

export type CaptionPage = {
  /** Word index range [from, to). */
  from: number;
  to: number;
  startMs: number;
  /** Visible until (includes a short hold / bridge to the next page). */
  endMs: number;
};

const GAP_BREAK_MS = 700;
const BRIDGE_MS = 800;
const HOLD_MS = 350;

let pageCache: { words: CaptionWord[]; per: number; pages: CaptionPage[] } | null = null;

export function paginate(words: CaptionWord[], wordsPerPage: number): CaptionPage[] {
  if (pageCache && pageCache.words === words && pageCache.per === wordsPerPage) return pageCache.pages;
  const per = Math.max(1, Math.round(wordsPerPage));
  const pages: CaptionPage[] = [];
  let from = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1];
    const full = i + 1 - from >= per;
    const sentenceEnd = /[.!?…]["')\]]?$/.test(w.text);
    const gap = next ? next.startMs - w.endMs > GAP_BREAK_MS : true;
    if (full || sentenceEnd || gap) {
      pages.push({ from, to: i + 1, startMs: words[from].startMs, endMs: w.endMs });
      from = i + 1;
    }
  }
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const next = pages[i + 1];
    p.endMs = next && next.startMs - p.endMs < BRIDGE_MS ? next.startMs : p.endMs + HOLD_MS;
  }
  pageCache = { words, per: wordsPerPage, pages };
  return pages;
}

export function pageAt(pages: CaptionPage[], tMs: number): CaptionPage | null {
  let lo = 0;
  let hi = pages.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = pages[mid];
    if (tMs < p.startMs) hi = mid - 1;
    else if (tMs >= p.endMs) lo = mid + 1;
    else return p;
  }
  return null;
}

export const pageText = (words: CaptionWord[], p: CaptionPage) =>
  words.slice(p.from, p.to).map((w) => w.text).join(" ");

/**
 * Replace a page's words with edited text. Same word count keeps every word's
 * timing; otherwise the page's time span is shared out by token length.
 */
export function replacePageText(words: CaptionWord[], p: CaptionPage, text: string): CaptionWord[] {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const old = words.slice(p.from, p.to);
  let next: CaptionWord[];
  if (tokens.length === old.length) {
    next = old.map((w, i) => ({ ...w, text: tokens[i] }));
  } else {
    const t0 = old[0].startMs;
    const t1 = old[old.length - 1].endMs;
    const weights = tokens.map((t) => t.length + 1);
    const sum = weights.reduce((a, b) => a + b, 0);
    let acc = t0;
    next = tokens.map((t, i) => {
      const len = ((t1 - t0) * weights[i]) / sum;
      const w = { text: t, startMs: acc, endMs: acc + len };
      acc += len;
      return w;
    });
  }
  return [...words.slice(0, p.from), ...next, ...words.slice(p.to)];
}

// ---- Rendering ---------------------------------------------------------------

export type Rect = { x: number; y: number; w: number; h: number };

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const easeOutBack = (t: number) => {
  const c = 1.70158;
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
};

function withAlpha(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function roundRect(ctx: CanvasRenderingContext2D, r: Rect, rad: number) {
  const k = Math.min(rad, r.w / 2, r.h / 2);
  ctx.beginPath();
  ctx.moveTo(r.x + k, r.y);
  ctx.arcTo(r.x + r.w, r.y, r.x + r.w, r.y + r.h, k);
  ctx.arcTo(r.x + r.w, r.y + r.h, r.x, r.y + r.h, k);
  ctx.arcTo(r.x, r.y + r.h, r.x, r.y, k);
  ctx.arcTo(r.x, r.y, r.x + r.w, r.y, k);
  ctx.closePath();
}

type PlacedWord = { text: string; x: number; y: number; w: number; startMs: number };

function layoutWords(
  ctx: CanvasRenderingContext2D,
  words: CaptionWord[],
  st: CaptionStyle,
  box: CaptionBox,
  outW: number,
  outH: number,
) {
  const fontPx = (st.fontSize / 100) * outH;
  ctx.font = `${st.fontWeight} ${fontPx}px ${fontCss(st.font)}`;
  const space = Math.max(ctx.measureText(" ").width, fontPx * (st.popActive ? 0.34 : 0.26));
  const maxW = Math.max(fontPx * 2, box.maxWidth * outW);
  const lines: { items: { text: string; w: number; startMs: number }[]; w: number }[] = [];
  let cur: (typeof lines)[number] = { items: [], w: 0 };
  for (const wd of words) {
    const text = st.uppercase ? wd.text.toUpperCase() : wd.text;
    const w = ctx.measureText(text).width;
    const add = cur.items.length ? space + w : w;
    if (cur.items.length && cur.w + add > maxW) {
      lines.push(cur);
      cur = { items: [], w: 0 };
    }
    cur.w += cur.items.length ? space + w : w;
    cur.items.push({ text, w, startMs: wd.startMs });
  }
  if (cur.items.length) lines.push(cur);

  const lineH = fontPx * 1.22;
  const blockW = Math.max(0, ...lines.map((l) => l.w));
  const blockH = lines.length * lineH;
  const cx = Math.max(blockW / 2, Math.min(outW - blockW / 2, box.x * outW));
  const top = Math.max(0, Math.min(outH - blockH, box.y * outH - blockH / 2));
  const placed: PlacedWord[] = [];
  lines.forEach((l, li) => {
    let x = cx - l.w / 2;
    const y = top + li * lineH + lineH / 2;
    for (const it of l.items) {
      placed.push({ text: it.text, x, y, w: it.w, startMs: it.startMs });
      x += it.w + space;
    }
  });
  return { placed, fontPx, lineH, space, bbox: { x: cx - blockW / 2, y: top, w: blockW, h: blockH } };
}

export const SAMPLE_WORDS: CaptionWord[] = ["Your", "subtitles", "look", "like", "this"].map(
  (text, i) => ({ text, startMs: i * 400, endMs: i * 400 + 380 }),
);

/**
 * Draw the caption page visible at `tMs` into a transparent canvas of
 * outW×outH. Returns the caption block's bounds (output px), or null.
 * `sampleAtMs` renders SAMPLE_WORDS at that time when nothing is on screen.
 */
export function drawCaptions(
  ctx: CanvasRenderingContext2D,
  o: { outW: number; outH: number; tMs: number; captions: CaptionsState; sampleAtMs?: number },
): Rect | null {
  const { outW, outH, captions } = o;
  const st = captions.style;
  let words = captions.words;
  let tMs = o.tMs;
  let page = captions.enabled ? pageAt(paginate(words, st.wordsPerPage), tMs) : null;
  if (!page && o.sampleAtMs !== undefined) {
    words = SAMPLE_WORDS.slice(0, Math.max(1, Math.min(SAMPLE_WORDS.length, st.wordsPerPage)));
    tMs = o.sampleAtMs;
    page = { from: 0, to: words.length, startMs: -1e9, endMs: 1e9 };
  }
  if (!page) return null;

  const pageWords = words.slice(page.from, page.to);
  const { placed, fontPx, lineH, space, bbox } = layoutWords(ctx, pageWords, st, captions.box, outW, outH);

  const a = clamp01((tMs - page.startMs) / 220);
  let alpha = 1;
  let scale = 1;
  let dy = 0;
  if (st.animation === "fade") alpha = easeOutCubic(a);
  else if (st.animation === "pop") {
    scale = 0.7 + 0.3 * easeOutBack(a);
    alpha = clamp01(a * 3);
  } else if (st.animation === "slide") {
    dy = (1 - easeOutCubic(a)) * fontPx * 0.7;
    alpha = easeOutCubic(a);
  }
  if (alpha <= 0.001) return bbox;

  let active = -1;
  for (let i = 0; i < placed.length; i++) if (placed[i].startMs <= tMs) active = i;

  ctx.save();
  ctx.globalAlpha = alpha;
  const cx = bbox.x + bbox.w / 2;
  const cy = bbox.y + bbox.h / 2;
  ctx.translate(cx, cy + dy);
  ctx.scale(scale, scale);
  ctx.translate(-cx, -cy);

  const padX = fontPx * 0.45;
  const padY = fontPx * 0.2;
  if (st.bgEnabled) {
    ctx.fillStyle = withAlpha(st.bgColor, st.bgOpacity);
    roundRect(ctx, { x: bbox.x - padX, y: bbox.y - padY, w: bbox.w + padX * 2, h: bbox.h + padY * 2 }, fontPx * 0.3);
    ctx.fill();
  }

  const wordRect = (w: PlacedWord): Rect => ({
    x: w.x - fontPx * 0.18,
    y: w.y - lineH / 2 + fontPx * 0.04,
    w: w.w + fontPx * 0.36,
    h: lineH - fontPx * 0.08,
  });
  if (st.highlight === "pill" && active >= 0) {
    const cur = wordRect(placed[active]);
    const p = easeOutCubic(clamp01((tMs - placed[active].startMs) / 140));
    let r = cur;
    if (active > 0) {
      const prev = wordRect(placed[active - 1]);
      r = {
        x: prev.x + (cur.x - prev.x) * p,
        y: prev.y + (cur.y - prev.y) * p,
        w: prev.w + (cur.w - prev.w) * p,
        h: cur.h,
      };
    } else {
      const k = 0.6 + 0.4 * p;
      r = { x: cur.x + (cur.w * (1 - k)) / 2, y: cur.y + (cur.h * (1 - k)) / 2, w: cur.w * k, h: cur.h * k };
    }
    ctx.fillStyle = st.highlightColor;
    roundRect(ctx, r, fontPx * 0.22);
    ctx.fill();
  }

  ctx.font = `${st.fontWeight} ${fontPx}px ${fontCss(st.font)}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.lineJoin = "round";
  const strokePx = (st.strokeWidth / 100) * fontPx * 2;
  placed.forEach((w, i) => {
    if (st.revealWords && w.startMs > tMs) return;
    let color = st.textColor;
    if (st.highlight === "color" && i === active) color = st.highlightColor;
    else if (st.highlight === "karaoke" && i <= active) color = st.highlightColor;
    else if (st.highlight === "pill" && i === active) color = st.pillTextColor;
    ctx.save();
    if (st.popActive && i === active) {
      const p = clamp01((tMs - w.startMs) / 160);
      const s = 1 + Math.min(0.14, (0.8 * space) / Math.max(1, w.w)) * easeOutBack(p);
      ctx.translate(w.x + w.w / 2, w.y);
      ctx.scale(s, s);
      ctx.translate(-(w.x + w.w / 2), -w.y);
    }
    if (st.shadow > 0) {
      ctx.shadowColor = `rgba(0,0,0,${0.75 * st.shadow})`;
      ctx.shadowBlur = fontPx * 0.3 * st.shadow;
      ctx.shadowOffsetY = fontPx * 0.06 * st.shadow;
    }
    if (strokePx > 0) {
      ctx.strokeStyle = st.strokeColor;
      ctx.lineWidth = strokePx;
      ctx.strokeText(w.text, w.x, w.y);
      ctx.shadowColor = "transparent";
    }
    ctx.fillStyle = color;
    ctx.fillText(w.text, w.x, w.y);
    ctx.restore();
  });
  ctx.restore();
  return bbox;
}

export const hasCaptions = (c: CaptionsState | null | undefined) =>
  !!c && c.enabled && c.words.length > 0;
