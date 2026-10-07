import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Ico } from "../icons";
import type { ThemeMode } from "../../hooks/useTheme";
import {
  native,
  cursorSidecarPathFor,
  type CaptureArtifact,
  type CursorSidecar,
  type CursorSidecarShapeName,
  type MacWallpaper,
} from "../../lib/native";
import {
  DEFAULT_AUTO_ZOOM_OPTIONS,
  DEFAULT_SNAP_TO_EDGES,
  deriveAutoZoom,
  type ZoomSegment,
} from "../../lib/autoZoom";
import {
  cameraAt,
  computeFrameLayout,
  computeZoomTransform,
  cursorPosAt,
  cursorShapeAt,
  glyphFor,
  isWallpaperImage,
  makeCursorRenderState,
  postFxCssFilter,
  type CameraKeyframe,
  type RenderFrameOpts,
} from "../../lib/compositor";
import { GLCompositor, rasterizeGlyphsGL } from "../../lib/compositorGL";
import {
  DEFAULT_EFFECT_DURATION_SEC,
  DEFAULT_EFFECT_INTENSITY,
  EFFECT_PLUGINS,
  effectPlugin,
  findEffectSegment,
  newEffectSegment,
  resolveEffectParams,
  type EffectSegment,
} from "../../lib/effects";
import {
  SPEED_MAX,
  SPEED_MIN,
  SPEED_PRESETS,
  MIN_CLIP_SEC,
  clampSpeed,
  mapSegmentPiecePatch,
  clipIndexAtOut,
  duplicateClip,
  fullClip,
  layoutClips,
  moveClip,
  outDuration,
  outToSrc,
  patchClip,
  removeClip,
  splitAt,
  srcRangePieces,
  srcToOut,
  type Clip,
  type PlacedClip,
} from "../../lib/clips";
import { ExportDialog } from "./ExportDialog";

/**
 * Upgrade an asset-protocol URL to a same-origin blob: URL. WKWebView treats
 * the Tauri asset protocol as cross-origin, which blocks uploading the
 * <video> to a WebGL texture (the GPU preview path). While the fetch is in
 * flight — or if it fails / the file is enormous — the original URL is
 * returned and the preview falls back to the DOM compositor.
 */
const BLOB_PREVIEW_MAX_BYTES = 1_500_000_000;
function useSameOriginSrc(url: string | null): string | null {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!url || url.startsWith("blob:")) {
      setBlobUrl(null);
      return;
    }
    let alive = true;
    let created: string | null = null;
    setBlobUrl(null);
    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) return;
        const len = Number(res.headers.get("content-length") || 0);
        if (len > BLOB_PREVIEW_MAX_BYTES) {
          res.body?.cancel();
          return;
        }
        const blob = await res.blob();
        if (!alive) return;
        created = URL.createObjectURL(blob);
        setBlobUrl(created);
      } catch {
        /* keep the asset URL */
      }
    })();
    return () => {
      alive = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [url]);
  return url ? blobUrl ?? url : null;
}

type ZoomSettings = {
  autoOn: boolean;
  defaultLevel: number;
  leadInMs: number;
  holdMs: number;
  releaseMs: number;
  smoothing: number;
};

const DEFAULT_ZOOM_SETTINGS: ZoomSettings = {
  autoOn: true,
  defaultLevel: DEFAULT_AUTO_ZOOM_OPTIONS.defaultLevel,
  leadInMs: DEFAULT_AUTO_ZOOM_OPTIONS.leadInMs,
  holdMs: DEFAULT_AUTO_ZOOM_OPTIONS.holdMs,
  releaseMs: DEFAULT_AUTO_ZOOM_OPTIONS.releaseMs,
  smoothing: 25,
};

/**
 * Performance / preview-quality settings. These only affect the in-editor
 * video preview — exported video always renders at full quality.
 */
type PreviewMode = "quality" | "performance";
type PerformanceSettings = {
  previewMode: PreviewMode;
  powerSaving: boolean;
};

const DEFAULT_PERFORMANCE_SETTINGS: PerformanceSettings = {
  previewMode: "quality",
  powerSaving: false,
};

const PERFORMANCE_SETTINGS_KEY = "oss.performanceSettings";

function loadPerformanceSettings(): PerformanceSettings {
  try {
    const raw = localStorage.getItem(PERFORMANCE_SETTINGS_KEY);
    if (!raw) return DEFAULT_PERFORMANCE_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<PerformanceSettings>;
    return {
      previewMode:
        parsed.previewMode === "performance" ? "performance" : "quality",
      powerSaving: parsed.powerSaving === true,
    };
  } catch {
    return DEFAULT_PERFORMANCE_SETTINGS;
  }
}

/**
 * Target frame rate for the preview render loop. Power saving caps hardest;
 * Performance mode trims the loop to 30fps; Quality runs the display's full
 * refresh rate (0 = uncapped requestAnimationFrame).
 */
function previewFpsFor(s: PerformanceSettings): number {
  if (s.powerSaving) return 20;
  if (s.previewMode === "performance") return 30;
  return 0;
}

const SAMPLE_VIDEO = "/sample.mp4";

const ASPECTS = {
  "16:9": { w: 16, h: 9, label: "Wide", short: "16:9" },
  "1:1": { w: 1, h: 1, label: "Square", short: "1:1" },
  "9:16": { w: 9, h: 16, label: "Vertical", short: "9:16" },
  system: { w: 16, h: 9, label: "System", short: "Auto" },
} as const;

type AspectKey = keyof typeof ASPECTS;

// Raycast-style gradient presets, kept as CSS classes (see globals.css).
const GRADIENTS = [
  "wp-1", "wp-2", "wp-3", "wp-4", "wp-5", "wp-6", "wp-7",
  "wp-8", "wp-9", "wp-10", "wp-11", "wp-12", "wp-13", "wp-14",
  "wp-15", "wp-16", "wp-17",
];

/** Crop region, normalized 0..1 over the recorded video frame. */
type CropRect = { x: number; y: number; w: number; h: number };

/**
 * One editable sidecar audio track (system audio / microphone). Trims are in
 * seconds on the shared timeline: `trimStart` silences the head of the track,
 * `trimEnd` silences from the end — the same convention as the clip trim.
 */
type AudioTrackState = {
  muted: boolean;
  gain: number; // 0..1
  trimStart: number;
  trimEnd: number;
  /** Studio-sound style auto leveling (peak-normalized at decode time). */
  normalize: boolean;
};

type AudioTrackKey = "system" | "mic";

const defaultAudioTrack = (): AudioTrackState => ({
  muted: false,
  gain: 1,
  trimStart: 0,
  trimEnd: 0,
  normalize: false,
});

const defaultAudioTracks = () => ({
  system: defaultAudioTrack(),
  mic: defaultAudioTrack(),
});

/**
 * Camera bubble settings. `pos` is the bubble center normalized 0..1 over
 * the output frame; `size` is the bubble edge as a fraction of frame width.
 * Frame space, not video space — the bubble ignores auto-zoom.
 *
 * With `keyframes` set, position/size animate between them over the timeline
 * (see `cameraAt` in lib/compositor); `pos`/`size` then only serve as the
 * fallback once keyframes are cleared.
 */
type CameraState = {
  enabled: boolean;
  pos: { x: number; y: number };
  size: number;
  shape: "circle" | "rounded";
  mirrored: boolean;
  keyframes: CameraKeyframe[];
};

const defaultCameraState = (): CameraState => ({
  enabled: true,
  pos: { x: 0.86, y: 0.82 },
  size: 0.2,
  shape: "rounded", // squircle bottom-right by default
  mirrored: false,
  keyframes: [],
});

type EditorState = {
  aspect: AspectKey;
  bgTab: string;
  wallpaper: string;
  blur: number;
  padding: number;
  cropRect: CropRect | null;
  zoom: number;
  /** Edited sequence in output order; empty = the whole recording, untouched. */
  clips: Clip[];
  audioTracks: Record<AudioTrackKey, AudioTrackState>;
  camera: CameraState;
};

const ASPECT_ORDER: AspectKey[] = ["16:9", "1:1", "9:16", "system"];

type StatePatch = Partial<EditorState>;

const PROJECT_VERSION = 4;

/** Pre-v4 projects stored a single head/tail trim instead of clips. */
type LegacyTrim = { trimStart?: number; trimEnd?: number; splits?: number[] };

/** On-disk shape of a `.openscreen` project file. */
type ProjectFile = {
  version: number;
  app: "OpenScreen Studio";
  artifact: CaptureArtifact;
  editorState: EditorState & LegacyTrim;
  zoomSettings: ZoomSettings;
  zoomSegments: ZoomSegment[];
  /** v3+ — plugin-based timeline video effects; absent in older saves. */
  effectSegments?: EffectSegment[];
};

/** Load the cursor sidecar that sits next to a recording, if present. */
async function fetchSidecar(
  a: CaptureArtifact,
): Promise<CursorSidecar | null> {
  try {
    const r = await fetch(convertFileSrc(cursorSidecarPathFor(a)));
    if (!r.ok) return null;
    return (await r.json()) as CursorSidecar;
  } catch {
    return null;
  }
}

const baseName = (p: string) => p.split(/[\\/]/).pop() || p;

// One shared AudioContext: decodes the sidecar WAVs for waveforms AND plays
// them during preview. Sidecar audio plays through Web Audio (not <audio>
// elements) — buffer playback is format-agnostic once decodeAudioData
// succeeds, where the media-element pipeline can refuse float32 WAVs.
let sharedAudioCtx: AudioContext | null = null;
function getAudioCtx(): AudioContext {
  if (!sharedAudioCtx) {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    sharedAudioCtx = new Ctx();
  }
  return sharedAudioCtx;
}

/** Decode an audio resource (mp4 soundtrack or sidecar WAV). */
async function decodeAudioFromUrl(url: string): Promise<AudioBuffer | null> {
  try {
    const buf = await fetch(url).then((r) => r.arrayBuffer());
    return await new Promise((resolve, reject) =>
      getAudioCtx().decodeAudioData(buf, resolve, reject),
    );
  } catch {
    return null;
  }
}

/**
 * Reduce a decoded buffer to `n` normalized peak samples for waveform
 * rendering. Returns null when the audio is effectively silent.
 */
function peaksFromBuffer(audio: AudioBuffer, n = 260): number[] | null {
  const ch0 = audio.getChannelData(0);
  const ch1 = audio.numberOfChannels > 1 ? audio.getChannelData(1) : null;
  const block = Math.max(1, Math.floor(ch0.length / n));
  const out: number[] = new Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const start = i * block;
    const end = Math.min(start + block, ch0.length);
    let m = 0;
    for (let j = start; j < end; j++) {
      const a = Math.abs(ch0[j]);
      if (a > m) m = a;
      if (ch1) {
        const b = Math.abs(ch1[j]);
        if (b > m) m = b;
      }
    }
    out[i] = m;
    if (m > peak) peak = m;
  }
  return peak > 0.001 ? out.map((v) => v / peak) : null;
}

/**
 * Auto level ("Studio sound"): multiplier that lifts a track's loudest peak
 * toward ~95% full scale, cutting hot tracks down as well. The boost is
 * capped so quiet-room noise floors don't get amplified with the voice.
 */
const AUTO_LEVEL_TARGET = 0.95;
const AUTO_LEVEL_MAX_BOOST = 6;

function autoLevelGain(audio: AudioBuffer): number {
  let peak = 0;
  for (let ch = 0; ch < audio.numberOfChannels; ch++) {
    const data = audio.getChannelData(ch);
    // Stride-sample ~200k points max per channel — plenty for a peak estimate.
    const stride = Math.max(1, Math.floor(data.length / 200_000));
    for (let i = 0; i < data.length; i += stride) {
      const a = Math.abs(data[i]!);
      if (a > peak) peak = a;
    }
  }
  if (!isFinite(peak) || peak <= 0.01) return 1; // effectively silent: leave it
  return Math.min(AUTO_LEVEL_MAX_BOOST, AUTO_LEVEL_TARGET / peak);
}

/** User gain scaled by the auto-level multiplier (bounded for ffmpeg). */
function exportTrackGain(t: AudioTrackState, boost: number): number {
  const g = t.gain * (t.normalize ? boost : 1);
  return Math.max(0, Math.min(AUTO_LEVEL_MAX_BOOST, g));
}

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

function PerformancePopover({
  settings,
  onChange,
  onClose,
  themeMode,
  setThemeMode,
}: {
  settings: PerformanceSettings;
  onChange: (next: PerformanceSettings) => void;
  onClose: () => void;
  themeMode: ThemeMode;
  setThemeMode: (next: ThemeMode) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const isQuality = settings.previewMode === "quality";

  return (
    <>
      <div className="perf-pop-backdrop" onMouseDown={onClose} />
      <div
        className="perf-pop"
        role="dialog"
        aria-label="Performance settings"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="perf-pop-section">
          <div className="perf-pop-title">Appearance</div>
          <div className="seg perf-seg">
            {THEME_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                className={themeMode === opt.value ? "on" : ""}
                onClick={() => setThemeMode(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <p className="perf-pop-desc">
            Choose Light or Dark, or follow the macOS system appearance.
          </p>
        </div>

        <div className="perf-pop-section">
          <div className="perf-pop-title">Preview mode</div>
          <div className="seg perf-seg">
            <button
              className={isQuality ? "on" : ""}
              onClick={() => onChange({ ...settings, previewMode: "quality" })}
            >
              Quality
            </button>
            <button
              className={!isQuality ? "on" : ""}
              onClick={() =>
                onChange({ ...settings, previewMode: "performance" })
              }
            >
              Performance
            </button>
          </div>
          <p className="perf-pop-desc">
            {isQuality
              ? "Preview video looks exactly the same as exported video. All features, such as motion blur are enabled in preview."
              : "Preview is rendered at a lower frame rate to keep the editor responsive. Some effects are simplified."}
          </p>
        </div>

        <div className="perf-pop-section">
          <div className="row-toggle">
            <div className="col">
              <div className="label">Power saving mode</div>
              <div className="desc">
                Turning on will result in lower CPU/GPU and power usage.
                Enabling might decrease frame rate of the preview video.
              </div>
            </div>
            <button
              className={`switch ${settings.powerSaving ? "on" : ""}`}
              role="switch"
              aria-checked={settings.powerSaving}
              aria-label="Power saving mode"
              onClick={() =>
                onChange({ ...settings, powerSaving: !settings.powerSaving })
              }
            />
          </div>
        </div>

        <div className="perf-pop-foot">
          Changing those settings only affects video preview. Exported video
          will always have the best quality.
        </div>
      </div>
    </>
  );
}

function TitleBar({
  onDiscard,
  projectName,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  perfSettings,
  setPerfSettings,
  perfOpen,
  setPerfOpen,
  previewFocus,
  setPreviewFocus,
  themeMode,
  setThemeMode,
  onExport,
  exportDisabled,
}: {
  onDiscard: () => void;
  projectName: string;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  perfSettings: PerformanceSettings;
  setPerfSettings: (next: PerformanceSettings) => void;
  perfOpen: boolean;
  setPerfOpen: (open: boolean) => void;
  previewFocus: boolean;
  setPreviewFocus: (on: boolean) => void;
  themeMode: ThemeMode;
  setThemeMode: (next: ThemeMode) => void;
  onExport: () => void;
  exportDisabled: boolean;
}) {
  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="tb-left">
        <button className="tb-icon-btn" title="Open project">
          <Ico.folder size={16} />
        </button>
        <button className="tb-icon-btn" title="Discard" onClick={onDiscard}>
          <Ico.trash size={16} />
        </button>
      </div>
      <div className="tb-title" title={projectName}>{projectName}</div>
      <div className="tb-right">
        <button
          className={`tb-icon-btn ${canUndo ? "" : "disabled"}`}
          title="Undo (⌘Z)"
          onClick={onUndo}
          disabled={!canUndo}
        >
          <Ico.undo size={16} />
        </button>
        <button
          className={`tb-icon-btn ${canRedo ? "" : "disabled"}`}
          title="Redo (⇧⌘Z)"
          onClick={onRedo}
          disabled={!canRedo}
        >
          <Ico.redo size={16} />
        </button>
        <button
          className="tb-presets disabled"
          aria-disabled
          data-tip="Coming soon"
        >
          <span className="glyph">
            <Ico.sparkles size={14} />
          </span>
          <span>Presets</span>
          <Ico.chevDown size={11} style={{ opacity: 0.6 }} />
        </button>
        <button
          className={`tb-icon-btn ${previewFocus ? "active" : ""}`}
          title={previewFocus ? "Exit preview" : "Preview"}
          aria-pressed={previewFocus}
          onClick={() => setPreviewFocus(!previewFocus)}
        >
          {previewFocus ? <Ico.eyeOff size={16} /> : <Ico.eye size={16} />}
        </button>
        <div className="tb-perf-wrap">
          <button
            className={`tb-icon-btn ${perfOpen ? "active" : ""}`}
            title="Performance"
            aria-haspopup="dialog"
            aria-expanded={perfOpen}
            onClick={() => setPerfOpen(!perfOpen)}
          >
            <Ico.gauge size={16} />
          </button>
          {perfOpen && (
            <PerformancePopover
              settings={perfSettings}
              onChange={setPerfSettings}
              onClose={() => setPerfOpen(false)}
              themeMode={themeMode}
              setThemeMode={setThemeMode}
            />
          )}
        </div>
        <button
          className={`export-btn ${exportDisabled ? "disabled" : ""}`}
          aria-disabled={exportDisabled || undefined}
          data-tip={exportDisabled ? "Record something first" : undefined}
          onClick={() => !exportDisabled && onExport()}
        >
          <Ico.upload size={13} /> Export
        </button>
      </div>
    </div>
  );
}

function Slider({
  value,
  onChange,
  min = 0,
  max = 100,
  onReset,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  onReset?: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);

  const setFromEvent = (e: MouseEvent | React.MouseEvent) => {
    if (!ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const clientX = "clientX" in e ? e.clientX : 0;
    const x = clientX - r.left;
    const pct = Math.max(0, Math.min(1, x / r.width));
    onChange(Math.round(min + pct * (max - min)));
  };

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (dragging.current) setFromEvent(e);
    };
    const up = () => {
      dragging.current = false;
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, []);

  const pct = ((value - min) / (max - min)) * 100;
  const step = Math.max(1, Math.round((max - min) / 100));

  const onKeyDown = (e: React.KeyboardEvent) => {
    let next: number | null = null;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = value - step;
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") next = value + step;
    else if (e.key === "Home") next = min;
    else if (e.key === "End") next = max;
    if (next === null) return;
    e.preventDefault();
    onChange(Math.max(min, Math.min(max, next)));
  };

  return (
    <div className="slider-row">
      <div className="slider">
        <div
          className="track"
          ref={ref}
          role="slider"
          tabIndex={0}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value}
          onKeyDown={onKeyDown}
          onMouseDown={(e) => {
            dragging.current = true;
            setFromEvent(e);
          }}
        >
          <div className="fill" style={{ width: `${pct}%` }} />
          <div className="knob" style={{ left: `${pct}%` }} />
        </div>
      </div>
      {onReset && (
        <button className="reset" onClick={onReset}>
          Reset
        </button>
      )}
    </div>
  );
}

function BackgroundPanel({ state, set }: { state: EditorState; set: (p: StatePatch) => void }) {
  const [wallpapers, setWallpapers] = useState<MacWallpaper[]>([]);
  useEffect(() => {
    native.listMacWallpapers().then(setWallpapers).catch(() => setWallpapers([]));
  }, []);
  return (
    <div className="section">
      <h3 className="section-title">
        <Ico.image size={15} /> Background
      </h3>
      <div className="seg">
        {["Wallpaper", "Gradient", "Color", "Image"].map((t) => {
          const disabled = t === "Color" || t === "Image";
          return (
            <button
              key={t}
              className={`${state.bgTab === t ? "on" : ""} ${
                disabled ? "disabled" : ""
              }`}
              onClick={() => !disabled && set({ bgTab: t })}
              aria-disabled={disabled || undefined}
              data-tip={disabled ? "Coming soon" : undefined}
            >
              {t}
            </button>
          );
        })}
      </div>

      {state.bgTab === "Gradient" ? (
        <>
          <div className="label-row label-strong">
            <Ico.image size={13} /> Gradient
          </div>
          <div className="wp-grid">
            {GRADIENTS.map((g) => (
              <button
                key={g}
                type="button"
                aria-label={`Gradient ${g.replace("wp-", "")}`}
                aria-pressed={state.wallpaper === g}
                className={`wp-swatch ${g} ${state.wallpaper === g ? "on" : ""}`}
                onClick={() => set({ wallpaper: g })}
              />
            ))}
          </div>
          <div className="helper-text">
            Background gradients were created by <a href="#">raycast.com</a>
          </div>
        </>
      ) : (
        <>
          <div className="label-row label-strong">
            <Ico.image size={13} /> Wallpaper
          </div>
          <div className="wp-grid">
            {wallpapers.map((wp) => (
              <button
                key={wp.thumb}
                type="button"
                title={wp.name}
                aria-label={wp.name}
                aria-pressed={state.wallpaper === wp.full}
                className={`wp-swatch ${state.wallpaper === wp.full ? "on" : ""}`}
                style={{ backgroundImage: `url("${convertFileSrc(wp.thumb)}")` }}
                onClick={() => set({ wallpaper: wp.full })}
              />
            ))}
          </div>
          <div className="helper-text">
            {wallpapers.length
              ? "Built-in macOS desktop wallpapers"
              : "Loading macOS wallpapers…"}
          </div>
        </>
      )}

      <div className="label-row label-strong" style={{ marginTop: 22 }}>
        <Ico.image size={13} /> Background blur
      </div>
      <Slider value={state.blur} onChange={(v) => set({ blur: v })} min={0} max={100} />

      <div className="label-row label-strong" style={{ marginTop: 22 }}>
        Shape
      </div>
      <div className="label-row" style={{ marginTop: 4 }}>
        <Ico.rect size={13} /> Padding
      </div>
      <Slider
        value={state.padding}
        onChange={(v) => set({ padding: v })}
        min={0}
        max={120}
        onReset={() => set({ padding: 56 })}
      />
    </div>
  );
}

function CursorZoomPanel({
  cursorSidecar,
  zoomSettings,
  setZoomSettings,
  zoomSegments,
  setZoomSegments,
}: {
  cursorSidecar: CursorSidecar | null;
  zoomSettings: ZoomSettings;
  setZoomSettings: (patch: Partial<ZoomSettings>) => void;
  zoomSegments: ZoomSegment[];
  setZoomSegments: (next: ZoomSegment[]) => void;
}) {
  const fmt = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
  return (
    <div className="section">
      <h3 className="section-title">
        <Ico.cursor size={15} /> Cursor & Zoom
      </h3>

      <div className="label-row label-strong">Auto-zoom on clicks</div>
      <div className="seg">
        <button className={zoomSettings.autoOn ? "on" : ""} onClick={() => setZoomSettings({ autoOn: true })}>On</button>
        <button className={!zoomSettings.autoOn ? "on" : ""} onClick={() => setZoomSettings({ autoOn: false })}>Off</button>
      </div>

      <div className="label-row label-strong" style={{ marginTop: 22 }}>
        Default zoom · {(zoomSettings.defaultLevel).toFixed(1)}×
      </div>
      <Slider
        value={Math.round(zoomSettings.defaultLevel * 10)}
        onChange={(v) => setZoomSettings({ defaultLevel: v / 10 })}
        min={10}
        max={30}
        onReset={() => setZoomSettings({ defaultLevel: DEFAULT_AUTO_ZOOM_OPTIONS.defaultLevel })}
      />

      <div className="label-row label-strong" style={{ marginTop: 18 }}>
        Lead-in · {zoomSettings.leadInMs}ms
      </div>
      <Slider
        value={zoomSettings.leadInMs}
        onChange={(v) => setZoomSettings({ leadInMs: v })}
        min={0}
        max={800}
      />

      <div className="label-row label-strong" style={{ marginTop: 18 }}>
        Hold · {zoomSettings.holdMs}ms
      </div>
      <Slider
        value={zoomSettings.holdMs}
        onChange={(v) => setZoomSettings({ holdMs: v })}
        min={200}
        max={3000}
      />

      <div className="label-row label-strong" style={{ marginTop: 18 }}>
        Cursor smoothing · {zoomSettings.smoothing}%
      </div>
      <Slider
        value={zoomSettings.smoothing}
        onChange={(v) => setZoomSettings({ smoothing: v })}
        min={0}
        max={100}
      />

      <div style={{ marginTop: 18 }}>
        <button
          className="reset"
          onClick={() => {
            if (!cursorSidecar) return;
            if (
              zoomSegments.some((s) => s.source === "manual") &&
              !confirm("Regenerate will discard manual edits. Continue?")
            ) {
              return;
            }
            setZoomSegments(
              deriveAutoZoom(cursorSidecar, {
                defaultLevel: zoomSettings.defaultLevel,
                leadInMs: zoomSettings.leadInMs,
                holdMs: zoomSettings.holdMs,
                releaseMs: zoomSettings.releaseMs,
                mergeGapMs: DEFAULT_AUTO_ZOOM_OPTIONS.mergeGapMs,
              }),
            );
          }}
        >
          Regenerate from clicks
        </button>
      </div>

      <div className="label-row label-strong" style={{ marginTop: 22 }}>
        Segments · {zoomSegments.length}
      </div>
      {!cursorSidecar && (
        <div className="helper-text">Record clicks to enable auto-zoom.</div>
      )}
      {cursorSidecar && cursorSidecar.clicks.length === 0 && (
        <div className="helper-text" style={{ color: "#e0a050" }}>
          No clicks were captured in this recording, so auto-zoom has nothing
          to zoom to. Click tracking needs macOS Accessibility permission:
          System Settings → Privacy &amp; Security → Accessibility → enable
          OpenScreen Studio, then record again.
        </div>
      )}
      {cursorSidecar && cursorSidecar.clicks.length > 0 && zoomSegments.length === 0 && (
        <div className="helper-text">No segments yet. Click "Regenerate from clicks" or scrub the timeline.</div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
        {zoomSegments.map((seg) => (
          <div
            key={seg.id}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              fontSize: 11,
              color: "var(--text-2)",
              padding: "4px 6px",
              borderRadius: 4,
              background: "var(--surface-2, rgba(255,255,255,0.04))",
            }}
          >
            <span>
              {fmt(seg.startMs)} → {fmt(seg.endMs)} · {seg.targetLevel.toFixed(1)}×
            </span>
            <button
              className="reset"
              onClick={() => setZoomSegments(zoomSegments.filter((s) => s.id !== seg.id))}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ZoomFocalPicker({
  seg,
  videoSrc,
  cursorSidecar,
  onChange,
}: {
  seg: ZoomSegment;
  videoSrc: string;
  cursorSidecar: CursorSidecar | null;
  onChange: (focal: { x: number; y: number }) => void;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const dragging = useRef(false);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);

  // Seek to the segment midpoint so the user sees what the zoom is focused on.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const mid = (seg.startMs + seg.endMs) / 2000;
    const set = () => {
      try {
        v.currentTime = Math.max(0, mid);
      } catch {
        /* ignore */
      }
      v.pause();
    };
    if (v.readyState >= 1) set();
    else v.addEventListener("loadedmetadata", set, { once: true });
    return () => v.removeEventListener("loadedmetadata", set);
  }, [seg.startMs, seg.endMs, videoSrc]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onMeta = () => {
      if (v.videoWidth && v.videoHeight) {
        setNatural({ w: v.videoWidth, h: v.videoHeight });
      }
    };
    if (v.videoWidth && v.videoHeight) onMeta();
    else v.addEventListener("loadedmetadata", onMeta, { once: true });
    return () => v.removeEventListener("loadedmetadata", onMeta);
  }, [videoSrc]);

  // Reference frame the seg.focal lives in. Matches the math in Canvas.apply.
  const crop = cursorSidecar?.crop ?? null;
  const refW = crop ? crop.width : cursorSidecar?.display.width ?? natural?.w ?? 0;
  const refH = crop ? crop.height : cursorSidecar?.display.height ?? natural?.h ?? 0;

  // Map ref-space focal → preview-space pixels (object-fit: contain).
  const computePinPx = () => {
    const wrap = wrapRef.current;
    if (!wrap || refW <= 0 || refH <= 0 || !natural) return null;
    const wrapW = wrap.offsetWidth;
    const wrapH = wrap.offsetHeight;
    const fit = Math.min(wrapW / natural.w, wrapH / natural.h);
    const dispW = natural.w * fit;
    const dispH = natural.h * fit;
    const offX = (wrapW - dispW) / 2;
    const offY = (wrapH - dispH) / 2;
    const px = offX + (seg.focal.x / refW) * dispW;
    const py = offY + (seg.focal.y / refH) * dispH;
    return { px, py };
  };

  // Inverse: preview-space pixel → ref-space focal point.
  const focalFromClient = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const wrap = wrapRef.current;
    if (!wrap || refW <= 0 || refH <= 0 || !natural) return null;
    const r = wrap.getBoundingClientRect();
    const wrapW = wrap.offsetWidth;
    const wrapH = wrap.offsetHeight;
    const fit = Math.min(wrapW / natural.w, wrapH / natural.h);
    const dispW = natural.w * fit;
    const dispH = natural.h * fit;
    const offX = (wrapW - dispW) / 2;
    const offY = (wrapH - dispH) / 2;
    const px = clientX - r.left;
    const py = clientY - r.top;
    const x = ((px - offX) / Math.max(1, dispW)) * refW;
    const y = ((py - offY) / Math.max(1, dispH)) * refH;
    return {
      x: Math.max(0, Math.min(refW, x)),
      y: Math.max(0, Math.min(refH, y)),
    };
  };

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragging.current) return;
      const f = focalFromClient(e.clientX, e.clientY);
      if (f) onChange(f);
    };
    const up = () => {
      dragging.current = false;
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [onChange, refW, refH, natural?.w, natural?.h]);

  const pin = computePinPx();

  return (
    <div
      className="zoom-focal-pick"
      ref={wrapRef}
      onMouseDown={(e) => {
        e.preventDefault();
        dragging.current = true;
        const f = focalFromClient(e.clientX, e.clientY);
        if (f) onChange(f);
      }}
    >
      <video ref={videoRef} src={videoSrc} muted playsInline preload="metadata" />
      {pin && (
        <span
          className="pin"
          style={{ left: pin.px, top: pin.py }}
          onMouseDown={(e) => {
            e.stopPropagation();
            e.preventDefault();
            dragging.current = true;
          }}
        />
      )}
    </div>
  );
}

function ZoomSegmentPanel({
  seg,
  setSegments,
  segments,
  defaultLevel,
  videoSrc,
  cursorSidecar,
}: {
  seg: ZoomSegment;
  setSegments: (next: ZoomSegment[]) => void;
  segments: ZoomSegment[];
  defaultLevel: number;
  videoSrc: string;
  cursorSidecar: CursorSidecar | null;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const patch = (p: Partial<ZoomSegment>) =>
    setSegments(segments.map((s) => (s.id === seg.id ? { ...s, ...p } : s)));

  const applyToAll = () => {
    setSegments(
      segments.map((s) =>
        s.id === seg.id
          ? s
          : {
              ...s,
              targetLevel: seg.targetLevel,
              mode: seg.mode,
              instant: seg.instant,
              disabled: seg.disabled,
              snapToEdges: seg.snapToEdges,
            },
      ),
    );
  };

  return (
    <div className="section">
      <h3 className="section-title">
        <Ico.zoomIn size={15} /> Zoom level
      </h3>
      <div className="helper-text" style={{ marginTop: -6, marginBottom: 8 }}>
        How close to zoom on the cursor during this zoom phase
      </div>
      <Slider
        value={Math.round(seg.targetLevel * 10)}
        onChange={(v) => patch({ targetLevel: v / 10 })}
        min={10}
        max={30}
        onReset={() => patch({ targetLevel: defaultLevel })}
      />

      <button className="btn-wide" style={{ marginTop: 12 }} onClick={applyToAll}>
        <Ico.plus size={13} /> Apply zoom level to all other zooms
      </button>

      <div className="label-row label-strong" style={{ marginTop: 22 }}>
        Zoom mode
      </div>
      <div className="seg">
        <button
          className={seg.mode === "auto" ? "on" : ""}
          onClick={() => patch({ mode: "auto" })}
        >
          <Ico.sparkles size={12} style={{ marginRight: 4, verticalAlign: -2 }} /> Auto
        </button>
        <button
          className={seg.mode === "manual" ? "on" : ""}
          onClick={() => patch({ mode: "manual" })}
        >
          <Ico.target size={12} style={{ marginRight: 4, verticalAlign: -2 }} /> Manual
        </button>
      </div>
      {seg.mode === "auto" ? (
        <div className="helper-text">
          Zoomed camera will automatically try to keep the mouse cursor visible.
        </div>
      ) : (
        <>
          <div className="helper-text">
            You can manually pick part of the video that will be zoomed in
          </div>
          <ZoomFocalPicker
            seg={seg}
            videoSrc={videoSrc}
            cursorSidecar={cursorSidecar}
            onChange={(focal) => patch({ focal })}
          />
        </>
      )}

      <div className="row-toggle">
        <div className="col">
          <div className="label">Instant animation</div>
          <div className="desc">
            If enabled, the zoom will be applied instantly without any animation.
          </div>
        </div>
        <button
          className={`switch ${seg.instant ? "on" : ""}`}
          onClick={() => patch({ instant: !seg.instant })}
          role="switch"
          aria-checked={seg.instant}
          aria-label="Instant animation"
        />
      </div>

      <div className="row-toggle">
        <div className="col">
          <div className="label">Disable zoom</div>
        </div>
        <button
          className={`switch ${seg.disabled ? "on" : ""}`}
          onClick={() => patch({ disabled: !seg.disabled })}
          role="switch"
          aria-checked={seg.disabled}
          aria-label="Disable zoom"
        />
      </div>

      <button
        className="adv-toggle"
        onClick={() => setAdvancedOpen((v) => !v)}
        aria-expanded={advancedOpen}
      >
        <span>Advanced</span>
        <span className="chev">
          {advancedOpen ? <Ico.chevUp size={13} /> : <Ico.chevDown size={13} />}
        </span>
      </button>
      {advancedOpen && (
        <>
          <div className="label-row label-strong" style={{ marginTop: 6 }}>
            Snap to edges
          </div>
          <div className="helper-text" style={{ marginTop: -2, marginBottom: 8 }}>
            If zoom center is close to edge of recording - it will snap to it, showing a bit of
            background on the side
          </div>
          <Slider
            value={seg.snapToEdges}
            onChange={(v) => patch({ snapToEdges: v })}
            min={0}
            max={100}
            onReset={() => patch({ snapToEdges: DEFAULT_SNAP_TO_EDGES })}
          />
        </>
      )}
    </div>
  );
}

/**
 * Browse the effect plugin registry and manage the Effects track's segments.
 * Shown when the "effects" rail tab is active and no segment is selected;
 * clicking a plugin card inserts a new segment at the playhead.
 */
function EffectsLibraryPanel({
  effectSegments,
  setEffectSegments,
  currentTime,
  duration,
  onSelect,
}: {
  effectSegments: EffectSegment[];
  setEffectSegments: (next: EffectSegment[]) => void;
  currentTime: number;
  duration: number;
  onSelect: (id: string) => void;
}) {
  const fmt = (s: number) => `${s.toFixed(1)}s`;

  const addAt = (pluginId: string) => {
    const startMs = currentTime * 1000;
    const endMs = Math.min(duration, currentTime + DEFAULT_EFFECT_DURATION_SEC) * 1000;
    if (endMs - startMs < 1) return;
    const seg = newEffectSegment(startMs, endMs, pluginId);
    setEffectSegments(
      [...effectSegments, seg].sort((a, b) => a.startMs - b.startMs),
    );
    onSelect(seg.id);
  };

  return (
    <div className="section">
      <h3 className="section-title">
        <Ico.sparkles size={15} /> Effects
      </h3>
      <div className="helper-text" style={{ marginTop: -6, marginBottom: 8 }}>
        Click a look to add it to the timeline at the playhead.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {EFFECT_PLUGINS.map((p) => (
          <button
            key={p.id}
            className="btn-wide"
            style={{ justifyContent: "flex-start", textAlign: "left", flexDirection: "column", alignItems: "flex-start", gap: 2 }}
            onClick={() => addAt(p.id)}
            title={`Add "${p.name}" at ${fmt(currentTime)}`}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600 }}>
              <Ico.sparkles size={12} /> {p.name}
            </span>
            <span style={{ fontSize: 11, fontWeight: 400, opacity: 0.75 }}>
              {p.description}
            </span>
          </button>
        ))}
      </div>

      <div className="label-row label-strong" style={{ marginTop: 22 }}>
        Segments · {effectSegments.length}
      </div>
      {effectSegments.length === 0 && (
        <div className="helper-text">No effects yet. Add one above.</div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
        {effectSegments.map((seg) => (
          <div
            key={seg.id}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              fontSize: 11,
              color: "var(--text-2)",
              padding: "4px 6px",
              borderRadius: 4,
              background: "var(--surface-2, rgba(255,255,255,0.04))",
              cursor: "pointer",
            }}
            onClick={() => onSelect(seg.id)}
          >
            <span>
              {fmt(seg.startMs / 1000)} → {fmt(seg.endMs / 1000)} ·{" "}
              {effectPlugin(seg.pluginId).name}
            </span>
            <button
              className="reset"
              onClick={(e) => {
                e.stopPropagation();
                setEffectSegments(effectSegments.filter((s) => s.id !== seg.id));
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Edit the selected Effects-track segment: plugin choice + intensity. */
function EffectSegmentPanel({
  seg,
  segments,
  setSegments,
}: {
  seg: EffectSegment;
  segments: EffectSegment[];
  setSegments: (next: EffectSegment[]) => void;
}) {
  const patch = (p: Partial<EffectSegment>) =>
    setSegments(segments.map((s) => (s.id === seg.id ? { ...s, ...p } : s)));
  const plugin = effectPlugin(seg.pluginId);

  return (
    <div className="section">
      <h3 className="section-title">
        <Ico.sparkles size={15} /> {plugin.name}
      </h3>
      <div className="helper-text" style={{ marginTop: -6, marginBottom: 8 }}>
        {plugin.description}
      </div>

      <div className="label-row label-strong">Look</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {EFFECT_PLUGINS.map((p) => {
          const active = p.id === seg.pluginId;
          return (
            <button
              key={p.id}
              className="btn-wide"
              style={{
                justifyContent: "flex-start",
                background: active ? "var(--accent, #4f8cff)" : undefined,
                color: active ? "#fff" : undefined,
              }}
              onClick={() => patch({ pluginId: p.id })}
            >
              {active ? <Ico.target size={12} /> : <Ico.sparkles size={12} />} {p.name}
            </button>
          );
        })}
      </div>

      <div className="label-row label-strong" style={{ marginTop: 22 }}>
        Intensity · {Math.round(seg.intensity * 100)}%
      </div>
      <Slider
        value={Math.round(seg.intensity * 100)}
        onChange={(v) => patch({ intensity: v / 100 })}
        min={0}
        max={100}
        onReset={() => patch({ intensity: DEFAULT_EFFECT_INTENSITY })}
      />

      <div className="row-toggle" style={{ marginTop: 18 }}>
        <div className="col">
          <div className="label">Disable effect</div>
          <div className="desc">
            Turns this segment off without removing it from the timeline.
          </div>
        </div>
        <button
          className={`switch ${seg.disabled ? "on" : ""}`}
          onClick={() => patch({ disabled: !seg.disabled })}
          role="switch"
          aria-checked={seg.disabled}
          aria-label="Disable effect"
        />
      </div>
    </div>
  );
}

type ClipPanelProps = {
  clip: PlacedClip;
  index: number;
  count: number;
  onPatch: (patch: Partial<Clip>) => void;
  onSplit: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onMove: (dir: -1 | 1) => void;
};

const fmtClock = (s: number) => {
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
};
const fmtSpeed = (x: number) => `${Number(x.toFixed(2))}×`;

function ClipPanel({ clip, index, count, onPatch, onSplit, onDelete, onDuplicate, onMove }: ClipPanelProps) {
  const [speedText, setSpeedText] = useState(String(clip.speed));
  useEffect(() => setSpeedText(String(Number(clip.speed.toFixed(2)))), [clip.speed]);
  const commitSpeed = () => {
    const v = parseFloat(speedText.replace(",", "."));
    if (Number.isFinite(v)) onPatch({ speed: clampSpeed(v) });
    else setSpeedText(String(clip.speed));
  };

  return (
    <div className="section clip-panel">
      <h3 className="section-title">
        <Ico.film size={15} /> Clip {index + 1} <span className="clip-panel-of">of {count}</span>
      </h3>
      <div className="clip-panel-facts">
        <div>
          <span>Source</span>
          {fmtClock(clip.srcStart)} → {fmtClock(clip.srcEnd)}
        </div>
        <div>
          <span>On timeline</span>
          {fmtClock(clip.outEnd - clip.outStart)}
        </div>
      </div>

      <div className="label-row label-strong" style={{ marginTop: 18 }}>
        Speed · {fmtSpeed(clip.speed)}
      </div>
      <div className="clip-speed-grid">
        {SPEED_PRESETS.map((x) => (
          <button
            key={x}
            className={`clip-speed-btn ${Math.abs(clip.speed - x) < 1e-6 ? "active" : ""}`}
            onClick={() => onPatch({ speed: x })}
          >
            {fmtSpeed(x)}
          </button>
        ))}
      </div>
      <div className="clip-speed-custom">
        <span>Custom</span>
        <input
          type="text"
          inputMode="decimal"
          value={speedText}
          onChange={(e) => setSpeedText(e.target.value)}
          onBlur={commitSpeed}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          aria-label="Custom speed"
        />
        <span>× ({SPEED_MIN}–{SPEED_MAX})</span>
      </div>

      <div className="row-toggle" style={{ marginTop: 18 }}>
        <div className="col">
          <div className="label">Mute audio</div>
          <div className="desc">
            Silences every audio track while this clip plays. Handy for timelapses, since sped-up
            audio also plays faster.
          </div>
        </div>
        <button
          className={`switch ${clip.muted ? "on" : ""}`}
          onClick={() => onPatch({ muted: !clip.muted })}
          role="switch"
          aria-checked={clip.muted}
          aria-label="Mute clip audio"
        />
      </div>

      <div className="label-row label-strong" style={{ marginTop: 22 }}>
        Edit
      </div>
      <div className="clip-actions">
        <button className="btn-wide" onClick={onSplit} title="Split at playhead (S)">
          <Ico.scissors size={12} /> Split at playhead
        </button>
        <button className="btn-wide" onClick={onDuplicate}>
          <Ico.copy size={12} /> Duplicate
        </button>
        <div className="clip-actions-row">
          <button className="btn-wide" onClick={() => onMove(-1)} disabled={index === 0}>
            <Ico.chevLeft size={12} /> Move earlier
          </button>
          <button className="btn-wide" onClick={() => onMove(1)} disabled={index === count - 1}>
            Move later <Ico.chevRight size={12} />
          </button>
        </div>
        <button
          className="btn-wide clip-delete"
          onClick={onDelete}
          disabled={count <= 1}
          title={count <= 1 ? "The last clip can't be deleted" : "Delete clip (⌫)"}
        >
          <Ico.trash size={12} /> Delete clip
        </button>
      </div>
      <div className="helper-text" style={{ marginTop: 14 }}>
        Drag a clip to reorder it. Drag its edges to trim. The gap closes automatically.
      </div>
    </div>
  );
}

function AudioPanel({
  rows,
  onChange,
  duration,
  selectedKey,
}: {
  rows: AudioRowInfo[];
  onChange: (key: AudioTrackKey, patch: Partial<AudioTrackState>) => void;
  duration: number;
  selectedKey: AudioTrackKey | null;
}) {
  const fmt = (s: number) => `${s.toFixed(1)}s`;
  return (
    <div className="section">
      <h3 className="section-title">
        <Ico.audio size={15} /> Audio
      </h3>
      {rows.length === 0 && (
        <div className="helper-text">
          No audio tracks in this recording. Turn on the microphone or system
          audio pills in the recorder before capturing.
        </div>
      )}
      {rows.map((row, i) => (
        <div
          key={row.key}
          style={{
            marginTop: i === 0 ? 4 : 22,
            paddingLeft: 8,
            borderLeft:
              selectedKey === row.key
                ? "2px solid var(--accent, #4f8cff)"
                : "2px solid transparent",
          }}
        >
          <div className="label-row label-strong">{row.label}</div>
          <div className="seg">
            <button
              className={!row.track.muted ? "on" : ""}
              onClick={() => onChange(row.key, { muted: false })}
            >
              On
            </button>
            <button
              className={row.track.muted ? "on" : ""}
              onClick={() => onChange(row.key, { muted: true })}
            >
              Muted
            </button>
          </div>
          <div className="label-row label-strong" style={{ marginTop: 14 }}>
            Volume · {Math.round(row.track.gain * 100)}%
          </div>
          <Slider
            value={Math.round(row.track.gain * 100)}
            onChange={(v) => onChange(row.key, { gain: v / 100 })}
            min={0}
            max={100}
            onReset={() => onChange(row.key, { gain: 1 })}
          />
          <div className="label-row label-strong" style={{ marginTop: 14 }}>
            Auto level
          </div>
          <div className="seg">
            <button
              className={!row.track.normalize ? "on" : ""}
              onClick={() => onChange(row.key, { normalize: false })}
            >
              Off
            </button>
            <button
              className={row.track.normalize ? "on" : ""}
              onClick={() => onChange(row.key, { normalize: true })}
            >
              On
            </button>
          </div>
          <div className="helper-text" style={{ marginTop: 6 }}>
            {row.track.normalize
              ? `Leveling to ~${Math.round(AUTO_LEVEL_TARGET * 100)}% peak · applying ×${row.autoGain.toFixed(2)} to this track.`
              : "Lifts quiet audio and tames loud peaks toward a consistent level."}
          </div>
          {(row.track.trimStart > 0 || row.track.trimEnd > 0) && (
            <div
              className="helper-text"
              style={{
                marginTop: 8,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <span>
                Plays {fmt(row.track.trimStart)} → {fmt(Math.max(0, duration - row.track.trimEnd))}
              </span>
              <button
                className="reset"
                onClick={() => onChange(row.key, { trimStart: 0, trimEnd: 0 })}
              >
                Reset trim
              </button>
            </div>
          )}
        </div>
      ))}
      {rows.length > 0 && (
        <div className="helper-text" style={{ marginTop: 18 }}>
          Drag the handles on an audio row in the timeline to crop where it
          plays.
        </div>
      )}
    </div>
  );
}

function CameraPanel({
  hasCamera,
  cam,
  onChange,
  onAddKeyframe,
  onClearKeyframes,
}: {
  hasCamera: boolean;
  cam: CameraState;
  onChange: (p: Partial<CameraState>) => void;
  onAddKeyframe: () => void;
  onClearKeyframes: () => void;
}) {
  return (
    <div className="section">
      <h3 className="section-title">
        <Ico.webcam size={15} /> Camera
      </h3>
      {!hasCamera ? (
        <div className="helper-text">
          No camera track in this recording. Turn on the camera pill in the
          recorder before capturing.
        </div>
      ) : (
        <>
          <div className="label-row label-strong">Show camera</div>
          <div className="seg">
            <button className={cam.enabled ? "on" : ""} onClick={() => onChange({ enabled: true })}>
              On
            </button>
            <button className={!cam.enabled ? "on" : ""} onClick={() => onChange({ enabled: false })}>
              Off
            </button>
          </div>

          <div className="label-row label-strong" style={{ marginTop: 18 }}>
            Size · {Math.round(cam.size * 100)}%
          </div>
          <Slider
            value={Math.round(cam.size * 100)}
            onChange={(v) => onChange({ size: Math.min(0.5, Math.max(0.08, v / 100)) })}
            min={8}
            max={50}
            onReset={() => onChange({ size: 0.2 })}
          />

          <div className="label-row label-strong" style={{ marginTop: 18 }}>
            Shape
          </div>
          <div className="seg">
            <button className={cam.shape === "circle" ? "on" : ""} onClick={() => onChange({ shape: "circle" })}>
              Circle
            </button>
            <button className={cam.shape === "rounded" ? "on" : ""} onClick={() => onChange({ shape: "rounded" })}>
              Rounded
            </button>
          </div>

          <div className="label-row label-strong" style={{ marginTop: 18 }}>
            Mirror
          </div>
          <div className="seg">
            <button className={cam.mirrored ? "on" : ""} onClick={() => onChange({ mirrored: true })}>
              On
            </button>
            <button className={!cam.mirrored ? "on" : ""} onClick={() => onChange({ mirrored: false })}>
              Off
            </button>
          </div>

          <div className="label-row label-strong" style={{ marginTop: 18 }}>
            Position keyframes · {cam.keyframes.length}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <button className="reset" onClick={onAddKeyframe}>
              + Add at playhead
            </button>
            {cam.keyframes.length > 0 && (
              <button className="reset" onClick={onClearKeyframes}>
                Clear all
              </button>
            )}
          </div>
          <div className="helper-text" style={{ marginTop: 12 }}>
            {cam.keyframes.length === 0
              ? "Drag the camera bubble in the preview to place it; drag its corner handle to resize. Add a keyframe to start animating its position over time."
              : "With keyframes set, dragging the bubble updates the keyframe at the playhead (a new one is created if none is there). The camera glides between keyframes. On the timeline's camera row: click a diamond to jump to it, ⌥-click to delete it."}
          </div>
        </>
      )}
    </div>
  );
}

function Inspector({
  active,
  state,
  set,
  cursorSidecar,
  zoomSettings,
  setZoomSettings,
  zoomSegments,
  setZoomSegments,
  selectedSeg,
  videoSrc,
  audioRows,
  onAudioTrack,
  selectedAudioKey,
  duration,
  currentTime,
  hasCamera,
  onCameraAddKeyframe,
  onCameraClearKeyframes,
  effectSegments,
  setEffectSegments,
  selectedEffectSeg,
  onSelectEffect,
  clipPanel,
}: {
  clipPanel: ClipPanelProps | null;
  active: string;
  state: EditorState;
  set: (p: StatePatch) => void;
  cursorSidecar: CursorSidecar | null;
  zoomSettings: ZoomSettings;
  setZoomSettings: (patch: Partial<ZoomSettings>) => void;
  zoomSegments: ZoomSegment[];
  setZoomSegments: (next: ZoomSegment[]) => void;
  selectedSeg: ZoomSegment | null;
  videoSrc: string;
  audioRows: AudioRowInfo[];
  onAudioTrack: (key: AudioTrackKey, patch: Partial<AudioTrackState>) => void;
  selectedAudioKey: AudioTrackKey | null;
  duration: number;
  currentTime: number;
  hasCamera: boolean;
  onCameraAddKeyframe: () => void;
  onCameraClearKeyframes: () => void;
  effectSegments: EffectSegment[];
  setEffectSegments: (next: EffectSegment[]) => void;
  selectedEffectSeg: EffectSegment | null;
  onSelectEffect: (id: string | null) => void;
}) {
  return (
    <aside className="inspector">
      {clipPanel ? (
        <ClipPanel {...clipPanel} />
      ) : selectedSeg ? (
        <ZoomSegmentPanel
          seg={selectedSeg}
          setSegments={setZoomSegments}
          segments={zoomSegments}
          defaultLevel={zoomSettings.defaultLevel}
          videoSrc={videoSrc}
          cursorSidecar={cursorSidecar}
        />
      ) : selectedEffectSeg ? (
        <EffectSegmentPanel
          seg={selectedEffectSeg}
          segments={effectSegments}
          setSegments={setEffectSegments}
        />
      ) : active === "cursor" ? (
        <CursorZoomPanel
          cursorSidecar={cursorSidecar}
          zoomSettings={zoomSettings}
          setZoomSettings={setZoomSettings}
          zoomSegments={zoomSegments}
          setZoomSegments={setZoomSegments}
        />
      ) : active === "audio" ? (
        <AudioPanel
          rows={audioRows}
          onChange={onAudioTrack}
          duration={duration}
          selectedKey={selectedAudioKey}
        />
      ) : active === "webcam" ? (
        <CameraPanel
          hasCamera={hasCamera}
          cam={state.camera}
          onChange={(p) => set({ camera: { ...state.camera, ...p } })}
          onAddKeyframe={onCameraAddKeyframe}
          onClearKeyframes={onCameraClearKeyframes}
        />
      ) : active === "effects" ? (
        <EffectsLibraryPanel
          effectSegments={effectSegments}
          setEffectSegments={setEffectSegments}
          currentTime={currentTime}
          duration={duration}
          onSelect={onSelectEffect}
        />
      ) : (
        <BackgroundPanel state={state} set={set} />
      )}
    </aside>
  );
}

function IconRail({
  active,
  setActive,
}: {
  active: string;
  setActive: (id: string) => void;
}) {
  const items = [
    { id: "background", icon: <Ico.rect size={17} />, badge: true },
    { id: "cursor", icon: <Ico.cursor size={17} /> },
    { id: "webcam", icon: <Ico.webcam size={17} /> },
    { id: "effects", icon: <Ico.sparkles size={17} /> },
    { id: "subtitles", icon: <Ico.speech size={17} />, disabled: true },
    { id: "audio", icon: <Ico.audio size={17} /> },
    { id: "shortcuts", icon: <Ico.cmd size={17} />, disabled: true },
    { id: "actions", icon: <Ico.link size={17} />, disabled: true },
  ];
  return (
    <div className="icon-rail">
      {items.map((it) => (
        <button
          key={it.id}
          className={`rail-btn ${active === it.id ? "active" : ""} ${
            it.disabled ? "disabled" : ""
          }`}
          onClick={() => !it.disabled && setActive(it.id)}
          aria-disabled={it.disabled || undefined}
          data-tip={it.disabled ? "Coming soon" : undefined}
          title={it.disabled ? undefined : it.id}
        >
          {it.icon}
          {it.badge && <span className="badge" />}
        </button>
      ))}
    </div>
  );
}

/**
 * The draggable/resizable camera bubble. Lives directly in the canvas frame
 * (frame space) — deliberately outside the zoomed video wrapper, so the
 * bubble stays put while the screen content zooms. Mirrors `drawCamera` in
 * lib/compositor, which bakes the same geometry into exports.
 */
function CameraOverlay({
  src,
  shape,
  mirrored,
  eff,
  frameW,
  frameH,
  videoRef,
  onTransform,
  onSelect,
}: {
  src: string;
  shape: CameraState["shape"];
  mirrored: boolean;
  /** Evaluated position/size at the playhead (keyframe-interpolated). */
  eff: { pos: { x: number; y: number }; size: number };
  frameW: number;
  frameH: number;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  onTransform: (p: { pos?: { x: number; y: number }; size?: number }) => void;
  onSelect: () => void;
}) {
  const box = eff.size * frameW;
  const left = eff.pos.x * frameW - box / 2;
  const top = eff.pos.y * frameH - box / 2;

  const clampPos = (x: number, y: number, size: number) => {
    const halfX = size / 2;
    const halfY = (size * frameW) / 2 / Math.max(1, frameH);
    return {
      x: Math.min(1 - halfX, Math.max(halfX, x)),
      y: Math.min(1 - halfY, Math.max(halfY, y)),
    };
  };

  const beginMove = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    onSelect();
    const startX = e.clientX;
    const startY = e.clientY;
    const start = eff.pos;
    const move = (ev: PointerEvent) => {
      const nx = start.x + (ev.clientX - startX) / Math.max(1, frameW);
      const ny = start.y + (ev.clientY - startY) / Math.max(1, frameH);
      onTransform({ pos: clampPos(nx, ny, eff.size) });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const beginResize = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    onSelect();
    const startX = e.clientX;
    const startSize = eff.size;
    const startPos = eff.pos;
    const move = (ev: PointerEvent) => {
      const size = Math.min(
        0.5,
        Math.max(0.08, startSize + ((ev.clientX - startX) / Math.max(1, frameW)) * 2),
      );
      onTransform({ size, pos: clampPos(startPos.x, startPos.y, size) });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      className={`camera-overlay ${shape}`}
      style={{ left, top, width: box, height: box }}
      onPointerDown={beginMove}
      title="Drag to move the camera"
    >
      <video
        ref={videoRef}
        src={src}
        muted
        playsInline
        preload="auto"
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          display: "block",
          transform: mirrored ? "scaleX(-1)" : undefined,
          pointerEvents: "none",
        }}
      />
      <div
        className="camera-resize"
        onPointerDown={beginResize}
        title="Drag to resize"
      />
    </div>
  );
}

/** The GL compositor manages its own glyph textures; opts still want a map. */
const EMPTY_GLYPHS = new Map<CursorSidecarShapeName, CanvasImageSource>();

function Canvas({
  aspect,
  wallpaper,
  padding,
  blur,
  viewportSize,
  videoSrc,
  videoRef,
  cursorSidecar,
  zoomSegments,
  zoomSettings,
  effectSegments,
  videoNaturalSize,
  cropRect,
  previewFps,
  cameraSrc,
  camera,
  cameraEff,
  cameraVideoRef,
  onCameraTransform,
  onCameraSelect,
}: {
  aspect: AspectKey;
  wallpaper: string;
  padding: number;
  blur: number;
  viewportSize: { w: number; h: number };
  videoSrc: string;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  cursorSidecar: CursorSidecar | null;
  zoomSegments: ZoomSegment[];
  zoomSettings: ZoomSettings;
  effectSegments: EffectSegment[];
  videoNaturalSize: { w: number; h: number } | null;
  cropRect: CropRect | null;
  previewFps: number;
  cameraSrc: string | null;
  camera: CameraState;
  cameraEff: { pos: { x: number; y: number }; size: number };
  cameraVideoRef: React.RefObject<HTMLVideoElement | null>;
  onCameraTransform: (p: { pos?: { x: number; y: number }; size?: number }) => void;
  onCameraSelect: () => void;
}) {
  const a = ASPECTS[aspect];
  // Frame/window geometry is shared with the offline exporter so the preview
  // and the exported video can never drift. See lib/compositor.
  const layout = computeFrameLayout({
    aspectRatio: a.w / a.h,
    isSystem: aspect === "system",
    videoNaturalSize,
    cropRect,
    padding,
    box: viewportSize,
  });
  const { w, h, ratio } = layout;
  const wrapPxW = layout.wrapW;
  const wrapPxH = layout.wrapH;

  // Drive the zoom transform on the video element from a RAF that reads the
  // live currentTime. Writing transforms directly (not via React state) keeps
  // this off the render path so 60 Hz updates don't trash the reconciler.
  const videoWrapRef = useRef<HTMLDivElement | null>(null);
  const cursorElRef = useRef<HTMLDivElement | null>(null);

  // GPU preview: the recorded window (video + zoom + motion blur + cursor)
  // renders on a WebGL canvas via the shared compositor; wallpaper and the
  // interactive camera overlay stay DOM. Requires a same-origin (blob:)
  // video source for texture uploads — until then, and whenever GL is
  // unavailable or errors, the CSS-transform DOM path below still runs.
  const glCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const glRef = useRef<GLCompositor | null>(null);
  const glBrokenRef = useRef(false);
  const cursorStateRef = useRef(makeCursorRenderState());
  const glSafe = videoSrc.startsWith("blob:");
  const [glActive, setGlActive] = useState(false);
  useEffect(() => {
    if (!glSafe || glBrokenRef.current) return;
    const cnv = glCanvasRef.current;
    if (!cnv) return;
    const glc = GLCompositor.create(cnv);
    if (!glc) return;
    let alive = true;
    rasterizeGlyphsGL()
      .then((g) => {
        if (alive) glc.setGlyphs(g);
      })
      .catch(() => {
        /* cursor just won't draw on the GL canvas */
      });
    glRef.current = glc;
    setGlActive(true);
    return () => {
      alive = false;
      glRef.current = null;
      glc.dispose();
      setGlActive(false);
    };
  }, [glSafe]);

  useEffect(() => {
    const wrap = videoWrapRef.current;
    const video = videoRef.current;
    if (!wrap || !video) return;
    const smoothing = Math.max(0, Math.min(1, zoomSettings.smoothing / 100));
    let raf = 0;
    // The cursor is a child of `wrap`, so the zoom transform applied to `wrap`
    // also scales/pans the synthetic cursor — keeping it glued to the content.
    // We only need to position it in the wrapper's *untransformed* pixel space.
    let lastShape: CursorSidecarShapeName | null = null;
    let lastHot: [number, number] = [0, 0];
    // Critically-damped smoothing of the rendered position. Samples arrive at
    // the recording framerate; we interpolate to the exact playback time, then
    // low-pass that toward the screen so jitter in the raw mouse path melts
    // into a smooth glide. Frame-rate independent (alpha derived from real dt).
    // Snapped — not smoothed — on (re)appear or when the playhead jumps
    // (scrub/seek), so scrubbing stays responsive instead of gliding in from
    // the old spot.
    const SMOOTH_TAU = 0.06; // seconds; larger = smoother + laggier
    let sx = 0;
    let sy = 0;
    let hasS = false;
    let lastTMs = 0;
    let lastFrameMs = performance.now();
    const positionCursor = () => {
      const el = cursorElRef.current;
      if (!el) return;
      if (!cursorSidecar) {
        el.style.display = "none";
        hasS = false;
        return;
      }
      const tMs = video.currentTime * 1000;
      const pos = cursorPosAt(cursorSidecar, tMs);
      if (!pos) {
        el.style.display = "none";
        hasS = false;
        return;
      }
      const wrapW = wrap.offsetWidth;
      const wrapH = wrap.offsetHeight;
      const vw = video.videoWidth || wrapW;
      const vh = video.videoHeight || wrapH;
      const fit = Math.min(wrapW / vw, wrapH / vh);
      const crop = cursorSidecar.crop;
      const refW = crop ? crop.width : cursorSidecar.display.width;
      const refH = crop ? crop.height : cursorSidecar.display.height;
      // Normalised position within the recorded frame (0..1).
      let nx = pos.x / Math.max(1, refW);
      let ny = pos.y / Math.max(1, refH);
      let dW = vw * fit;
      let dH = vh * fit;
      let oX = (wrapW - dW) / 2;
      let oY = (wrapH - dH) / 2;
      // An editor-time crop re-frames the video element to fill the wrapper;
      // remap into that sub-rect and let it fill the wrapper (no letterbox).
      if (cropRect) {
        nx = (nx - cropRect.x) / cropRect.w;
        ny = (ny - cropRect.y) / cropRect.h;
        dW = wrapW;
        dH = wrapH;
        oX = 0;
        oY = 0;
      }
      if (nx < 0 || nx > 1 || ny < 0 || ny > 1) {
        el.style.display = "none";
        hasS = false;
        return;
      }
      const px = oX + nx * dW;
      const py = oY + ny * dH;
      // Smooth toward the target. Snap on first show or a playhead jump.
      const nowMs = performance.now();
      const dt = (nowMs - lastFrameMs) / 1000;
      lastFrameMs = nowMs;
      const jumped = Math.abs(tMs - lastTMs) > 120 || dt > 0.1 || dt < 0;
      lastTMs = tMs;
      if (!hasS || jumped) {
        sx = px;
        sy = py;
        hasS = true;
      } else {
        const alpha = 1 - Math.exp(-dt / SMOOTH_TAU);
        sx += (px - sx) * alpha;
        sy += (py - sy) * alpha;
      }
      // A macOS cursor is ~24 points; scale it by how recording points map to
      // wrapper pixels so it reads at a natural size, then zoom carries it.
      const refUnitsAcross = refW * (cropRect ? cropRect.w : 1);
      const pxPerRefUnit = dW / Math.max(1, refUnitsAcross);
      const size = Math.max(14, Math.min(64, 24 * pxPerRefUnit));
      const shape = cursorShapeAt(cursorSidecar, tMs);
      if (shape !== lastShape) {
        lastShape = shape;
        const g = glyphFor(shape);
        lastHot = g.hot;
        el.innerHTML = `<svg viewBox="0 0 24 24" width="100%" height="100%" style="overflow:visible;display:block">${g.svg}</svg>`;
      }
      el.style.width = `${size}px`;
      el.style.height = `${size}px`;
      el.style.display = "block";
      el.style.transform = `translate(${sx - lastHot[0] * size}px, ${sy - lastHot[1] * size}px)`;
    };
    const apply = () => {
      // Shared with the offline exporter — see lib/compositor. Uses the
      // unscaled layout box (offsetWidth) so a transformed measurement can't
      // feed the previous frame's scale back into this one.
      const zt = computeZoomTransform({
        tMs: video.currentTime * 1000,
        zoomEnabled: zoomSettings.autoOn,
        zoomSegments,
        cursorSidecar,
        smoothing,
        wrapW: wrap.offsetWidth,
        wrapH: wrap.offsetHeight,
        videoW: video.videoWidth,
        videoH: video.videoHeight,
      });
      wrap.style.transformOrigin = "0 0";
      wrap.style.transform = `translate(${zt.tx}px, ${zt.ty}px) scale(${zt.scale})`;
      // DOM fallback path: apply the CSS-filter-representable subset of the
      // active effect segment directly to the recorded window. Vignette /
      // temperature-tint / grain need canvas compositing and are skipped
      // here — a reasonable degraded look on the rare non-GL path.
      wrap.style.filter = postFxCssFilter(
        resolveEffectParams(video.currentTime * 1000, effectSegments),
      );
    };
    // --- GPU branch: render the recorded window with the shared compositor.
    // Skips redraws while nothing changed (static playhead + decoded frame),
    // so an idle paused editor does no GPU work.
    const useGl = glActive && !glBrokenRef.current;
    let glDirty = true;
    let lastDrawnTMs = -1;
    let lastDrawMs = performance.now();
    let lastOutW = 0;
    let lastOutH = 0;
    const markDirty = () => {
      glDirty = true;
    };
    let rvfcId: number | null = null;
    const anyVideo = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
      cancelVideoFrameCallback?: (id: number) => void;
    };
    if (useGl) {
      // Neutralize the DOM path's leftovers: the canvas owns zoom + cursor
      // + post-fx.
      wrap.style.transform = "";
      wrap.style.filter = "";
      if (cursorElRef.current) cursorElRef.current.style.display = "none";
      cursorStateRef.current.has = false;
      video.addEventListener("seeked", markDirty);
      if (typeof anyVideo.requestVideoFrameCallback === "function") {
        const loop = () => {
          markDirty();
          rvfcId = anyVideo.requestVideoFrameCallback!(loop);
        };
        rvfcId = anyVideo.requestVideoFrameCallback(loop);
      }
    }
    const glDraw = (nowMs: number) => {
      const glc = glRef.current;
      const cnv = glCanvasRef.current;
      if (!glc || !cnv) return;
      const wrapW = wrap.offsetWidth;
      const wrapH = wrap.offsetHeight;
      if (wrapW < 1 || wrapH < 1 || video.readyState < 2) return;
      const dpr = window.devicePixelRatio || 1;
      const outW = Math.max(1, Math.round(wrapW * dpr));
      const outH = Math.max(1, Math.round(wrapH * dpr));
      const tMs = video.currentTime * 1000;
      if (
        !glDirty &&
        tMs === lastDrawnTMs &&
        outW === lastOutW &&
        outH === lastOutH
      ) {
        return;
      }
      const dtSec = Math.min(1 / 15, Math.max(0, (nowMs - lastDrawMs) / 1000));
      lastDrawMs = nowMs;
      // The canvas spans only the recorded window, so synthesize a layout
      // whose frame *is* the wrap box (no padding, no wrap offset).
      const o: RenderFrameOpts = {
        layout: {
          w: wrapW,
          h: wrapH,
          ratio: wrapW / Math.max(1, wrapH),
          padding: 0,
          innerW: wrapW,
          innerH: wrapH,
          wrapW,
          wrapH,
          wrapX: 0,
          wrapY: 0,
        },
        s: dpr,
        outW,
        outH,
        videoSource: video,
        videoNaturalSize: {
          w: video.videoWidth || 1,
          h: video.videoHeight || 1,
        },
        wallpaper: "",
        wallpaperImg: null,
        blur: 0,
        cropRect,
        cursorSidecar,
        zoomSegments,
        zoomEnabled: zoomSettings.autoOn,
        smoothing,
        timeMs: tMs,
        glyphImages: EMPTY_GLYPHS,
        cursorState: cursorStateRef.current,
        dtSec,
        camera: null,
        postFx: resolveEffectParams(tMs, effectSegments),
      };
      try {
        glc.render(o, { drawWallpaper: false, drawCamera: false });
        glDirty = false;
        lastDrawnTMs = tMs;
        lastOutW = outW;
        lastOutH = outH;
      } catch {
        // Cross-origin/driver failure: permanently fall back to the DOM path.
        glBrokenRef.current = true;
        setGlActive(false);
      }
    };

    // previewFps === 0 means uncapped (full refresh rate). Otherwise throttle
    // the transform loop to the target interval to cut CPU/GPU usage.
    const frameInterval = previewFps > 0 ? 1000 / previewFps : 0;
    let lastFrame = 0;
    const tick = (now: number) => {
      if (frameInterval === 0 || now - lastFrame >= frameInterval) {
        lastFrame = now;
        if (useGl && !glBrokenRef.current) {
          glDraw(now);
        } else {
          apply();
          positionCursor();
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      if (useGl) {
        video.removeEventListener("seeked", markDirty);
        if (rvfcId !== null && anyVideo.cancelVideoFrameCallback) {
          anyVideo.cancelVideoFrameCallback(rvfcId);
        }
      }
    };
  }, [
    videoRef,
    cursorSidecar,
    zoomSegments,
    zoomSettings,
    effectSegments,
    cropRect,
    previewFps,
    glActive,
  ]);

  const wallpaperIsImage = isWallpaperImage(wallpaper);
  return (
    <div
      className="canvas-frame"
      style={{
        width: w,
        height: h,
        aspectRatio: `${ratio}`,
      }}
    >
      <div className="canvas-clip">
        <div
          className={`canvas-bg ${wallpaperIsImage ? "" : wallpaper}`}
          style={{
            filter: blur ? `blur(${blur * 0.18}px)` : "none",
            inset: blur ? `${-(blur * 0.3 + 4)}px` : 0,
            ...(wallpaperIsImage
              ? {
                  backgroundImage: `linear-gradient(rgba(0,0,0,0.15), rgba(0,0,0,0.15)), url("${convertFileSrc(wallpaper)}")`,
                }
              : {}),
          }}
        />
      </div>
      <div className="canvas-inner" style={{ ["--padding" as string]: `${padding}px` } as React.CSSProperties}>
        <div className="recorded-window">
          <div
            ref={videoWrapRef}
            style={{
              position: "relative",
              width: wrapPxW != null ? `${wrapPxW}px` : "100%",
              height: wrapPxH != null ? `${wrapPxH}px` : "100%",
              maxWidth: "100%",
              maxHeight: "100%",
              borderRadius: "var(--radius-lg)",
              overflow: "hidden",
              willChange: "transform",
            }}
          >
            <video
              ref={videoRef}
              src={videoSrc}
              style={{
                ...(cropRect
                  ? {
                      position: "absolute" as const,
                      width: `${100 / cropRect.w}%`,
                      height: `${100 / cropRect.h}%`,
                      left: `${-(cropRect.x / cropRect.w) * 100}%`,
                      top: `${-(cropRect.y / cropRect.h) * 100}%`,
                      display: "block",
                      objectFit: "contain" as const,
                    }
                  : {
                      width: "100%",
                      height: "100%",
                      display: "block",
                      objectFit: "contain" as const,
                    }),
                // GL mode draws the video on the canvas; keep the element
                // alive (it is the texture source + audio clock), just unseen.
                ...(glActive ? { opacity: 0 } : {}),
              }}
              playsInline
              preload="metadata"
            />
            <canvas
              ref={glCanvasRef}
              aria-hidden
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                display: glActive ? "block" : "none",
                pointerEvents: "none",
              }}
            />
            <div
              ref={cursorElRef}
              aria-hidden
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                display: "none",
                pointerEvents: "none",
                willChange: "transform",
                transformOrigin: "0 0",
                filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.45))",
              }}
            />
          </div>
        </div>
      </div>
      {cameraSrc && camera.enabled && (
        <CameraOverlay
          src={cameraSrc}
          shape={camera.shape}
          mirrored={camera.mirrored}
          eff={cameraEff}
          frameW={w}
          frameH={h}
          videoRef={cameraVideoRef}
          onTransform={onCameraTransform}
          onSelect={onCameraSelect}
        />
      )}
    </div>
  );
}

function ZoomSlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);

  const setFromX = (clientX: number) => {
    if (!ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    onChange(Math.round(pct * 100));
  };

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (dragging.current) setFromX(e.clientX);
    };
    const up = () => {
      dragging.current = false;
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, []);

  return (
    <div className="zoom-slider-wrap">
      <Ico.arrowLR size={14} />
      <div
        className="zoom-slider"
        ref={ref}
        onMouseDown={(e) => {
          e.preventDefault();
          dragging.current = true;
          setFromX(e.clientX);
        }}
        style={{ userSelect: "none", cursor: "ew-resize" }}
      >
        <div className="fill" style={{ width: `${value}%` }} />
        <div className="knob" style={{ left: `${value}%` }} />
      </div>
    </div>
  );
}

function Viewport({
  state,
  set,
  onPlayToggle,
  onCrop,
  playing,
  currentTime,
  duration,
  videoSrc,
  videoRef,
  onSeek,
  cursorSidecar,
  zoomSegments,
  zoomSettings,
  effectSegments,
  videoNaturalSize,
  previewFps,
  cameraSrc,
  cameraEff,
  cameraVideoRef,
  onCameraTransform,
  onCameraSelect,
  onSplit,
}: {
  state: EditorState;
  set: (p: StatePatch) => void;
  onSplit: () => void;
  onPlayToggle: () => void;
  onCrop: () => void;
  playing: boolean;
  currentTime: number;
  duration: number;
  videoSrc: string;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  onSeek: (t: number) => void;
  cursorSidecar: CursorSidecar | null;
  zoomSegments: ZoomSegment[];
  zoomSettings: ZoomSettings;
  effectSegments: EffectSegment[];
  videoNaturalSize: { w: number; h: number } | null;
  previewFps: number;
  cameraSrc: string | null;
  cameraEff: { pos: { x: number; y: number }; size: number };
  cameraVideoRef: React.RefObject<HTMLVideoElement | null>;
  onCameraTransform: (p: { pos?: { x: number; y: number }; size?: number }) => void;
  onCameraSelect: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 1000, h: 540 });

  useEffect(() => {
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (!wrapRef.current) return;
        const r = wrapRef.current.getBoundingClientRect();
        setSize({ w: r.width, h: r.height });
      });
    };
    update();
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      cancelAnimationFrame(raf);
    };
  }, []);

  const fmt = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  return (
    <div className="viewport" ref={wrapRef}>
      <Canvas
        aspect={state.aspect}
        wallpaper={state.wallpaper}
        padding={state.padding}
        blur={state.blur}
        viewportSize={size}
        videoSrc={videoSrc}
        videoRef={videoRef}
        cursorSidecar={cursorSidecar}
        zoomSegments={zoomSegments}
        zoomSettings={zoomSettings}
        effectSegments={effectSegments}
        videoNaturalSize={videoNaturalSize}
        cropRect={state.cropRect}
        previewFps={previewFps}
        cameraSrc={cameraSrc}
        camera={state.camera}
        cameraEff={cameraEff}
        cameraVideoRef={cameraVideoRef}
        onCameraTransform={onCameraTransform}
        onCameraSelect={onCameraSelect}
      />
      <div className="viewport-bottombar">
        <div className="left">
          <button
            className="aspect-dropdown"
            onClick={() => {
              const i = ASPECT_ORDER.indexOf(state.aspect);
              set({ aspect: ASPECT_ORDER[(i + 1) % ASPECT_ORDER.length] });
            }}
            title="Cycle aspect ratio"
          >
            <Ico.rect size={13} />
            <span className="label">{ASPECTS[state.aspect].label}</span>
            <span className="value">{ASPECTS[state.aspect].short}</span>
            <Ico.chevDown size={10} style={{ opacity: 0.6 }} />
          </button>
          <button
            className={`crop-btn ${state.cropRect ? "on" : ""}`}
            onClick={onCrop}
            style={state.cropRect ? { background: "var(--accent, #4f8cff)", color: "white" } : undefined}
          >
            <Ico.crop size={13} /> Crop
          </button>
        </div>
        <div className="center">
          <button
            className="transport-btn"
            title="Skip back 5s"
            onClick={() => onSeek(Math.max(0, currentTime - 5))}
          >
            <Ico.rewind size={18} />
          </button>
          <button
            className="transport-btn play"
            onClick={onPlayToggle}
            title={playing ? "Pause" : "Play"}
          >
            {playing ? <Ico.pause size={16} /> : <Ico.play size={16} />}
          </button>
          <button
            className="transport-btn"
            title="Skip forward 5s"
            onClick={() => onSeek(Math.min(duration, currentTime + 5))}
          >
            <Ico.fwd size={18} />
          </button>
          <span
            style={{
              marginLeft: 14,
              fontSize: 12,
              color: "var(--text-2)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {fmt(currentTime)} <span style={{ color: "var(--text-3)" }}>/ {fmt(duration)}</span>
          </span>
        </div>
        <div className="right">
          <button
            className="transport-btn"
            title="Split clip at playhead (S)"
            onClick={onSplit}
          >
            <Ico.scissors size={16} />
          </button>
          <ZoomSlider value={state.zoom} onChange={(v) => set({ zoom: v })} />
        </div>
      </div>
    </div>
  );
}

function buildWavePath(peaks: number[], h: number) {
  if (peaks.length === 0) return "";
  const mid = h / 2;
  const amp = mid * 0.92;
  let d = `M0,${mid.toFixed(2)}`;
  for (let i = 0; i < peaks.length; i++) {
    d += ` L${i},${(mid - peaks[i] * amp).toFixed(2)}`;
  }
  for (let i = peaks.length - 1; i >= 0; i--) {
    d += ` L${i},${(mid + peaks[i] * amp).toFixed(2)}`;
  }
  d += " Z";
  return d;
}

function ZoomChip({
  seg,
  leftPct,
  widthPct,
  totalMs,
  onUpdate,
  onDelete,
  selected,
  onSelect,
}: {
  seg: ZoomSegment;
  leftPct: number;
  widthPct: number;
  totalMs: number;
  onUpdate: (patch: Partial<ZoomSegment>) => void;
  onDelete: () => void;
  selected: boolean;
  onSelect: () => void;
}) {
  const dragMode = useRef<null | "move" | "start" | "end">(null);
  const dragRef = useRef<{ trackWidth: number; trackLeft: number; startMs: number; endMs: number; lengthMs: number }>({
    trackWidth: 0,
    trackLeft: 0,
    startMs: 0,
    endMs: 0,
    lengthMs: 0,
  });

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const mode = dragMode.current;
      if (!mode) return;
      const { trackWidth, trackLeft, startMs, endMs } = dragRef.current;
      if (trackWidth <= 0) return;
      const dxPct = ((e.clientX - trackLeft) / trackWidth) * 100;
      const dxMs = (dxPct / 100) * totalMs;
      if (mode === "start") {
        const next = Math.max(0, Math.min(endMs - 50, dxMs));
        onUpdate({ startMs: next });
      } else if (mode === "end") {
        const next = Math.max(startMs + 50, Math.min(totalMs, dxMs));
        onUpdate({ endMs: next });
      } else {
        // move: dxMs is the cursor's *absolute* position; preserve relative offset.
        // Recompute using delta from drag origin.
        const grabOffset = dragRef.current.startMs;
        const len = dragRef.current.lengthMs;
        let newStart = dxMs - grabOffset;
        newStart = Math.max(0, Math.min(totalMs - len, newStart));
        onUpdate({ startMs: newStart, endMs: newStart + len });
      }
    };
    const up = () => {
      dragMode.current = null;
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [onUpdate, totalMs]);

  const beginDrag = (mode: "move" | "start" | "end") => (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onSelect();
    const track = (e.currentTarget as HTMLElement).closest(".tl-track.zoom") as HTMLElement | null;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const grab = ((e.clientX - rect.left) / rect.width) * totalMs - seg.startMs;
    dragMode.current = mode;
    dragRef.current = {
      trackWidth: rect.width,
      trackLeft: rect.left,
      startMs: mode === "move" ? grab : seg.startMs,
      endMs: seg.endMs,
      lengthMs: seg.endMs - seg.startMs,
    };
  };

  return (
    <div
      className={`zoom-chip ${seg.source} ${selected ? "selected" : ""}`}
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        left: `${leftPct}%`,
        width: `${widthPct}%`,
      }}
      onMouseDown={beginDrag("move")}
      title={`${seg.targetLevel.toFixed(1)}× · click to drag, edges to resize`}
    >
      <span
        className="handle left"
        onMouseDown={beginDrag("start")}
      />
      <span className="body">
        <Ico.zoomIn size={10} /> {seg.targetLevel.toFixed(1)}×
      </span>
      <span
        className="handle right"
        onMouseDown={beginDrag("end")}
      />
      <button
        className="del"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
      >
        ✕
      </button>
    </div>
  );
}

/** Timeline chip for one Effects-track segment. Mirrors ZoomChip exactly. */
function EffectChip({
  seg,
  leftPct,
  widthPct,
  totalMs,
  onUpdate,
  onDelete,
  selected,
  onSelect,
}: {
  seg: EffectSegment;
  leftPct: number;
  widthPct: number;
  totalMs: number;
  onUpdate: (patch: Partial<EffectSegment>) => void;
  onDelete: () => void;
  selected: boolean;
  onSelect: () => void;
}) {
  const dragMode = useRef<null | "move" | "start" | "end">(null);
  const dragRef = useRef<{ trackWidth: number; trackLeft: number; startMs: number; endMs: number; lengthMs: number }>({
    trackWidth: 0,
    trackLeft: 0,
    startMs: 0,
    endMs: 0,
    lengthMs: 0,
  });

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const mode = dragMode.current;
      if (!mode) return;
      const { trackWidth, trackLeft, startMs, endMs } = dragRef.current;
      if (trackWidth <= 0) return;
      const dxPct = ((e.clientX - trackLeft) / trackWidth) * 100;
      const dxMs = (dxPct / 100) * totalMs;
      if (mode === "start") {
        const next = Math.max(0, Math.min(endMs - 50, dxMs));
        onUpdate({ startMs: next });
      } else if (mode === "end") {
        const next = Math.max(startMs + 50, Math.min(totalMs, dxMs));
        onUpdate({ endMs: next });
      } else {
        const grabOffset = dragRef.current.startMs;
        const len = dragRef.current.lengthMs;
        let newStart = dxMs - grabOffset;
        newStart = Math.max(0, Math.min(totalMs - len, newStart));
        onUpdate({ startMs: newStart, endMs: newStart + len });
      }
    };
    const up = () => {
      dragMode.current = null;
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [onUpdate, totalMs]);

  const beginDrag = (mode: "move" | "start" | "end") => (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onSelect();
    const track = (e.currentTarget as HTMLElement).closest(".tl-track.effects") as HTMLElement | null;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const grab = ((e.clientX - rect.left) / rect.width) * totalMs - seg.startMs;
    dragMode.current = mode;
    dragRef.current = {
      trackWidth: rect.width,
      trackLeft: rect.left,
      startMs: mode === "move" ? grab : seg.startMs,
      endMs: seg.endMs,
      lengthMs: seg.endMs - seg.startMs,
    };
  };

  const plugin = effectPlugin(seg.pluginId);

  return (
    <div
      className={`zoom-chip effect-chip ${selected ? "selected" : ""} ${seg.disabled ? "disabled" : ""}`}
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        left: `${leftPct}%`,
        width: `${widthPct}%`,
      }}
      onMouseDown={beginDrag("move")}
      title={`${plugin.name} · ${Math.round(seg.intensity * 100)}% · click to drag, edges to resize`}
    >
      <span className="handle left" onMouseDown={beginDrag("start")} />
      <span className="body">
        <Ico.sparkles size={10} /> {plugin.name}
      </span>
      <span className="handle right" onMouseDown={beginDrag("end")} />
      <button
        className="del"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
      >
        ✕
      </button>
    </div>
  );
}

/** Descriptor for one sidecar audio row shown in the timeline. */
type AudioRowInfo = {
  key: AudioTrackKey;
  label: string;
  peaks: number[] | null;
  track: AudioTrackState;
  /** Auto-level multiplier currently computed from the decoded track. */
  autoGain: number;
};

const AUDIO_ROW_H = 36;

function AudioTrackRow({
  info,
  total,
  clips,
  srcTotal,
  selected,
  onSelect,
  onChange,
}: {
  info: AudioRowInfo;
  total: number;
  clips: PlacedClip[];
  srcTotal: number;
  selected: boolean;
  onSelect: () => void;
  onChange: (patch: Partial<AudioTrackState>) => void;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const { track } = info;

  // Drag a trim handle: clientX → timeline seconds via the row's box. The
  // opposite edge is frozen for the duration of the drag, so capturing the
  // track state at mousedown is safe.
  const beginTrimDrag = (side: "start" | "end") => (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    onSelect();
    const row = rowRef.current;
    if (!row) return;
    const r = row.getBoundingClientRect();
    const MIN_GAP = 0.05;
    const move = (ev: MouseEvent) => {
      const frac = Math.max(0, Math.min(1, (ev.clientX - r.left) / Math.max(1, r.width)));
      const o = frac * total;
      const c = clips[clipIndexAtOut(clips, o)];
      if (!c) return;
      const t = outToSrc(c, o);
      if (side === "start") {
        onChange({ trimStart: Math.max(0, Math.min(t, srcTotal - track.trimEnd - MIN_GAP)) });
      } else {
        onChange({ trimEnd: Math.max(0, Math.min(srcTotal - t, srcTotal - track.trimStart - MIN_GAP)) });
      }
    };
    move(e.nativeEvent);
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // The waveform, trim shades and handles are drawn in output (edited) time.
  const outTotal = outDuration(clips);
  const peaks = useMemo(() => {
    const src = info.peaks;
    if (!src || src.length === 0) return src;
    const n = src.length;
    return Array.from({ length: n }, (_, j) => {
      const o = ((j + 0.5) / n) * outTotal;
      const c = clips[clipIndexAtOut(clips, o)];
      if (!c || c.muted) return 0;
      return src[Math.min(n - 1, Math.floor((outToSrc(c, o) / Math.max(1e-6, srcTotal)) * n))] ?? 0;
    });
  }, [info.peaks, clips, outTotal, srcTotal]);
  const trimEndSrc = srcTotal - track.trimEnd;
  const firstOut = clips
    .filter((c) => c.srcEnd >= track.trimStart)
    .map((c) => srcToOut(c, Math.max(track.trimStart, c.srcStart)));
  const lastOut = clips
    .filter((c) => c.srcStart <= trimEndSrc)
    .map((c) => srcToOut(c, Math.min(trimEndSrc, c.srcEnd)));
  const startPct = ((firstOut.length ? Math.min(...firstOut) : 0) / total) * 100;
  const endPct = ((lastOut.length ? Math.max(...lastOut) : outTotal) / total) * 100;
  const shades = [
    ...(track.trimStart > 0 ? srcRangePieces(clips, 0, track.trimStart) : []),
    ...(track.trimEnd > 0 ? srcRangePieces(clips, trimEndSrc, srcTotal) : []),
  ];

  return (
    <div
      ref={rowRef}
      className={`tl-track audio ${selected ? "selected" : ""}`}
      style={{ position: "relative" }}
      onClick={onSelect}
    >
      <div className={`audio-block ${info.key} ${track.muted ? "muted" : ""}`}>
        {peaks && peaks.length > 0 ? (
          <svg
            className="waveform"
            viewBox={`0 0 ${peaks.length} ${AUDIO_ROW_H}`}
            preserveAspectRatio="none"
            style={{ width: `${(outTotal / total) * 100}%` }}
          >
            <path d={buildWavePath(peaks, AUDIO_ROW_H)} fill="rgba(255,255,255,0.6)" />
          </svg>
        ) : (
          <div className="audio-silent">silence</div>
        )}
        {shades.map((pc, i) => (
          <div
            key={i}
            className="audio-trim-shade"
            style={{
              left: `${(pc.outStart / total) * 100}%`,
              width: `${((pc.outEnd - pc.outStart) / total) * 100}%`,
            }}
          />
        ))}
        <button
          className="audio-mute"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onChange({ muted: !track.muted });
            onSelect();
          }}
          title={track.muted ? "Unmute track" : "Mute track"}
        >
          {track.muted ? <Ico.audioMuted size={11} /> : <Ico.audio size={11} />}
          <span>{info.label}</span>
        </button>
        <div
          className="audio-trim-handle"
          style={{ left: `calc(${startPct}% - 4px)` }}
          onMouseDown={beginTrimDrag("start")}
          title="Trim track start"
        />
        <div
          className="audio-trim-handle"
          style={{ left: `calc(${endPct}% - 4px)` }}
          onMouseDown={beginTrimDrag("end")}
          title="Trim track end"
        />
      </div>
    </div>
  );
}

function Timeline({
  duration,
  currentTime,
  setCurrentTime,
  clips,
  srcDuration,
  selectedClipId,
  onSelectClip,
  onClipPatch,
  onMoveClip,
  onPreviewSource,
  zoom,
  setZoom,
  playing,
  audioPeaks,
  audioRows,
  onAudioTrack,
  selectedAudioKey,
  setSelectedAudioKey,
  cameraRow,
  onSelectCamera,
  onRemoveCameraKeyframe,
  zoomSegments,
  setZoomSegments,
  cursorSidecar,
  selectedZoomId,
  setSelectedZoomId,
  effectSegments,
  setEffectSegments,
  selectedEffectId,
  setSelectedEffectId,
  onHover,
}: {
  duration: number;
  currentTime: number;
  setCurrentTime: (v: number) => void;
  clips: PlacedClip[];
  srcDuration: number;
  selectedClipId: string | null;
  onSelectClip: (id: string | null) => void;
  onClipPatch: (id: string, patch: Partial<Clip>) => void;
  onMoveClip: (id: string, toIndex: number) => void;
  onPreviewSource: (t: number | null) => void;
  zoom: number;
  setZoom: (v: number) => void;
  playing: boolean;
  audioPeaks: number[] | null;
  audioRows: AudioRowInfo[];
  onAudioTrack: (key: AudioTrackKey, patch: Partial<AudioTrackState>) => void;
  selectedAudioKey: AudioTrackKey | null;
  setSelectedAudioKey: (key: AudioTrackKey | null) => void;
  cameraRow: {
    offset: number;
    duration: number;
    keyframes: CameraKeyframe[];
    enabled: boolean;
  } | null;
  onSelectCamera: () => void;
  onRemoveCameraKeyframe: (t: number) => void;
  zoomSegments: ZoomSegment[];
  setZoomSegments: (next: ZoomSegment[]) => void;
  cursorSidecar: CursorSidecar | null;
  selectedZoomId: string | null;
  onHover?: (t: number | null) => void;
  setSelectedZoomId: (id: string | null) => void;
  effectSegments: EffectSegment[];
  setEffectSegments: (next: EffectSegment[]) => void;
  selectedEffectId: string | null;
  setSelectedEffectId: (id: string | null) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const [hoverT, setHoverT] = useState<number | null>(null);
  // Trim drags freeze the time scale so the timeline doesn't rescale under the cursor.
  const [frozenTotal, setFrozenTotal] = useState<number | null>(null);

  const TOTAL = Math.max(frozenTotal ?? duration, 0.0001);
  const pctOf = (t: number) => (t / TOTAL) * 100;

  // Layout insets — the timeline carves out a sticky left "gutter" column for
  // the per-track icons. The time axis starts after the gutter and ends before
  // the right padding. Keep these in sync with the CSS for .tl-gutter / .tl-tracks-inner.
  const GUTTER_PAD = 16;   // margin-left on .tl-gutter
  const GUTTER_W = 32;     // width of .tl-gutter
  const GUTTER_GAP = 8;    // .tl-tracks flex gap
  const RIGHT_PAD = 16;    // .tl-tracks-inner padding-right
  const LEFT_INSET = GUTTER_PAD + GUTTER_W + GUTTER_GAP;  // 56
  const INSET_TOTAL = LEFT_INSET + RIGHT_PAD;             // 72

  // zoom 0..100 -> scale 1..4 (1x fits the container, 4x is max zoom-in)
  const scale = 1 + (zoom / 100) * 3;

  // Pick a sensible tick step based on duration so we never render hundreds
  // of overlapping ticks for long recordings.
  const tickStep = useMemo(() => {
    const target = 16; // aim for ~16 labels visible at 1x
    const raw = TOTAL / target;
    const candidates = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    return candidates.find((c) => c >= raw) ?? Math.ceil(raw / 60) * 60;
  }, [TOTAL]);

  const ticks = useMemo(() => {
    const out: number[] = [];
    for (let s = 0; s <= TOTAL + 1e-6; s += tickStep) out.push(Number(s.toFixed(3)));
    return out;
  }, [TOTAL, tickStep]);

  const fmt = (s: number) => {
    const m = Math.floor(s / 60);
    const ss = Math.floor(s % 60);
    return `${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  };

  const setFromX = (clientX: number) => {
    if (!ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const x = clientX - r.left - LEFT_INSET;
    const effW = Math.max(1, r.width - INSET_TOTAL);
    const t = (x / effW) * TOTAL;
    setCurrentTime(Math.max(0, Math.min(TOTAL, t)));
  };

  const beginDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    setSelectedZoomId(null);
    setSelectedEffectId(null);
    if (hoverT !== null) {
      setHoverT(null);
      onHover?.(null);
    }
    setFromX(e.clientX);
    const move = (ev: MouseEvent) => setFromX(ev.clientX);
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const handleHoverMove = (e: React.MouseEvent) => {
    if (e.buttons !== 0) {
      if (hoverT !== null) {
        setHoverT(null);
        onHover?.(null);
      }
      return;
    }
    const tr = ref.current;
    if (!tr) return;
    const r = tr.getBoundingClientRect();
    const x = e.clientX - r.left - LEFT_INSET;
    const effW = Math.max(1, r.width - INSET_TOTAL);
    if (x < 0 || x > effW) {
      if (hoverT !== null) {
        setHoverT(null);
        onHover?.(null);
      }
      return;
    }
    const t = Math.max(0, Math.min(TOTAL, (x / effW) * TOTAL));
    setHoverT(t);
    onHover?.(t);
  };

  const handleHoverLeave = () => {
    if (hoverT !== null) {
      setHoverT(null);
      onHover?.(null);
    }
  };

  // Zoom/effect segments live in source time; show them where their source
  // range lands in the edited sequence and map chip edits back to source.
  const srcSpanFromOut = (o: number, lenSec: number) => {
    const c = clips[clipIndexAtOut(clips, o)];
    if (!c) return null;
    return {
      startMs: outToSrc(c, o) * 1000,
      endMs: outToSrc(c, Math.min(o + lenSec, c.outEnd)) * 1000,
    };
  };

  const clipTrackRef = useRef<HTMLDivElement | null>(null);
  const [clipDrag, setClipDrag] = useState<{ id: string; dx: number; target: number } | null>(null);
  const beginClipDrag = (c: PlacedClip, mode: "move" | "start" | "end") => (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    onSelectClip(c.id);
    const track = clipTrackRef.current;
    if (!track) return;
    const r = track.getBoundingClientRect();
    const total = TOTAL;
    const secPerPx = total / Math.max(1, r.width);
    const x0 = e.clientX;
    const others = clips.filter((k) => k.id !== c.id);
    const targetAt = (clientX: number) => {
      const o = ((clientX - r.left) / r.width) * total;
      return others.filter((k) => (k.outStart + k.outEnd) / 2 < o).length;
    };
    let moved = false;
    if (mode !== "move") setFrozenTotal(total);
    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - x0;
      if (mode === "move") {
        if (!moved && Math.abs(dx) < 4) return;
        moved = true;
        setClipDrag({ id: c.id, dx, target: targetAt(ev.clientX) });
        return;
      }
      const d = dx * secPerPx * c.speed;
      const t =
        mode === "start"
          ? Math.max(0, Math.min(c.srcEnd - MIN_CLIP_SEC, c.srcStart + d))
          : Math.min(srcDuration, Math.max(c.srcStart + MIN_CLIP_SEC, c.srcEnd + d));
      onClipPatch(c.id, mode === "start" ? { srcStart: t } : { srcEnd: t });
      onPreviewSource(t);
    };
    const up = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (mode === "move") {
        setClipDrag(null);
        if (moved) {
          const to = targetAt(ev.clientX);
          if (to !== clips.findIndex((k) => k.id === c.id)) onMoveClip(c.id, to);
        } else {
          setCurrentTime(Math.max(0, Math.min(duration, ((ev.clientX - r.left) / r.width) * total)));
        }
      } else {
        setFrozenTotal(null);
        onPreviewSource(null);
      }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  const insertAt =
    clipDrag === null
      ? null
      : (() => {
          const others = clips.filter((k) => k.id !== clipDrag.id);
          return clipDrag.target === 0 ? 0 : others[clipDrag.target - 1].outEnd;
        })();

  // Manual zoom authoring: hovering the zoom track shows a ghost 1s block
  // with a "+"; clicking it commits a real manual segment from that point.
  const zoomTrackRef = useRef<HTMLDivElement | null>(null);
  const [zoomGhostT, setZoomGhostT] = useState<number | null>(null);
  const MANUAL_ZOOM_SEC = 1;

  const zoomGhostFromX = (clientX: number): number | null => {
    const el = zoomTrackRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return null;
    return Math.max(0, Math.min(TOTAL, ((clientX - r.left) / r.width) * TOTAL));
  };

  const handleZoomTrackMove = (e: React.MouseEvent) => {
    // Don't preview while dragging, or when the pointer is over an existing
    // chip (its own drag/resize affordances take over there).
    if (e.buttons !== 0 || (e.target as HTMLElement).closest(".zoom-chip")) {
      if (zoomGhostT !== null) setZoomGhostT(null);
      return;
    }
    const t = zoomGhostFromX(e.clientX);
    setZoomGhostT(t);
  };

  const handleZoomTrackLeave = () => {
    if (zoomGhostT !== null) setZoomGhostT(null);
  };

  const addManualZoomAt = (e: React.MouseEvent) => {
    // Override the track's seek-on-mousedown; chips stopPropagation so this
    // only fires on empty zoom-track space.
    e.stopPropagation();
    if (e.button !== 0) return;
    const t = zoomGhostFromX(e.clientX);
    if (t === null) return;
    const span = srcSpanFromOut(t, MANUAL_ZOOM_SEC);
    if (!span || span.endMs - span.startMs < 1) return;
    const { startMs, endMs } = span;
    const seg: ZoomSegment = {
      id: `seg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      startMs,
      endMs,
      targetLevel: DEFAULT_AUTO_ZOOM_OPTIONS.defaultLevel,
      focal: { x: 0.5, y: 0.5 },
      easing: "easeInOutCubic",
      source: "manual",
      mode: "manual",
      instant: false,
      disabled: false,
      snapToEdges: DEFAULT_SNAP_TO_EDGES,
    };
    setZoomSegments(
      [...zoomSegments, seg].sort((a, b) => a.startMs - b.startMs),
    );
    setSelectedZoomId(seg.id);
    setZoomGhostT(null);
  };

  // Manual effect authoring — same ghost/click-to-add interaction as the
  // zoom track, on its own row so plugin looks can be scheduled directly.
  const effectTrackRef = useRef<HTMLDivElement | null>(null);
  const [effectGhostT, setEffectGhostT] = useState<number | null>(null);

  const effectGhostFromX = (clientX: number): number | null => {
    const el = effectTrackRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return null;
    return Math.max(0, Math.min(TOTAL, ((clientX - r.left) / r.width) * TOTAL));
  };

  const handleEffectTrackMove = (e: React.MouseEvent) => {
    if (e.buttons !== 0 || (e.target as HTMLElement).closest(".effect-chip")) {
      if (effectGhostT !== null) setEffectGhostT(null);
      return;
    }
    setEffectGhostT(effectGhostFromX(e.clientX));
  };

  const handleEffectTrackLeave = () => {
    if (effectGhostT !== null) setEffectGhostT(null);
  };

  const addManualEffectAt = (e: React.MouseEvent) => {
    // Override the track's seek-on-mousedown; chips stopPropagation so this
    // only fires on empty effects-track space.
    e.stopPropagation();
    if (e.button !== 0) return;
    const t = effectGhostFromX(e.clientX);
    if (t === null) return;
    const span = srcSpanFromOut(t, DEFAULT_EFFECT_DURATION_SEC);
    if (!span || span.endMs - span.startMs < 1) return;
    const seg = newEffectSegment(span.startMs, span.endMs);
    setEffectSegments(
      [...effectSegments, seg].sort((a, b) => a.startMs - b.startMs),
    );
    setSelectedEffectId(seg.id);
    setEffectGhostT(null);
  };

  // Keep playhead in view while playing when zoomed in.
  useEffect(() => {
    if (!playing || scale <= 1.01) return;
    const sc = scrollRef.current;
    const tr = ref.current;
    if (!sc || !tr) return;
    const effW = Math.max(1, tr.scrollWidth - INSET_TOTAL);
    const px = LEFT_INSET + (currentTime / TOTAL) * effW;
    const left = sc.scrollLeft;
    const right = left + sc.clientWidth;
    if (px < left + 40 || px > right - 40) {
      sc.scrollTo({ left: Math.max(0, px - sc.clientWidth / 2), behavior: "smooth" });
    }
  }, [currentTime, playing, scale, TOTAL, LEFT_INSET, INSET_TOTAL]);

  // Whole-second grid lines drawn behind tracks. Cap render count for very
  // long recordings so we don't paint thousands of divs.
  const secondLines = useMemo(() => {
    const n = Math.floor(TOTAL);
    if (n <= 0) return [] as number[];
    const max = 2000;
    const step = Math.max(1, Math.ceil((n + 1) / max));
    const out: number[] = [];
    for (let s = 0; s <= n; s += step) out.push(s);
    return out;
  }, [TOTAL]);

  // Trackpad pinch + cmd/ctrl-wheel zoom, anchored to the cursor.
  // React's onWheel is passive in React 19, so preventDefault is a no-op there
  // — attach the native listener with { passive: false } instead.
  useEffect(() => {
    const sc = scrollRef.current;
    const tr = ref.current;
    if (!sc || !tr) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const clientX = e.clientX;
      const trRect = tr.getBoundingClientRect();
      const scRect = sc.getBoundingClientRect();
      const oldEffW = Math.max(1, tr.scrollWidth - INSET_TOTAL);
      const oldXInContent = clientX - trRect.left;
      const tAtMouse = Math.max(
        0,
        Math.min(TOTAL, ((oldXInContent - LEFT_INSET) / oldEffW) * TOTAL),
      );
      const delta = -e.deltaY * 0.25;
      const newZoom = Math.max(0, Math.min(100, zoom + delta));
      if (newZoom === zoom) return;
      setZoom(newZoom);
      const newScale = 1 + (newZoom / 100) * 3;
      requestAnimationFrame(() => {
        const newTrW = sc.clientWidth * newScale;
        const newEffW = Math.max(1, newTrW - INSET_TOTAL);
        const newXInContent = LEFT_INSET + (tAtMouse / TOTAL) * newEffW;
        sc.scrollLeft = Math.max(0, newXInContent - (clientX - scRect.left));
      });
    };
    sc.addEventListener("wheel", onWheel, { passive: false });
    return () => sc.removeEventListener("wheel", onWheel);
  }, [zoom, setZoom, TOTAL, LEFT_INSET, INSET_TOTAL]);

  return (
    <div
      className="timeline"
      ref={scrollRef}
      onMouseMove={handleHoverMove}
      onMouseLeave={handleHoverLeave}
      style={{ overflowX: "auto", overflowY: "hidden" }}
    >
      <div
        className="tl-ruler"
        onMouseDown={beginDrag}
        style={{
          cursor: "ew-resize",
          userSelect: "none",
          width: `${scale * 100}%`,
        }}
      >
        {ticks.map((s) => (
          <div
            key={s}
            className="tick"
            style={{
              left: `calc(${LEFT_INSET}px + ${(s / TOTAL) * 100}% - ${(s / TOTAL) * INSET_TOTAL}px)`,
            }}
          >
            {s >= 60 ? fmt(s) : `${Number.isInteger(s) ? s : s.toFixed(1)}s`}
          </div>
        ))}
      </div>

      <div
        className="tl-tracks"
        ref={ref}
        onMouseDown={beginDrag}
        style={{
          userSelect: "none",
          width: `${scale * 100}%`,
        }}
      >
        <div className="tl-gutter" aria-hidden="true">
          <div className="tl-gutter-row clip">
            <Ico.film size={12} />
          </div>
          {cameraRow && (
            <div className="tl-gutter-row camera">
              <Ico.webcam size={12} />
            </div>
          )}
          {audioRows.map((row) => (
            <div key={row.key} className="tl-gutter-row audio">
              {row.track.muted ? <Ico.audioMuted size={12} /> : <Ico.audio size={12} />}
            </div>
          ))}
          <div className="tl-gutter-row zoom">
            <Ico.zoomIn size={12} />
          </div>
          <div className="tl-gutter-row effects">
            <Ico.sparkles size={12} />
          </div>
        </div>
        <div className="tl-tracks-inner">
          {secondLines.map((s) => (
            <div
              key={`sec-${s}`}
              className="tl-second-line"
              style={{ left: `${(s / TOTAL) * 100}%` }}
            />
          ))}
        <div className="tl-track clips" ref={clipTrackRef} style={{ position: "relative" }}>
          {clips.map((c, i) => {
            const dragging = clipDrag?.id === c.id;
            const len = c.outEnd - c.outStart;
            const peaks =
              audioPeaks && audioPeaks.length > 0
                ? audioPeaks.slice(
                    Math.floor((c.srcStart / srcDuration) * audioPeaks.length),
                    Math.max(
                      Math.floor((c.srcStart / srcDuration) * audioPeaks.length) + 1,
                      Math.ceil((c.srcEnd / srcDuration) * audioPeaks.length),
                    ),
                  )
                : null;
            return (
              <div
                key={c.id}
                className={`clip-block ${selectedClipId === c.id ? "selected" : ""} ${
                  dragging ? "dragging" : ""
                } ${c.speed !== 1 ? "sped" : ""} ${c.muted ? "muted" : ""}`}
                style={{
                  left: `${pctOf(c.outStart)}%`,
                  width: `${pctOf(len)}%`,
                  transform: dragging ? `translateX(${clipDrag.dx}px)` : undefined,
                }}
                onMouseDown={beginClipDrag(c, "move")}
                title={`Clip ${i + 1} · ${fmtSpeed(c.speed)} · drag to reorder, edges to trim`}
              >
                {peaks && peaks.length > 0 && (
                  <svg
                    className="waveform"
                    viewBox={`0 0 ${peaks.length} 56`}
                    preserveAspectRatio="none"
                    style={{ width: "100%" }}
                  >
                    <path d={buildWavePath(peaks, 56)} fill="rgba(255,255,255,0.55)" />
                  </svg>
                )}
                <div className="stack">
                  <div className="label-pill">
                    <Ico.film size={11} /> Clip {i + 1}
                  </div>
                  <div className="meta">
                    <span>{len >= 60 ? fmt(len) : `${len.toFixed(1)}s`}</span>
                    {c.speed !== 1 && (
                      <span className="clip-speed-tag">
                        <Ico.speedo size={10} /> {fmtSpeed(c.speed)}
                      </span>
                    )}
                    {c.muted && <Ico.audioMuted size={10} />}
                  </div>
                </div>
                <span
                  className="clip-handle left"
                  onMouseDown={beginClipDrag(c, "start")}
                  title="Drag to trim the clip start"
                />
                <span
                  className="clip-handle right"
                  onMouseDown={beginClipDrag(c, "end")}
                  title="Drag to trim the clip end"
                />
              </div>
            );
          })}
          {insertAt !== null && (
            <div className="clip-insert" style={{ left: `${pctOf(insertAt)}%` }} />
          )}
        </div>

        {cameraRow && (() => {
          // Camera clip span on the shared timeline (clamped). A zero
          // duration (metadata not loaded yet / bubble hidden) falls back to
          // the full remaining range so the row never vanishes.
          const start = Math.max(0, cameraRow.offset);
          const rawEnd = cameraRow.duration > 0 ? cameraRow.offset + cameraRow.duration : srcDuration;
          const pieces = srcRangePieces(clips, start, Math.max(start, rawEnd));
          return (
            <div className="tl-track camera" style={{ position: "relative" }}>
              {pieces.map((pc) => (
                <div
                  key={pc.clip.id}
                  className={`camera-track-block ${cameraRow.enabled ? "" : "off"}`}
                  style={{
                    left: `${pctOf(pc.outStart)}%`,
                    width: `${pctOf(Math.max(0.01, pc.outEnd - pc.outStart))}%`,
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectCamera();
                  }}
                  title={cameraRow.enabled ? "Camera track" : "Camera hidden"}
                >
                  <Ico.webcam size={11} />
                  <span>Camera</span>
                </div>
              ))}
              {cameraRow.keyframes.flatMap((kf) =>
                clips
                  .filter((c) => kf.t >= c.srcStart && kf.t <= c.srcEnd)
                  .map((c) => (
                    <div
                      key={`${kf.t}-${c.id}`}
                      className="camera-kf"
                      style={{ left: `${pctOf(srcToOut(c, kf.t))}%` }}
                      title="Position keyframe — click to jump, ⌥-click to delete"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (e.altKey) {
                          onRemoveCameraKeyframe(kf.t);
                        } else {
                          setCurrentTime(srcToOut(c, kf.t));
                          onSelectCamera();
                        }
                      }}
                    />
                  )),
              )}
            </div>
          );
        })()}

        {audioRows.map((row) => (
          <AudioTrackRow
            key={row.key}
            info={row}
            total={TOTAL}
            clips={clips}
            srcTotal={srcDuration}
            selected={selectedAudioKey === row.key}
            onSelect={() => setSelectedAudioKey(row.key)}
            onChange={(patch) => onAudioTrack(row.key, patch)}
          />
        ))}

        <div
          className="tl-track zoom"
          style={{ position: "relative" }}
          ref={zoomTrackRef}
          onMouseMove={handleZoomTrackMove}
          onMouseLeave={handleZoomTrackLeave}
          onMouseDown={addManualZoomAt}
        >
          {!cursorSidecar && zoomSegments.length === 0 && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 10,
                color: "var(--text-3)",
                pointerEvents: "none",
              }}
            >
              Record clicks to enable auto-zoom
            </div>
          )}
          {zoomGhostT !== null && (
            <div
              className="zoom-ghost"
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: `${(zoomGhostT / TOTAL) * 100}%`,
                width: `${(Math.min(MANUAL_ZOOM_SEC, TOTAL - zoomGhostT) / TOTAL) * 100}%`,
                pointerEvents: "none",
              }}
            >
              <Ico.plus size={12} />
            </div>
          )}
          {zoomSegments.flatMap((seg) =>
            srcRangePieces(clips, seg.startMs / 1000, seg.endMs / 1000).map((pc) => {
            const totalMs = TOTAL * 1000;
            return (
              <ZoomChip
                key={`${seg.id}-${pc.clip.id}`}
                seg={{ ...seg, startMs: pc.outStart * 1000, endMs: pc.outEnd * 1000 }}
                leftPct={pctOf(pc.outStart)}
                widthPct={pctOf(pc.outEnd - pc.outStart)}
                totalMs={totalMs}
                selected={selectedZoomId === seg.id}
                onSelect={() => {
                  setSelectedZoomId(seg.id);
                  setSelectedEffectId(null);
                }}
                onUpdate={(patch) =>
                  setZoomSegments(
                    zoomSegments.map((s) =>
                      s.id === seg.id ? { ...s, ...mapSegmentPiecePatch(pc.clip, seg, pc.outStart * 1000, patch, srcDuration * 1000) } : s,
                    ),
                  )
                }
                onDelete={() => {
                  setZoomSegments(zoomSegments.filter((s) => s.id !== seg.id));
                  if (selectedZoomId === seg.id) setSelectedZoomId(null);
                }}
              />
            );
          }))}
        </div>

        <div
          className="tl-track effects"
          style={{ position: "relative" }}
          ref={effectTrackRef}
          onMouseMove={handleEffectTrackMove}
          onMouseLeave={handleEffectTrackLeave}
          onMouseDown={addManualEffectAt}
        >
          {effectSegments.length === 0 && effectGhostT === null && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 10,
                color: "var(--text-3)",
                pointerEvents: "none",
              }}
            >
              Click to add a plugin effect
            </div>
          )}
          {effectGhostT !== null && (
            <div
              className="effect-ghost"
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: `${(effectGhostT / TOTAL) * 100}%`,
                width: `${(Math.min(DEFAULT_EFFECT_DURATION_SEC, TOTAL - effectGhostT) / TOTAL) * 100}%`,
                pointerEvents: "none",
              }}
            >
              <Ico.plus size={12} />
            </div>
          )}
          {effectSegments.flatMap((seg) =>
            srcRangePieces(clips, seg.startMs / 1000, seg.endMs / 1000).map((pc) => {
            const totalMs = TOTAL * 1000;
            return (
              <EffectChip
                key={`${seg.id}-${pc.clip.id}`}
                seg={{ ...seg, startMs: pc.outStart * 1000, endMs: pc.outEnd * 1000 }}
                leftPct={pctOf(pc.outStart)}
                widthPct={pctOf(pc.outEnd - pc.outStart)}
                totalMs={totalMs}
                selected={selectedEffectId === seg.id}
                onSelect={() => {
                  setSelectedEffectId(seg.id);
                  setSelectedZoomId(null);
                }}
                onUpdate={(patch) =>
                  setEffectSegments(
                    effectSegments.map((s) =>
                      s.id === seg.id ? { ...s, ...mapSegmentPiecePatch(pc.clip, seg, pc.outStart * 1000, patch, srcDuration * 1000) } : s,
                    ),
                  )
                }
                onDelete={() => {
                  setEffectSegments(effectSegments.filter((s) => s.id !== seg.id));
                  if (selectedEffectId === seg.id) setSelectedEffectId(null);
                }}
              />
            );
          }))}
        </div>

          {hoverT !== null && (
            <div className="tl-hover" style={{ left: `${pctOf(hoverT)}%` }} />
          )}
          <div
            className="playhead"
            style={{ left: `${pctOf(currentTime)}%` }}
          />
        </div>
      </div>
    </div>
  );
}

const MIN_CROP = 0.08;
const FULL_CROP: CropRect = { x: 0, y: 0, w: 1, h: 1 };

function isFullFrame(c: CropRect) {
  return c.x <= 0.001 && c.y <= 0.001 && c.w >= 0.999 && c.h >= 0.999;
}

type CropDragMode = "move" | "nw" | "ne" | "sw" | "se";

function CropDialog({
  videoSrc,
  previewTime,
  videoNaturalSize,
  initialCrop,
  onClose,
  onApply,
}: {
  videoSrc: string;
  previewTime: number;
  videoNaturalSize: { w: number; h: number } | null;
  initialCrop: CropRect | null;
  onClose: () => void;
  onApply: (rect: CropRect | null) => void;
}) {
  const [crop, setCrop] = useState<CropRect>(initialCrop ?? FULL_CROP);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const drag = useRef<{
    mode: CropDragMode;
    startX: number;
    startY: number;
    rect: CropRect;
    stage: DOMRect;
  } | null>(null);

  const videoAR =
    videoNaturalSize && videoNaturalSize.h > 0
      ? videoNaturalSize.w / videoNaturalSize.h
      : 16 / 9;

  // Seek the preview frame to wherever the editor playhead is.
  useEffect(() => {
    const v = videoElRef.current;
    if (!v) return;
    const seek = () => {
      try {
        v.currentTime = previewTime;
      } catch {
        /* metadata not ready yet — loadedmetadata handler retries */
      }
    };
    if (v.readyState >= 1) seek();
    v.addEventListener("loadedmetadata", seek);
    return () => v.removeEventListener("loadedmetadata", seek);
  }, [previewTime]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = (e.clientX - d.startX) / d.stage.width;
      const dy = (e.clientY - d.startY) / d.stage.height;
      const r = d.rect;
      let { x, y, w, h } = r;
      if (d.mode === "move") {
        x = Math.max(0, Math.min(1 - r.w, r.x + dx));
        y = Math.max(0, Math.min(1 - r.h, r.y + dy));
      } else {
        const right = r.x + r.w;
        const bottom = r.y + r.h;
        if (d.mode === "nw" || d.mode === "sw") {
          x = Math.max(0, Math.min(right - MIN_CROP, r.x + dx));
          w = right - x;
        }
        if (d.mode === "ne" || d.mode === "se") {
          w = Math.max(MIN_CROP, Math.min(1 - r.x, r.w + dx));
        }
        if (d.mode === "nw" || d.mode === "ne") {
          y = Math.max(0, Math.min(bottom - MIN_CROP, r.y + dy));
          h = bottom - y;
        }
        if (d.mode === "sw" || d.mode === "se") {
          h = Math.max(MIN_CROP, Math.min(1 - r.y, r.h + dy));
        }
      }
      setCrop({ x, y, w, h });
    };
    const up = () => {
      drag.current = null;
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, []);

  const startDrag = (mode: CropDragMode) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!stageRef.current) return;
    drag.current = {
      mode,
      startX: e.clientX,
      startY: e.clientY,
      rect: crop,
      stage: stageRef.current.getBoundingClientRect(),
    };
  };

  const round = (n: number) => Math.round(n * 1e4) / 1e4;
  const apply = () => {
    const c = {
      x: round(crop.x),
      y: round(crop.y),
      w: round(crop.w),
      h: round(crop.h),
    };
    onApply(isFullFrame(c) ? null : c);
  };

  const handles: CropDragMode[] = ["nw", "ne", "sw", "se"];

  return (
    <div className="crop-modal-backdrop" onMouseDown={onClose}>
      <div className="crop-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="crop-modal-head">
          <span>
            <Ico.crop size={15} /> Crop recording
          </span>
          <button className="tb-icon-btn" title="Close" onClick={onClose}>
            <Ico.xMark size={16} />
          </button>
        </div>
        <div className="crop-modal-stage-wrap">
          <div
            className="crop-stage"
            ref={stageRef}
            style={{ aspectRatio: `${videoAR}` }}
          >
            <video
              ref={videoElRef}
              src={videoSrc}
              muted
              playsInline
              preload="metadata"
              className="crop-stage-video"
            />
            <div
              className="crop-box"
              onMouseDown={startDrag("move")}
              style={{
                left: `${crop.x * 100}%`,
                top: `${crop.y * 100}%`,
                width: `${crop.w * 100}%`,
                height: `${crop.h * 100}%`,
              }}
            >
              <div className="crop-thirds" />
              {handles.map((hd) => (
                <span
                  key={hd}
                  className={`crop-handle crop-handle-${hd}`}
                  onMouseDown={startDrag(hd)}
                />
              ))}
            </div>
          </div>
        </div>
        <div className="crop-modal-foot">
          <button className="crop-reset" onClick={() => setCrop(FULL_CROP)}>
            Reset
          </button>
          <div className="crop-foot-right">
            <button className="crop-cancel" onClick={onClose}>
              Cancel
            </button>
            <button className="crop-apply export-btn" onClick={apply}>
              Apply
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function Editor({
  themeMode,
  setThemeMode,
}: {
  themeMode: ThemeMode;
  setThemeMode: (next: ThemeMode) => void;
}) {
  const [state, setState] = useState<EditorState>({
    aspect: "system",
    bgTab: "Wallpaper",
    wallpaper: "wp-7",
    blur: 0,
    padding: 56,
    cropRect: null,
    zoom: 0,
    clips: [],
    audioTracks: defaultAudioTracks(),
    camera: defaultCameraState(),
  });
  const set = (patch: StatePatch) => setState((s) => ({ ...s, ...patch }));
  const setAudioTrack = (key: AudioTrackKey, patch: Partial<AudioTrackState>) =>
    setState((s) => ({
      ...s,
      audioTracks: {
        ...s.audioTracks,
        [key]: { ...s.audioTracks[key], ...patch },
      },
    }));

  const [activeRail, setActiveRail] = useState("background");
  const [artifact, setArtifact] = useState<CaptureArtifact | null>(null);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const [videoNaturalSize, setVideoNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [audioPeaks, setAudioPeaks] = useState<number[] | null>(null);
  const [systemPeaks, setSystemPeaks] = useState<number[] | null>(null);
  const [micPeaks, setMicPeaks] = useState<number[] | null>(null);
  const [selectedAudioKey, setSelectedAudioKey] = useState<AudioTrackKey | null>(null);
  const [cursorSidecar, setCursorSidecar] = useState<CursorSidecar | null>(null);
  const [zoomSettings, setZoomSettingsRaw] = useState<ZoomSettings>(DEFAULT_ZOOM_SETTINGS);
  const setZoomSettings = (patch: Partial<ZoomSettings>) =>
    setZoomSettingsRaw((s) => ({ ...s, ...patch }));
  const [zoomSegments, setZoomSegments] = useState<ZoomSegment[]>([]);
  const [selectedZoomId, setSelectedZoomId] = useState<string | null>(null);
  const selectedSeg = useMemo(
    () => zoomSegments.find((s) => s.id === selectedZoomId) ?? null,
    [zoomSegments, selectedZoomId],
  );
  const [effectSegments, setEffectSegments] = useState<EffectSegment[]>([]);
  const [selectedEffectId, setSelectedEffectId] = useState<string | null>(null);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const selectedEffectSeg = useMemo(
    () => findEffectSegment(effectSegments, selectedEffectId),
    [effectSegments, selectedEffectId],
  );
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // ---- Undo / redo -----------------------------------------------------
  // History covers the user-editable surface: canvas settings (`state`),
  // zoom segments, and effect segments. Rapid changes (slider/timeline
  // drags) are coalesced — a snapshot is committed only once edits settle,
  // so one drag is one undo step. Programmatic resets (project load, fresh
  // recording, the wallpaper default) rebase the baseline instead of adding
  // a step.
  type EditSnapshot = {
    state: EditorState;
    zoomSegments: ZoomSegment[];
    effectSegments: EffectSegment[];
  };
  const histRef = useRef<{
    past: EditSnapshot[];
    present: EditSnapshot;
    future: EditSnapshot[];
  }>({ past: [], present: { state, zoomSegments, effectSegments }, future: [] });
  const histApplyingRef = useRef(false);
  const histRebaseRef = useRef(false);
  const [, setHistTick] = useState(0);
  const bumpHist = () => setHistTick((n) => n + 1);

  useEffect(() => {
    if (histApplyingRef.current) {
      histApplyingRef.current = false;
      return;
    }
    const t = setTimeout(() => {
      const h = histRef.current;
      const cur: EditSnapshot = { state, zoomSegments, effectSegments };
      if (histRebaseRef.current) {
        histRebaseRef.current = false;
        h.past = [];
        h.future = [];
        h.present = cur;
        bumpHist();
        return;
      }
      if (JSON.stringify(cur) === JSON.stringify(h.present)) return;
      h.past.push(h.present);
      h.present = cur;
      h.future = [];
      bumpHist();
    }, 350);
    return () => clearTimeout(t);
  }, [state, zoomSegments, effectSegments]);

  const liveSnapRef = useRef<EditSnapshot>({ state, zoomSegments, effectSegments });
  liveSnapRef.current = { state, zoomSegments, effectSegments };

  const applySnapshot = (snap: EditSnapshot) => {
    histApplyingRef.current = true;
    setState(snap.state);
    setZoomSegments(snap.zoomSegments);
    setEffectSegments(snap.effectSegments);
  };
  // Commit any edit still inside the 350ms coalesce window so a quick
  // undo/redo doesn't silently discard it.
  const flushPending = () => {
    const h = histRef.current;
    const live = liveSnapRef.current;
    if (JSON.stringify(live) === JSON.stringify(h.present)) return;
    h.past.push(h.present);
    h.present = live;
    h.future = [];
  };
  const undo = useCallback(() => {
    flushPending();
    const h = histRef.current;
    if (h.past.length === 0) return;
    h.future.unshift(h.present);
    h.present = h.past.pop()!;
    applySnapshot(h.present);
    bumpHist();
  }, []);
  const redo = useCallback(() => {
    flushPending();
    const h = histRef.current;
    if (h.future.length === 0) return;
    h.past.push(h.present);
    h.present = h.future.shift()!;
    applySnapshot(h.present);
    bumpHist();
  }, []);
  const canUndo = histRef.current.past.length > 0;
  const canRedo = histRef.current.future.length > 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  // Esc clears the active zoom/effect selection — surfaces the icon-rail
  // tab again. Delete/Backspace removes the selected block (unless the
  // user is typing in a field, where those keys mean "edit text").
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelectedZoomId(null);
        setSelectedEffectId(null);
        setSelectedClipId(null);
        return;
      }
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (!selectedZoomId && !selectedEffectId && !selectedClipId) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      if (selectedZoomId) {
        setZoomSegments(zoomSegments.filter((s) => s.id !== selectedZoomId));
        setSelectedZoomId(null);
      }
      if (selectedEffectId) {
        setEffectSegments(effectSegments.filter((s) => s.id !== selectedEffectId));
        setSelectedEffectId(null);
      }
      if (selectedClipId && !selectedZoomId && !selectedEffectId) {
        deleteClipRef.current(selectedClipId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedZoomId, zoomSegments, setZoomSegments, selectedEffectId, effectSegments, setEffectSegments, selectedClipId]);

  // When a segment is selected, highlight the matching rail icon.
  useEffect(() => {
    if (!selectedZoomId) return;
    setActiveRail("cursor");
    setSelectedClipId(null);
  }, [selectedZoomId]);
  useEffect(() => {
    if (!selectedEffectId) return;
    setActiveRail("effects");
    setSelectedClipId(null);
  }, [selectedEffectId]);

  // Default the canvas background to the user's current macOS desktop
  // wallpaper. Match it onto a bundled high-res entry (the raw detected
  // path may be a dynamic wallpaper or outside the asset scope); fall back
  // to the first bundled wallpaper if it can't be detected or matched.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const wallpapers = await native.listMacWallpapers().catch(() => []);
      if (cancelled || wallpapers.length === 0) return;
      const stem = (p: string) =>
        (p.split(/[\\/]/).pop() ?? p).replace(/\.[^.]+$/, "").toLowerCase();
      const current = await native.currentMacWallpaper().catch(() => null);
      const match =
        (current &&
          (wallpapers.find((w) => w.full === current) ??
            wallpapers.find((w) => stem(w.full) === stem(current)))) ||
        wallpapers[0];
      if (cancelled) return;
      setState((s) => {
        if (s.wallpaper !== "wp-7") return s;
        histRebaseRef.current = true;
        return { ...s, wallpaper: match.full };
      });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const [projectName, setProjectName] = useState(() => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}-${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
    return `OpenScreenStudio-${stamp}.openscreen`;
  });

  useEffect(() => {
    document.title = projectName;
  }, [projectName]);

  const assetVideoSrc = useMemo(
    () => (artifact ? convertFileSrc(artifact.path) : SAMPLE_VIDEO),
    [artifact],
  );
  // blob: upgrade enables the WebGL preview (same-origin video textures).
  const videoSrc = useSameOriginSrc(assetVideoSrc) ?? assetVideoSrc;
  const systemAudioSrc = useMemo(
    () => (artifact?.systemAudioPath ? convertFileSrc(artifact.systemAudioPath) : null),
    [artifact],
  );
  const micAudioSrc = useMemo(
    () => (artifact?.micPath ? convertFileSrc(artifact.micPath) : null),
    [artifact],
  );
  const hasSidecarAudio = systemAudioSrc !== null || micAudioSrc !== null;
  // Decoded sidecar audio, used both for waveforms and Web Audio playback.
  const [systemBuf, setSystemBuf] = useState<AudioBuffer | null>(null);
  const [micBuf, setMicBuf] = useState<AudioBuffer | null>(null);
  const cameraSrc = useMemo(
    () => (artifact?.cameraPath ? convertFileSrc(artifact.cameraPath) : null),
    [artifact],
  );
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const [cameraDuration, setCameraDuration] = useState(0);

  // The demo timeline is 12s; once a real recording is loaded use its duration.
  const DEMO_DURATION = 12;
  // `srcDuration` is the raw recording; `duration` is the edited output.
  const srcDuration = videoDuration ?? DEMO_DURATION;
  const effClips = useMemo(
    () => (state.clips.length > 0 ? state.clips : [fullClip(srcDuration)]),
    [state.clips, srcDuration],
  );
  const placed = useMemo(() => layoutClips(effClips), [effClips]);
  const duration = outDuration(placed);
  const placedRef = useRef(placed);
  placedRef.current = placed;
  const playIdxRef = useRef(0);
  const pendingLegacyTrimRef = useRef<{ trimStart: number; trimEnd: number } | null>(null);
  const [currentTime, setCurrentTime] = useState(2.4);
  const srcAtOut = (o: number) => {
    const pl = placedRef.current;
    const c = pl[clipIndexAtOut(pl, o)];
    return c ? outToSrc(c, o) : 0;
  };
  const srcTime = useMemo(() => {
    const c = placed[clipIndexAtOut(placed, currentTime)];
    return c ? outToSrc(c, currentTime) : 0;
  }, [placed, currentTime]);
  const srcTimeRef = useRef(srcTime);
  srcTimeRef.current = srcTime;
  const [playing, setPlaying] = useState(false);
  const [cropOpen, setCropOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [perfOpen, setPerfOpen] = useState(false);
  const [previewFocus, setPreviewFocus] = useState(false);

  // Resizable inspector / timeline. Current sizes are the minimum; the inspector
  // may grow to 40% of the window width and the timeline to 40% of its height.
  const INSPECTOR_MIN = 304;
  const TIMELINE_MIN = 220;
  const [inspectorWidth, setInspectorWidth] = useState(INSPECTOR_MIN);
  const [timelineHeight, setTimelineHeight] = useState(TIMELINE_MIN);
  const [resizing, setResizing] = useState(false);

  const startInspectorResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = inspectorWidth;
    const maxW = window.innerWidth * 0.4;
    const onMove = (ev: PointerEvent) => {
      // Dragging the left edge: moving left widens the panel.
      const next = Math.min(
        maxW,
        Math.max(INSPECTOR_MIN, startW + (startX - ev.clientX)),
      );
      setInspectorWidth(next);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setResizing(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    setResizing(true);
  };

  const startTimelineResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = timelineHeight;
    const maxH = window.innerHeight * 0.4;
    const onMove = (ev: PointerEvent) => {
      // Dragging the top edge: moving up grows the timeline.
      const next = Math.min(
        maxH,
        Math.max(TIMELINE_MIN, startH + (startY - ev.clientY)),
      );
      setTimelineHeight(next);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setResizing(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    setResizing(true);
  };
  const [perfSettings, setPerfSettings] = useState<PerformanceSettings>(
    loadPerformanceSettings,
  );

  useEffect(() => {
    try {
      localStorage.setItem(
        PERFORMANCE_SETTINGS_KEY,
        JSON.stringify(perfSettings),
      );
    } catch {
      /* localStorage unavailable — settings stay session-only */
    }
  }, [perfSettings]);

  // Listen for new recordings handed off from the HUD window.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    native.onRecordingArtifact((a) => {
      setArtifact(a);
      setCurrentTime(0);
      setPlaying(false);
      setSelectedAudioKey(null);
      // Per-track edits belong to the previous clip.
      setState((s) => ({
        ...s,
        clips: [],
        audioTracks: defaultAudioTracks(),
        camera: defaultCameraState(),
      }));
      pendingLegacyTrimRef.current = null;
      setSelectedClipId(null);
      setEffectSegments([]);
      setSelectedEffectId(null);
      // A fresh recording: derive auto-zoom from its cursor sidecar.
      (async () => {
        const sidecar = await fetchSidecar(a);
        setCursorSidecar(sidecar);
        histRebaseRef.current = true;
        setZoomSegments(
          sidecar
            ? deriveAutoZoom(sidecar, {
                defaultLevel: DEFAULT_ZOOM_SETTINGS.defaultLevel,
                leadInMs: DEFAULT_ZOOM_SETTINGS.leadInMs,
                holdMs: DEFAULT_ZOOM_SETTINGS.holdMs,
                releaseMs: DEFAULT_ZOOM_SETTINGS.releaseMs,
                mergeGapMs: DEFAULT_AUTO_ZOOM_OPTIONS.mergeGapMs,
              })
            : [],
        );
      })();
    }).then((u) => { unlisten = u; });
    return () => unlisten?.();
  }, []);

  // Pull real duration + natural size from the loaded video.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !videoSrc) return;
    const onMeta = () => {
      setVideoDuration(isFinite(v.duration) ? v.duration : null);
      const legacy = pendingLegacyTrimRef.current;
      if (legacy && isFinite(v.duration)) {
        pendingLegacyTrimRef.current = null;
        const end = Math.max(legacy.trimStart + MIN_CLIP_SEC, v.duration - legacy.trimEnd);
        histRebaseRef.current = true;
        setState((s) => ({
          ...s,
          clips: [{ ...fullClip(v.duration), srcStart: legacy.trimStart, srcEnd: end }],
        }));
      }
      if (v.videoWidth > 0 && v.videoHeight > 0) {
        setVideoNaturalSize({ w: v.videoWidth, h: v.videoHeight });
      }
    };
    v.addEventListener("loadedmetadata", onMeta);
    return () => v.removeEventListener("loadedmetadata", onMeta);
  }, [videoSrc]);

  // Decode audio into waveform peaks. With sidecar tracks present, the
  // dedicated audio rows own the waveforms and the clip block shows none
  // (the mp4's embedded audio duplicates the sidecars).
  useEffect(() => {
    if (!videoSrc || hasSidecarAudio) {
      setAudioPeaks(null);
      return;
    }
    let cancelled = false;
    void decodeAudioFromUrl(videoSrc).then((buf) => {
      if (!cancelled) setAudioPeaks(buf ? peaksFromBuffer(buf) : null);
    });
    return () => {
      cancelled = true;
    };
  }, [videoSrc, hasSidecarAudio]);

  useEffect(() => {
    if (!systemAudioSrc) {
      setSystemPeaks(null);
      setSystemBuf(null);
      return;
    }
    let cancelled = false;
    void decodeAudioFromUrl(systemAudioSrc).then((buf) => {
      if (cancelled) return;
      setSystemBuf(buf);
      setSystemPeaks(buf ? (peaksFromBuffer(buf) ?? []) : []);
    });
    return () => {
      cancelled = true;
    };
  }, [systemAudioSrc]);

  useEffect(() => {
    if (!micAudioSrc) {
      setMicPeaks(null);
      setMicBuf(null);
      return;
    }
    let cancelled = false;
    void decodeAudioFromUrl(micAudioSrc).then((buf) => {
      if (cancelled) return;
      setMicBuf(buf);
      setMicPeaks(buf ? (peaksFromBuffer(buf) ?? []) : []);
    });
    return () => {
      cancelled = true;
    };
  }, [micAudioSrc]);

  // ---- Sidecar audio playback (Web Audio) --------------------------------
  // The screen <video> is the master clock (muted — the sidecar tracks own
  // all audio). Each track plays its decoded buffer through a GainNode;
  // play/seek (re)starts an AudioBufferSourceNode at the video's time, and a
  // rAF watcher applies mute/trim/gain and restarts a source if it drifts.
  // The tracks' editable state rides a ref so the loop is subscription-free.
  // Auto-level multipliers, recomputed when a sidecar buffer decodes.
  const systemAutoGain = useMemo(
    () => (systemBuf ? autoLevelGain(systemBuf) : 1),
    [systemBuf],
  );
  const micAutoGain = useMemo(
    () => (micBuf ? autoLevelGain(micBuf) : 1),
    [micBuf],
  );

  const audioSyncRef = useRef({
    tracks: state.audioTracks,
    duration: srcDuration,
    auto: { system: 1, mic: 1 },
  });
  audioSyncRef.current = {
    tracks: state.audioTracks,
    duration: srcDuration,
    auto: { system: systemAutoGain, mic: micAutoGain },
  };

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const bufs: { key: AudioTrackKey; buf: AudioBuffer }[] = [];
    if (systemBuf) bufs.push({ key: "system", buf: systemBuf });
    if (micBuf) bufs.push({ key: "mic", buf: micBuf });
    v.muted = hasSidecarAudio;
    if (bufs.length === 0) return;

    const ctx = getAudioCtx();
    const nodes = bufs.map(({ key, buf }) => {
      const gain = ctx.createGain();
      gain.gain.value = 0; // ramped by the rAF below
      gain.connect(ctx.destination);
      return {
        key,
        buf,
        gain,
        src: null as AudioBufferSourceNode | null,
        startCtxT: 0,
        startOffset: 0,
        rate: 1,
      };
    });
    type Node = (typeof nodes)[number];

    const stopNode = (n: Node) => {
      if (!n.src) return;
      try {
        n.src.stop();
      } catch {}
      n.src.disconnect();
      n.src = null;
    };
    const clipRate = () => placedRef.current[playIdxRef.current]?.speed ?? 1;
    const startNode = (n: Node, t: number) => {
      stopNode(n);
      if (t >= n.buf.duration) return; // past the end of this track
      const src = ctx.createBufferSource();
      src.buffer = n.buf;
      n.rate = clipRate();
      src.playbackRate.value = n.rate;
      src.connect(n.gain);
      src.start(0, Math.max(0, t));
      n.src = src;
      n.startCtxT = ctx.currentTime;
      n.startOffset = Math.max(0, t);
    };
    const startAll = () => {
      void ctx.resume().catch(() => {});
      for (const n of nodes) startNode(n, v.currentTime);
    };
    const stopAll = () => {
      for (const n of nodes) stopNode(n);
    };

    const onPlay = () => startAll();
    const onPause = () => stopAll();
    const onSeeked = () => {
      if (!v.paused) startAll();
    };
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("seeked", onSeeked);
    if (!v.paused) startAll();

    let raf = 0;
    const tick = () => {
      const { tracks, duration: dur, auto } = audioSyncRef.current;
      const t = v.currentTime;
      const clip = placedRef.current[playIdxRef.current];
      const rate = clip?.speed ?? 1;
      for (const n of nodes) {
        const ts = tracks[n.key];
        const inWindow = t >= ts.trimStart - 1e-3 && t <= dur - ts.trimEnd + 1e-3;
        const boost = ts.normalize ? auto[n.key] : 1;
        n.gain.gain.value =
          ts.muted || clip?.muted || !inWindow ? 0 : Math.max(0, Math.min(1, ts.gain)) * boost;
        if (!v.paused && n.src) {
          const expected = n.startOffset + (ctx.currentTime - n.startCtxT) * n.rate;
          if (n.rate !== rate || Math.abs(expected - t) > 0.12 * Math.max(1, rate)) startNode(n, t);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("seeked", onSeeked);
      cancelAnimationFrame(raf);
      stopAll();
      for (const n of nodes) n.gain.disconnect();
      v.muted = false;
    };
  }, [videoSrc, systemBuf, micBuf, hasSidecarAudio]);

  // Slave the camera preview <video> to the master clock, shifted by the
  // recorded camera start offset.
  useEffect(() => {
    const v = videoRef.current;
    const c = cameraVideoRef.current;
    if (!v || !c || !cameraSrc) return;
    const offset = (artifact?.cameraOffsetMs ?? 0) / 1000;
    const camTime = () => Math.max(0, v.currentTime - offset);
    const syncTime = () => {
      try {
        c.currentTime = camTime();
      } catch {}
    };
    const onPlay = () => {
      syncTime();
      void c.play().catch(() => {});
    };
    const onPause = () => {
      c.pause();
      syncTime();
    };
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("seeking", syncTime);
    v.addEventListener("seeked", syncTime);
    if (!v.paused) onPlay();
    let raf = 0;
    const tick = () => {
      if (!v.paused) {
        if (c.playbackRate !== v.playbackRate) c.playbackRate = v.playbackRate;
        if (Math.abs(c.currentTime - camTime()) > 0.08 * Math.max(1, v.playbackRate)) syncTime();
        if (c.paused) void c.play().catch(() => {});
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("seeking", syncTime);
      v.removeEventListener("seeked", syncTime);
      cancelAnimationFrame(raf);
      c.pause();
    };
  }, [videoSrc, cameraSrc, artifact?.cameraOffsetMs, state.camera.enabled]);

  // Camera clip length, for the timeline's camera row.
  useEffect(() => {
    const c = cameraVideoRef.current;
    if (!c || !cameraSrc) {
      setCameraDuration(0);
      return;
    }
    const onMeta = () => setCameraDuration(isFinite(c.duration) ? c.duration : 0);
    if (c.readyState >= 1) onMeta();
    c.addEventListener("loadedmetadata", onMeta);
    return () => c.removeEventListener("loadedmetadata", onMeta);
  }, [cameraSrc, state.camera.enabled]);

  // Drive playback / scrubbing on the real <video>.
  // Starting playback positions the video on the clip under the playhead
  // (or rewinds when parked at the end); the rAF loop below walks the clips.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !videoSrc) return;
    if (!playing) {
      v.pause();
      return;
    }
    isHoveringRef.current = false;
    hoverWasPlayingRef.current = false;
    const pl = placedRef.current;
    let o = currentTimeRef.current;
    if (o >= outDuration(pl) - 0.05) {
      o = 0;
      setCurrentTime(0);
    }
    const i = clipIndexAtOut(pl, o);
    playIdxRef.current = i;
    const t = outToSrc(pl[i], o);
    if (Math.abs(v.currentTime - t) > 0.05) v.currentTime = t;
    v.playbackRate = pl[i].speed;
    v.play().catch(() => {});
  }, [playing, videoSrc]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !videoSrc) {
      // Demo mode: synthetic playhead, rAF for smoothness.
      if (!playing) return;
      let raf = 0;
      let last = performance.now();
      const tick = (now: number) => {
        const dt = (now - last) / 1000;
        last = now;
        setCurrentTime((t) => {
          const next = t + dt;
          if (next >= DEMO_DURATION) {
            setPlaying(false);
            return DEMO_DURATION;
          }
          return next;
        });
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }
    // Real video: drive playhead from rAF reading v.currentTime,
    // not from `timeupdate` (which only fires ~4×/s).
    if (!playing) {
      const onTime = () => {
        if (isHoveringRef.current) return;
        const c = placedRef.current[playIdxRef.current];
        if (!c || v.currentTime < c.srcStart - 0.05 || v.currentTime > c.srcEnd + 0.05) return;
        setCurrentTime(srcToOut(c, v.currentTime));
      };
      v.addEventListener("timeupdate", onTime);
      return () => v.removeEventListener("timeupdate", onTime);
    }
    let raf = 0;
    const tick = () => {
      if (!isHoveringRef.current) {
        const pl = placedRef.current;
        let i = Math.min(playIdxRef.current, pl.length - 1);
        let c = pl[i];
        if (v.ended || v.currentTime >= c.srcEnd - 0.02 * c.speed) {
          if (i + 1 >= pl.length) {
            setPlaying(false);
            setCurrentTime(outDuration(pl));
            return;
          }
          i += 1;
          c = pl[i];
          playIdxRef.current = i;
          // Contiguous clips (a plain split) continue without a seek hitch.
          if (Math.abs(v.currentTime - c.srcStart) > 0.06) v.currentTime = c.srcStart;
          if (v.paused) v.play().catch(() => {});
        }
        if (v.playbackRate !== c.speed) v.playbackRate = c.speed;
        setCurrentTime(srcToOut(c, v.currentTime));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, videoSrc]);

  // Scrubbing the timeline should seek the real video.
  const seek = (t: number) => {
    const pl = placedRef.current;
    const o = Math.max(0, Math.min(outDuration(pl), t));
    setCurrentTime(o);
    const i = clipIndexAtOut(pl, o);
    playIdxRef.current = i;
    const v = videoRef.current;
    if (v && videoSrc && pl[i]) {
      v.currentTime = outToSrc(pl[i], o);
      v.playbackRate = pl[i].speed;
    }
  };

  // Keyboard transport: Space = play/pause, ←/→ = step one frame.
  // Recordings capture at 30fps by default, so a frame is 1/30s.
  const seekRef = useRef(seek);
  seekRef.current = seek;
  const currentTimeRef = useRef(currentTime);
  currentTimeRef.current = currentTime;
  const durationRef = useRef(duration);
  durationRef.current = duration;
  useEffect(() => {
    const FRAME = 1 / 30;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable)
      )
        return;
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        setPlaying(false);
        seekRef.current(Math.max(0, currentTimeRef.current - FRAME));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setPlaying(false);
        seekRef.current(
          Math.min(durationRef.current, currentTimeRef.current + FRAME),
        );
      } else if (e.key.toLowerCase() === "s" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        splitRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Timeline hover preview: seek the <video> to the hovered time without
  // disturbing the playhead's `currentTime` state. The rAF / timeupdate
  // listeners above honor `isHoveringRef` so they don't pull the seeked
  // position back into React state.
  const isHoveringRef = useRef(false);
  const hoverWasPlayingRef = useRef(false);
  const handleTimelineHover = (t: number | null) => {
    const v = videoRef.current;
    if (!v || !videoSrc) return;
    if (t === null) {
      if (!isHoveringRef.current) return;
      v.currentTime = srcAtOut(currentTimeRef.current);
      if (hoverWasPlayingRef.current) v.play().catch(() => {});
      isHoveringRef.current = false;
      hoverWasPlayingRef.current = false;
      return;
    }
    if (!isHoveringRef.current) {
      hoverWasPlayingRef.current = !v.paused;
      if (!v.paused) v.pause();
      isHoveringRef.current = true;
    }
    v.currentTime = srcAtOut(t);
  };

  // Trim-handle drags preview the exact source frame at the new cut point.
  const previewSource = (t: number | null) => {
    const v = videoRef.current;
    if (!v || !videoSrc) return;
    if (t === null) {
      if (!isHoveringRef.current) return;
      isHoveringRef.current = false;
      seek(currentTimeRef.current);
      if (hoverWasPlayingRef.current) v.play().catch(() => {});
      hoverWasPlayingRef.current = false;
      return;
    }
    if (!isHoveringRef.current) {
      hoverWasPlayingRef.current = !v.paused;
      if (!v.paused) v.pause();
      isHoveringRef.current = true;
    }
    v.currentTime = t;
  };

  // ---- Clip editing ----------------------------------------------------------
  const setClips = (clips: Clip[]) => set({ clips });
  const selectClip = (id: string | null) => {
    setSelectedClipId(id);
    if (id) {
      setSelectedZoomId(null);
      setSelectedEffectId(null);
      setSelectedAudioKey(null);
    }
  };
  const splitAtPlayhead = () => {
    const r = splitAt(effClips, currentTimeRef.current);
    if (!r) return;
    setClips(r.clips);
    selectClip(r.rightId);
  };
  const deleteClip = (id: string) => {
    if (effClips.length <= 1) return;
    setClips(removeClip(effClips, id));
    setSelectedClipId(null);
  };
  const splitRef = useRef(splitAtPlayhead);
  splitRef.current = splitAtPlayhead;
  const deleteClipRef = useRef(deleteClip);
  deleteClipRef.current = deleteClip;
  const selectedClipIdx = placed.findIndex((c) => c.id === selectedClipId);
  const selectedClip = selectedClipIdx >= 0 ? placed[selectedClipIdx] : null;

  // Re-sync the video to the playhead after edits (and keep it in range).
  useEffect(() => {
    if (!isHoveringRef.current) seek(currentTimeRef.current);
  }, [placed]);

  // ---- Project save / open -------------------------------------------------

  const handleSaveProject = async () => {
    if (!artifact) {
      alert("Record or open a clip before saving a project.");
      return;
    }
    const project: ProjectFile = {
      version: PROJECT_VERSION,
      app: "OpenScreen Studio",
      artifact,
      editorState: state,
      zoomSettings,
      zoomSegments,
      effectSegments,
    };
    try {
      const savedPath = await native.saveProject(
        projectName,
        JSON.stringify(project, null, 2),
      );
      if (savedPath) setProjectName(baseName(savedPath));
    } catch (e) {
      alert(`Couldn't save project: ${e}`);
    }
  };

  const handleOpenProject = async () => {
    let res: { path: string; contents: string } | null;
    try {
      res = await native.openProject();
    } catch (e) {
      alert(`Couldn't open project: ${e}`);
      return;
    }
    if (!res) return;
    await loadProjectFile(res);
  };

  // Shared by the File-menu open dialog and Finder double-clicks.
  const loadProjectFile = async (res: { path: string; contents: string }) => {
    let project: ProjectFile;
    try {
      project = JSON.parse(res.contents) as ProjectFile;
    } catch {
      alert("That file isn't a valid OpenScreen project.");
      return;
    }
    if (!project || !project.artifact || !project.editorState) {
      alert("That file isn't a valid OpenScreen project.");
      return;
    }

    setArtifact(project.artifact);
    histRebaseRef.current = true;
    const { trimStart = 0, trimEnd = 0, splits: _splits, ...editorState } = project.editorState;
    pendingLegacyTrimRef.current =
      !editorState.clips && (trimStart > 0 || trimEnd > 0) ? { trimStart, trimEnd } : null;
    // v1 projects predate audio tracks / camera — backfill defaults. Merge
    // the camera over defaults so saves from before keyframes existed still
    // load with a valid keyframes array.
    setState((s) => ({
      ...s,
      ...editorState,
      clips: editorState.clips ?? [],
      // Merge over defaults so tracks saved before `normalize` existed load valid.
      audioTracks: {
        system: {
          ...defaultAudioTrack(),
          ...(editorState.audioTracks?.system ?? {}),
        },
        mic: { ...defaultAudioTrack(), ...(editorState.audioTracks?.mic ?? {}) },
      },
      camera: editorState.camera
        ? { ...defaultCameraState(), ...editorState.camera }
        : defaultCameraState(),
    }));
    setSelectedAudioKey(null);
    setSelectedClipId(null);
    setZoomSettingsRaw((s) => ({ ...s, ...project.zoomSettings }));
    setZoomSegments(project.zoomSegments ?? []);
    setSelectedZoomId(null);
    setEffectSegments(project.effectSegments ?? []);
    setSelectedEffectId(null);
    setCurrentTime(0);
    setPlaying(false);
    setProjectName(baseName(res.path));
    setCursorSidecar(await fetchSidecar(project.artifact));

    // Editor and HUD are mutually exclusive — opening a project (e.g. from
    // the HUD's File menu) brings the editor forward and hides the HUD.
    try {
      await native.presentEditor();
    } catch (e) {
      console.error("presentEditor failed", e);
    }
  };

  const audioRows = useMemo<AudioRowInfo[]>(() => {
    const rows: AudioRowInfo[] = [];
    if (systemAudioSrc) {
      rows.push({ key: "system", label: "System audio", peaks: systemPeaks, track: state.audioTracks.system, autoGain: systemAutoGain });
    }
    if (micAudioSrc) {
      rows.push({ key: "mic", label: "Microphone", peaks: micPeaks, track: state.audioTracks.mic, autoGain: micAutoGain });
    }
    return rows;
  }, [systemAudioSrc, micAudioSrc, systemPeaks, micPeaks, state.audioTracks, systemAutoGain, micAutoGain]);

  const selectAudioTrack = (key: AudioTrackKey | null) => {
    setSelectedAudioKey(key);
    if (key) {
      setActiveRail("audio");
      setSelectedZoomId(null);
      setSelectedClipId(null);
    }
  };

  // ---- Camera keyframes ---------------------------------------------------
  // The bubble's effective transform at the playhead. With keyframes, the
  // bubble animates; dragging it then writes/updates a keyframe at the
  // playhead instead of moving the static base position.
  const cameraEff = useMemo(
    () => cameraAt(state.camera, srcTime),
    [state.camera, srcTime],
  );

  const KF_EPS = 0.05; // keyframes closer than this (s) are replaced, not added

  const handleCameraTransform = useCallback(
    (p: { pos?: { x: number; y: number }; size?: number }) => {
      setState((s) => {
        const cam = s.camera;
        if (cam.keyframes.length === 0) {
          return {
            ...s,
            camera: {
              ...cam,
              ...(p.pos ? { pos: p.pos } : {}),
              ...(p.size !== undefined ? { size: p.size } : {}),
            },
          };
        }
        const t = srcTimeRef.current;
        const eff = cameraAt(cam, t);
        const kf: CameraKeyframe = { t, pos: p.pos ?? eff.pos, size: p.size ?? eff.size };
        const keyframes = [
          ...cam.keyframes.filter((k) => Math.abs(k.t - t) > KF_EPS),
          kf,
        ].sort((a, b) => a.t - b.t);
        return { ...s, camera: { ...cam, keyframes } };
      });
    },
    [],
  );

  const addCameraKeyframe = () => {
    const t = srcTimeRef.current;
    setState((s) => {
      const eff = cameraAt(s.camera, t);
      const keyframes = [
        ...s.camera.keyframes.filter((k) => Math.abs(k.t - t) > KF_EPS),
        { t, pos: eff.pos, size: eff.size },
      ].sort((a, b) => a.t - b.t);
      return { ...s, camera: { ...s.camera, keyframes } };
    });
  };

  const removeCameraKeyframe = (t: number) =>
    setState((s) => ({
      ...s,
      camera: {
        ...s.camera,
        keyframes: s.camera.keyframes.filter((k) => k.t !== t),
      },
    }));

  const clearCameraKeyframes = () =>
    setState((s) => ({ ...s, camera: { ...s.camera, keyframes: [] } }));

  const selectCamera = () => {
    setActiveRail("webcam");
    setSelectedZoomId(null);
    setSelectedAudioKey(null);
    setSelectedClipId(null);
  };

  // Route the native File-menu items to the handlers. Refs keep the
  // listeners stable while always calling the latest closures.
  const saveRef = useRef(handleSaveProject);
  const openRef = useRef(handleOpenProject);
  const loadRef = useRef(loadProjectFile);
  saveRef.current = handleSaveProject;
  openRef.current = handleOpenProject;
  loadRef.current = loadProjectFile;
  useEffect(() => {
    let offSave: (() => void) | undefined;
    let offOpen: (() => void) | undefined;
    let offFile: (() => void) | undefined;
    native.onMenuSaveProject(() => void saveRef.current()).then((u) => {
      offSave = u;
    });
    native.onMenuOpenProject(() => void openRef.current()).then((u) => {
      offOpen = u;
    });
    // Finder double-click while the app is running. Clear the cold-start
    // stash so the same file isn't replayed by a later take.
    native
      .onOpenProjectFile((p) => {
        void native.takePendingProjectFile().catch(() => null);
        void loadRef.current(p);
      })
      .then((u) => {
        offFile = u;
      });
    // Cold start: the app was launched by double-clicking a .openscreen file
    // and the Opened event fired before this webview was listening.
    void native
      .takePendingProjectFile()
      .then((p) => {
        if (p) void loadRef.current(p);
      })
      .catch(() => {});
    return () => {
      offSave?.();
      offOpen?.();
      offFile?.();
    };
  }, []);

  return (
    <div
      className={`editor-window ${previewFocus ? "preview-focus" : ""} ${
        resizing ? "resizing" : ""
      }`}
      style={
        {
          "--inspector-w": `${inspectorWidth}px`,
          "--timeline-h": `${timelineHeight}px`,
        } as React.CSSProperties
      }
    >
      <TitleBar
        onDiscard={() => {
          native.confirmAndDiscardEditor().catch((e) => {
            console.error("confirmAndDiscardEditor failed", e);
          });
        }}
        projectName={projectName}
        onUndo={undo}
        onRedo={redo}
        canUndo={canUndo}
        canRedo={canRedo}
        perfSettings={perfSettings}
        setPerfSettings={setPerfSettings}
        perfOpen={perfOpen}
        setPerfOpen={setPerfOpen}
        previewFocus={previewFocus}
        setPreviewFocus={setPreviewFocus}
        themeMode={themeMode}
        setThemeMode={setThemeMode}
        onExport={() => setExportOpen(true)}
        exportDisabled={!artifact || videoDuration == null}
      />
      <div className="editor-body">
        <Viewport
          state={state}
          set={set}
          playing={playing}
          onPlayToggle={() => setPlaying((p) => !p)}
          onCrop={() => setCropOpen(true)}
          currentTime={currentTime}
          duration={duration}
          videoSrc={videoSrc}
          videoRef={videoRef}
          onSeek={seek}
          cursorSidecar={cursorSidecar}
          zoomSegments={zoomSegments}
          zoomSettings={zoomSettings}
          effectSegments={effectSegments}
          videoNaturalSize={videoNaturalSize}
          previewFps={previewFpsFor(perfSettings)}
          cameraSrc={cameraSrc}
          cameraEff={cameraEff}
          cameraVideoRef={cameraVideoRef}
          onCameraTransform={handleCameraTransform}
          onCameraSelect={selectCamera}
          onSplit={splitAtPlayhead}
        />
        <IconRail active={activeRail} setActive={setActiveRail} />
        <Inspector
          active={activeRail}
          state={state}
          set={set}
          cursorSidecar={cursorSidecar}
          zoomSettings={zoomSettings}
          setZoomSettings={setZoomSettings}
          zoomSegments={zoomSegments}
          setZoomSegments={setZoomSegments}
          selectedSeg={selectedSeg}
          videoSrc={videoSrc}
          audioRows={audioRows}
          onAudioTrack={setAudioTrack}
          selectedAudioKey={selectedAudioKey}
          duration={srcDuration}
          hasCamera={cameraSrc !== null}
          onCameraAddKeyframe={addCameraKeyframe}
          onCameraClearKeyframes={clearCameraKeyframes}
          currentTime={srcTime}
          clipPanel={
            selectedClip
              ? {
                  clip: selectedClip,
                  index: selectedClipIdx,
                  count: placed.length,
                  onPatch: (patch) => setClips(patchClip(effClips, selectedClip.id, patch)),
                  onSplit: splitAtPlayhead,
                  onDelete: () => deleteClip(selectedClip.id),
                  onDuplicate: () => {
                    const r = duplicateClip(effClips, selectedClip.id);
                    setClips(r.clips);
                    selectClip(r.newId);
                  },
                  onMove: (dir) =>
                    setClips(moveClip(effClips, selectedClip.id, selectedClipIdx + dir)),
                }
              : null
          }
          effectSegments={effectSegments}
          setEffectSegments={setEffectSegments}
          selectedEffectSeg={selectedEffectSeg}
          onSelectEffect={setSelectedEffectId}
        />
        <div
          className="inspector-resizer"
          onPointerDown={startInspectorResize}
          title="Drag to resize"
        />
      </div>
      <div
        className="timeline-resizer"
        onPointerDown={startTimelineResize}
        title="Drag to resize"
      />
      <Timeline
        duration={duration}
        currentTime={currentTime}
        setCurrentTime={seek}
        clips={placed}
        srcDuration={srcDuration}
        selectedClipId={selectedClipId}
        onSelectClip={selectClip}
        onClipPatch={(id, patch) => setClips(patchClip(effClips, id, patch))}
        onMoveClip={(id, to) => setClips(moveClip(effClips, id, to))}
        onPreviewSource={previewSource}
        zoom={state.zoom}
        setZoom={(v) => set({ zoom: v })}
        playing={playing}
        audioPeaks={audioPeaks}
        audioRows={audioRows}
        onAudioTrack={setAudioTrack}
        selectedAudioKey={selectedAudioKey}
        setSelectedAudioKey={selectAudioTrack}
        cameraRow={
          cameraSrc
            ? {
                offset: (artifact?.cameraOffsetMs ?? 0) / 1000,
                duration: cameraDuration,
                keyframes: state.camera.keyframes,
                enabled: state.camera.enabled,
              }
            : null
        }
        onSelectCamera={selectCamera}
        onRemoveCameraKeyframe={removeCameraKeyframe}
        zoomSegments={zoomSegments}
        setZoomSegments={setZoomSegments}
        cursorSidecar={cursorSidecar}
        selectedZoomId={selectedZoomId}
        setSelectedZoomId={setSelectedZoomId}
        effectSegments={effectSegments}
        setEffectSegments={setEffectSegments}
        selectedEffectId={selectedEffectId}
        setSelectedEffectId={setSelectedEffectId}
        onHover={handleTimelineHover}
      />
      {cropOpen && (
        <CropDialog
          videoSrc={videoSrc}
          previewTime={srcTime}
          videoNaturalSize={videoNaturalSize}
          initialCrop={state.cropRect}
          onClose={() => setCropOpen(false)}
          onApply={(rect) => {
            set({ cropRect: rect });
            setCropOpen(false);
          }}
        />
      )}
      {exportOpen &&
        artifact &&
        videoDuration != null &&
        videoNaturalSize && (
          <ExportDialog
            artifact={artifact}
            videoDurationSec={videoDuration}
            videoNaturalSize={videoNaturalSize}
            aspectRatio={
              ASPECTS[state.aspect].w / ASPECTS[state.aspect].h
            }
            isSystem={state.aspect === "system"}
            wallpaper={state.wallpaper}
            blur={state.blur}
            padding={state.padding}
            cropRect={state.cropRect}
            cursorSidecar={cursorSidecar}
            zoomSegments={zoomSegments}
            zoomEnabled={zoomSettings.autoOn}
            smoothing={Math.max(
              0,
              Math.min(1, zoomSettings.smoothing / 100),
            )}
            effectSegments={effectSegments}
            clips={placed}
            audioTracks={[
              ...(artifact.systemAudioPath
                ? [
                    {
                      path: artifact.systemAudioPath,
                      ...state.audioTracks.system,
                      gain: exportTrackGain(
                        state.audioTracks.system,
                        systemAutoGain,
                      ),
                    },
                  ]
                : []),
              ...(artifact.micPath
                ? [
                    {
                      path: artifact.micPath,
                      ...state.audioTracks.mic,
                      gain: exportTrackGain(state.audioTracks.mic, micAutoGain),
                    },
                  ]
                : []),
            ]}
            camera={
              artifact.cameraPath
                ? {
                    path: artifact.cameraPath,
                    offsetMs: artifact.cameraOffsetMs ?? 0,
                    ...state.camera,
                  }
                : null
            }
            onClose={() => setExportOpen(false)}
          />
        )}
    </div>
  );
}
