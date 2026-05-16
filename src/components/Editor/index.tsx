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
  activeSegmentAt,
  deriveAutoZoom,
  resolveZoom,
  type ZoomSegment,
} from "../../lib/autoZoom";

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

// A wallpaper value is either a CSS gradient class ("wp-7") or an absolute
// path to a real macOS desktop picture.
const isWallpaperImage = (wp: string) => wp.startsWith("/");

/** Crop region, normalized 0..1 over the recorded video frame. */
type CropRect = { x: number; y: number; w: number; h: number };

type EditorState = {
  aspect: AspectKey;
  bgTab: string;
  wallpaper: string;
  blur: number;
  padding: number;
  cropRect: CropRect | null;
  zoom: number;
  trimStart: number;
  trimEnd: number;
  splits: number[];
};

const ASPECT_ORDER: AspectKey[] = ["16:9", "1:1", "9:16", "system"];

type StatePatch = Partial<EditorState>;

const PROJECT_VERSION = 1;

/** On-disk shape of a `.openscreen` project file. */
type ProjectFile = {
  version: number;
  app: "OpenScreen Studio";
  artifact: CaptureArtifact;
  editorState: EditorState;
  zoomSettings: ZoomSettings;
  zoomSegments: ZoomSegment[];
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

/**
 * Interpolated cursor position (in sidecar reference coords) at `tMs`.
 * Linear-interpolates between the two bracketing samples so playback is
 * smooth instead of stair-stepping sample-to-sample. Clamps to the first/last
 * sample outside the captured range. Returns null when there are no samples.
 */
function cursorPosAt(
  sc: CursorSidecar,
  tMs: number,
): { x: number; y: number } | null {
  const s = sc.samples;
  if (s.length === 0) return null;
  if (tMs <= s[0].tMs) return { x: s[0].x, y: s[0].y };
  const last = s[s.length - 1];
  if (tMs >= last.tMs) return { x: last.x, y: last.y };
  let lo = 0;
  let hi = s.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid].tMs <= tMs) lo = mid;
    else hi = mid;
  }
  const a = s[lo];
  const b = s[hi];
  const span = b.tMs - a.tMs;
  const f = span > 0 ? (tMs - a.tMs) / span : 0;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

/** Cursor shape in effect at `tMs` (last transition with tMs ≤ t). */
function cursorShapeAt(sc: CursorSidecar, tMs: number): CursorSidecarShapeName {
  const cs = sc.cursorShapes;
  if (!cs || cs.length === 0) return "arrow";
  if (tMs <= cs[0].tMs) return cs[0].shape;
  let lo = 0;
  let hi = cs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cs[mid].tMs <= tMs) lo = mid;
    else hi = mid;
  }
  return cs[hi].tMs <= tMs ? cs[hi].shape : cs[lo].shape;
}

// Glyph art for the synthetic cursor. `hot` is the hotspot as a fraction of
// the 24×24 viewBox so the active point lands exactly on the tracked position.
// Shapes we don't have bespoke art for fall back to the arrow.
type Glyph = { svg: string; hot: [number, number] };
const ARROW_GLYPH: Glyph = {
  svg: '<path d="M4 2 L4 18 L8 14 L11 20.5 L13.6 19.4 L10.6 13 L16 13 Z" fill="#000" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/>',
  hot: [4 / 24, 2 / 24],
};
const CURSOR_GLYPHS: Partial<Record<CursorSidecarShapeName, Glyph>> = {
  arrow: ARROW_GLYPH,
  pointer: {
    svg: '<path d="M10 9V4.2c0-0.9 0.7-1.6 1.6-1.6s1.6 0.7 1.6 1.6V9.4 M13.2 10V8.4c0-0.8 0.7-1.5 1.5-1.5s1.5 0.7 1.5 1.5V11 M16.2 11.2v-1c0-0.8 0.6-1.4 1.4-1.4s1.4 0.6 1.4 1.4V16c0 2.6-1.9 4.8-4.6 4.8h-2.1c-1.4 0-2.7-0.6-3.6-1.7l-3.1-3.8c-0.5-0.7-0.4-1.6 0.3-2.1 0.6-0.5 1.5-0.4 2.1 0.2L10 15V6.2c0-0.9 0.7-1.6 1.6-1.6" fill="#000" stroke="#fff" stroke-width="1.1" stroke-linejoin="round" stroke-linecap="round"/>',
    hot: [11 / 24, 2.6 / 24],
  },
  text: {
    svg: '<path d="M8.5 3.5h7M8.5 20.5h7M12 3.5v17" stroke="#fff" stroke-width="3.4" fill="none" stroke-linecap="round"/><path d="M8.5 3.5h7M8.5 20.5h7M12 3.5v17" stroke="#000" stroke-width="1.6" fill="none" stroke-linecap="round"/>',
    hot: [0.5, 0.5],
  },
};
CURSOR_GLYPHS.verticalText = CURSOR_GLYPHS.text;

function glyphFor(shape: CursorSidecarShapeName): Glyph {
  return CURSOR_GLYPHS[shape] ?? ARROW_GLYPH;
}

const baseName = (p: string) => p.split(/[\\/]/).pop() || p;

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
          className="export-btn disabled"
          aria-disabled
          data-tip="Coming soon"
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

  return (
    <div className="slider-row">
      <div className="slider">
        <div
          className="track"
          ref={ref}
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
              <div
                key={g}
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
              <div
                key={wp.thumb}
                title={wp.name}
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
      {cursorSidecar && zoomSegments.length === 0 && (
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
          aria-pressed={seg.instant}
        />
      </div>

      <div className="row-toggle">
        <div className="col">
          <div className="label">Disable zoom</div>
        </div>
        <button
          className={`switch ${seg.disabled ? "on" : ""}`}
          onClick={() => patch({ disabled: !seg.disabled })}
          aria-pressed={seg.disabled}
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
}: {
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
}) {
  return (
    <aside className="inspector">
      {selectedSeg ? (
        <ZoomSegmentPanel
          seg={selectedSeg}
          setSegments={setZoomSegments}
          segments={zoomSegments}
          defaultLevel={zoomSettings.defaultLevel}
          videoSrc={videoSrc}
          cursorSidecar={cursorSidecar}
        />
      ) : active === "cursor" ? (
        <CursorZoomPanel
          cursorSidecar={cursorSidecar}
          zoomSettings={zoomSettings}
          setZoomSettings={setZoomSettings}
          zoomSegments={zoomSegments}
          setZoomSegments={setZoomSegments}
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
    { id: "webcam", icon: <Ico.webcam size={17} />, disabled: true },
    { id: "subtitles", icon: <Ico.speech size={17} />, disabled: true },
    { id: "audio", icon: <Ico.audio size={17} />, disabled: true },
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
  videoNaturalSize,
  cropRect,
  previewFps,
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
  videoNaturalSize: { w: number; h: number } | null;
  cropRect: CropRect | null;
  previewFps: number;
}) {
  const a = ASPECTS[aspect];
  const maxW = viewportSize.w - 80;
  const maxH = viewportSize.h - 110;
  // Aspect of the actual video pixels — used to size the rounded wrapper to
  // the displayed content rect (not the letterboxed bounding box) so the
  // rounded corners follow the visible video edges.
  // When a crop is applied the wrapper must follow the *cropped* region's
  // aspect ratio, not the full frame's, so rounded corners hug the visible edges.
  const rawVideoAR =
    videoNaturalSize && videoNaturalSize.h > 0
      ? videoNaturalSize.w / videoNaturalSize.h
      : null;
  const videoAR =
    rawVideoAR && cropRect && cropRect.h > 0
      ? rawVideoAR * (cropRect.w / cropRect.h)
      : rawVideoAR;
  // In "system" / auto mode we want uniform padding on all four sides, so the
  // canvas is sized as (videoDisplay + 2·padding) rather than just matching
  // the video's aspect ratio. Otherwise a 16:9 video inside a 16:9 canvas
  // with equal CSS padding produces a non-video-AR inner box and the video
  // letterboxes asymmetrically.
  let w: number;
  let h: number;
  let ratio: number;
  if (aspect === "system" && videoAR) {
    const availW = Math.max(1, maxW - 2 * padding);
    const availH = Math.max(1, maxH - 2 * padding);
    let videoW = availW;
    let videoH = availW / videoAR;
    if (videoH > availH) {
      videoH = availH;
      videoW = availH * videoAR;
    }
    w = videoW + 2 * padding;
    h = videoH + 2 * padding;
    ratio = w / h;
  } else {
    ratio = a.w / a.h;
    w = maxW;
    h = maxW / ratio;
    if (h > maxH) {
      h = maxH;
      w = maxH * ratio;
    }
  }

  // Explicit pixel size for the video wrapper. The wrapper used to derive its
  // size from the in-flow <video>'s intrinsic dimensions; once a crop makes the
  // <video> absolutely positioned it no longer contributes layout size, so the
  // wrapper would collapse to 0. Compute the displayed video box (contain fit
  // of the effective aspect ratio inside the padded content area) directly.
  let wrapPxW: number | null = null;
  let wrapPxH: number | null = null;
  if (videoAR) {
    const innerW = Math.max(1, w - 2 * padding);
    const innerH = Math.max(1, h - 2 * padding);
    let bw = innerW;
    let bh = innerW / videoAR;
    if (bh > innerH) {
      bh = innerH;
      bw = innerH * videoAR;
    }
    wrapPxW = bw;
    wrapPxH = bh;
  }

  // Drive the zoom transform on the video element from a RAF that reads the
  // live currentTime. Writing transforms directly (not via React state) keeps
  // this off the render path so 60 Hz updates don't trash the reconciler.
  const videoWrapRef = useRef<HTMLDivElement | null>(null);
  const cursorElRef = useRef<HTMLDivElement | null>(null);
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
      if (!zoomSettings.autoOn || zoomSegments.length === 0 || !cursorSidecar) {
        wrap.style.transformOrigin = "0 0";
        wrap.style.transform = "translate(0,0) scale(1)";
        return;
      }
      const tMs = video.currentTime * 1000;
      const { scale, focal } = resolveZoom(tMs, zoomSegments, cursorSidecar, smoothing);
      // No active segment / scale ≈ 1: skip the focal-centering math entirely.
      // Otherwise a focal of {0,0} would shift the video toward the top-left.
      if (scale <= 1.001) {
        wrap.style.transformOrigin = "0 0";
        wrap.style.transform = "translate(0,0) scale(1)";
        return;
      }
      const activeSeg = activeSegmentAt(tMs, zoomSegments);
      const snapPct = Math.max(0, Math.min(100, activeSeg?.snapToEdges ?? DEFAULT_SNAP_TO_EDGES));
      // Use unscaled layout box — getBoundingClientRect returns the
      // *transformed* size, which would feed the previous frame's scale back
      // into this frame and walk the focal toward the top-left.
      const wrapW = wrap.offsetWidth;
      const wrapH = wrap.offsetHeight;
      // Map crop-local point coords → pixels inside the displayed video rect
      // (objectFit: contain may letterbox the natural video inside the wrapper).
      const vw = video.videoWidth || wrapW;
      const vh = video.videoHeight || wrapH;
      const fit = Math.min(wrapW / vw, wrapH / vh);
      const displayedW = vw * fit;
      const displayedH = vh * fit;
      const offsetX = (wrapW - displayedW) / 2;
      const offsetY = (wrapH - displayedH) / 2;
      const crop = cursorSidecar.crop;
      const refW = crop ? crop.width : cursorSidecar.display.width;
      const refH = crop ? crop.height : cursorSidecar.display.height;
      const rawPx = offsetX + (focal.x / Math.max(1, refW)) * displayedW;
      const rawPy = offsetY + (focal.y / Math.max(1, refH)) * displayedH;
      // Clamp the focal so the visible viewport stays inside the displayed
      // video rect — otherwise centering a cursor near an edge would expose
      // the letterbox / black background. `snapToEdges` relaxes the clamp:
      // 0 = strict, 100 = full overrun allowed (camera follows focal verbatim).
      // Crucially we ramp the relaxation with how-much-we've-zoomed: at the
      // segment edge (scale≈1) halfVisible is wrapW/2 and any non-zero relax
      // would jerk the focal far from center even though there's no real pan
      // range yet. zoomProgress=0 at the edges, =1 at the peak.
      const halfVisibleW = wrapW / (2 * scale);
      const halfVisibleH = wrapH / (2 * scale);
      const peakScale = activeSeg?.targetLevel ?? scale;
      const zoomProgress = peakScale > 1
        ? Math.max(0, Math.min(1, (scale - 1) / (peakScale - 1)))
        : 0;
      const relax = (snapPct / 100) * zoomProgress;
      const minPx = offsetX + halfVisibleW * (1 - relax);
      const maxPx = offsetX + displayedW - halfVisibleW * (1 - relax);
      const minPy = offsetY + halfVisibleH * (1 - relax);
      const maxPy = offsetY + displayedH - halfVisibleH * (1 - relax);
      const px = minPx <= maxPx ? Math.min(maxPx, Math.max(minPx, rawPx)) : (offsetX + displayedW / 2);
      const py = minPy <= maxPy ? Math.min(maxPy, Math.max(minPy, rawPy)) : (offsetY + displayedH / 2);
      // Center the focal in the viewport: translate so px*scale + tx == viewport center.
      const tx = wrapW / 2 - px * scale;
      const ty = wrapH / 2 - py * scale;
      wrap.style.transformOrigin = "0 0";
      wrap.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    };
    // previewFps === 0 means uncapped (full refresh rate). Otherwise throttle
    // the transform loop to the target interval to cut CPU/GPU usage.
    const frameInterval = previewFps > 0 ? 1000 / previewFps : 0;
    let lastFrame = 0;
    const tick = (now: number) => {
      if (frameInterval === 0 || now - lastFrame >= frameInterval) {
        lastFrame = now;
        apply();
        positionCursor();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [videoRef, cursorSidecar, zoomSegments, zoomSettings, cropRect, previewFps]);

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
              style={
                cropRect
                  ? {
                      position: "absolute",
                      width: `${100 / cropRect.w}%`,
                      height: `${100 / cropRect.h}%`,
                      left: `${-(cropRect.x / cropRect.w) * 100}%`,
                      top: `${-(cropRect.y / cropRect.h) * 100}%`,
                      display: "block",
                      objectFit: "contain",
                    }
                  : { width: "100%", height: "100%", display: "block", objectFit: "contain" }
              }
              playsInline
              preload="metadata"
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
  videoNaturalSize,
  previewFps,
}: {
  state: EditorState;
  set: (p: StatePatch) => void;
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
  videoNaturalSize: { w: number; h: number } | null;
  previewFps: number;
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
        videoNaturalSize={videoNaturalSize}
        cropRect={state.cropRect}
        previewFps={previewFps}
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
            title="Split clip at playhead"
            onClick={() => {
              if (state.splits.includes(currentTime)) return;
              set({ splits: [...state.splits, currentTime].sort((a, b) => a - b) });
            }}
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
  const dragRef = useRef<{ trackWidth: number; trackLeft: number; startMs: number; endMs: number }>({
    trackWidth: 0,
    trackLeft: 0,
    startMs: 0,
    endMs: 0,
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
        const len = endMs - startMs;
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

function Timeline({
  duration,
  currentTime,
  setCurrentTime,
  trimStart,
  trimEnd,
  onTrimStart,
  onTrimEnd,
  splits,
  zoom,
  setZoom,
  playing,
  audioPeaks,
  zoomSegments,
  setZoomSegments,
  cursorSidecar,
  selectedZoomId,
  setSelectedZoomId,
  onHover,
}: {
  duration: number;
  currentTime: number;
  setCurrentTime: (v: number) => void;
  trimStart: number;
  trimEnd: number;
  onTrimStart: () => void;
  onTrimEnd: () => void;
  splits: number[];
  zoom: number;
  setZoom: (v: number) => void;
  playing: boolean;
  audioPeaks: number[] | null;
  zoomSegments: ZoomSegment[];
  setZoomSegments: (next: ZoomSegment[]) => void;
  cursorSidecar: CursorSidecar | null;
  selectedZoomId: string | null;
  onHover?: (t: number | null) => void;
  setSelectedZoomId: (id: string | null) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const [hoverT, setHoverT] = useState<number | null>(null);

  const TOTAL = Math.max(duration, 0.0001);
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
    const startMs = t * 1000;
    const endMs = Math.min(TOTAL, t + MANUAL_ZOOM_SEC) * 1000;
    if (endMs - startMs < 1) return;
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
          <div className="tl-gutter-row zoom">
            <Ico.zoomIn size={12} />
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
        <div className="tl-track" style={{ position: "relative" }}>
          <div
            className="scissor-mark left"
            title="Set trim start to playhead"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onTrimStart();
            }}
            style={{ cursor: "pointer" }}
          >
            <Ico.scissors size={10} />
            <div style={{ marginTop: 1 }}>{trimStart.toFixed(1)}s</div>
          </div>
          <div
            className="scissor-mark right"
            title="Set trim end to playhead"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onTrimEnd();
            }}
            style={{ cursor: "pointer" }}
          >
            <Ico.scissors size={10} />
            <div style={{ marginTop: 1 }}>{trimEnd.toFixed(1)}s</div>
          </div>
          <div className="clip-block" style={{ left: 0, right: 0, width: "auto" }}>
            {splits.map((t) => (
              <div
                key={t}
                style={{
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  left: `${(t / TOTAL) * 100}%`,
                  width: 2,
                  background: "rgba(255,255,255,0.95)",
                  boxShadow: "0 0 4px rgba(0,0,0,0.6)",
                  pointerEvents: "none",
                  zIndex: 3,
                }}
              />
            ))}
            {(trimStart > 0 || trimEnd > 0) && (
              <>
                {trimStart > 0 && (
                  <div
                    style={{
                      position: "absolute",
                      top: 0,
                      bottom: 0,
                      left: 0,
                      width: `${(trimStart / TOTAL) * 100}%`,
                      background: "rgba(0,0,0,0.55)",
                      pointerEvents: "none",
                      zIndex: 2,
                    }}
                  />
                )}
                {trimEnd > 0 && (
                  <div
                    style={{
                      position: "absolute",
                      top: 0,
                      bottom: 0,
                      right: 0,
                      width: `${(trimEnd / TOTAL) * 100}%`,
                      background: "rgba(0,0,0,0.55)",
                      pointerEvents: "none",
                      zIndex: 2,
                    }}
                  />
                )}
              </>
            )}
            {audioPeaks && audioPeaks.length > 0 && (
              <svg
                className="waveform"
                viewBox={`0 0 ${audioPeaks.length} 56`}
                preserveAspectRatio="none"
                style={{ width: "100%" }}
              >
                <path d={buildWavePath(audioPeaks, 56)} fill="rgba(255,255,255,0.55)" />
              </svg>
            )}
            <div className="stack">
              <div className="label-pill">
                <Ico.film size={11} /> Clip
              </div>
              <div className="meta">
                <span>
                  <Ico.audio size={10} /> {fmt(Math.max(0, duration - trimStart - trimEnd))}
                </span>
                <span>
                  <Ico.speedo size={10} /> 1×
                </span>
              </div>
            </div>
            <div
              style={{
                position: "absolute",
                left: 8,
                bottom: 6,
                fontSize: 9,
                color: "rgba(255,255,255,0.7)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {fmt(trimStart)}
            </div>
            <div
              style={{
                position: "absolute",
                right: 8,
                bottom: 6,
                fontSize: 9,
                color: "rgba(255,255,255,0.7)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {fmt(duration - trimEnd)}
            </div>
          </div>
        </div>

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
          {zoomSegments.map((seg) => {
            const totalMs = TOTAL * 1000;
            // Clamp the displayed range so a segment whose endMs lands past
            // the video's duration (e.g. cursor sidecar slightly longer than
            // the trimmed clip) doesn't overflow .tl-tracks and get clipped
            // at the right edge at max zoom out.
            const startMs = Math.max(0, Math.min(totalMs, seg.startMs));
            const endMs = Math.max(startMs, Math.min(totalMs, seg.endMs));
            const left = (startMs / Math.max(1, totalMs)) * 100;
            const width = ((endMs - startMs) / Math.max(1, totalMs)) * 100;
            return (
              <ZoomChip
                key={seg.id}
                seg={seg}
                leftPct={left}
                widthPct={width}
                totalMs={totalMs}
                selected={selectedZoomId === seg.id}
                onSelect={() => setSelectedZoomId(seg.id)}
                onUpdate={(patch) =>
                  setZoomSegments(
                    zoomSegments.map((s) => (s.id === seg.id ? { ...s, ...patch } : s)),
                  )
                }
                onDelete={() => {
                  setZoomSegments(zoomSegments.filter((s) => s.id !== seg.id));
                  if (selectedZoomId === seg.id) setSelectedZoomId(null);
                }}
              />
            );
          })}
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
    trimStart: 0,
    trimEnd: 0,
    splits: [],
  });
  const set = (patch: StatePatch) => setState((s) => ({ ...s, ...patch }));

  const [activeRail, setActiveRail] = useState("background");
  const [artifact, setArtifact] = useState<CaptureArtifact | null>(null);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const [videoNaturalSize, setVideoNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [audioPeaks, setAudioPeaks] = useState<number[] | null>(null);
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
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // ---- Undo / redo -----------------------------------------------------
  // History covers the user-editable surface: canvas settings (`state`)
  // and zoom segments. Rapid changes (slider/timeline drags) are coalesced
  // — a snapshot is committed only once edits settle, so one drag is one
  // undo step. Programmatic resets (project load, fresh recording, the
  // wallpaper default) rebase the baseline instead of adding a step.
  type EditSnapshot = { state: EditorState; zoomSegments: ZoomSegment[] };
  const histRef = useRef<{
    past: EditSnapshot[];
    present: EditSnapshot;
    future: EditSnapshot[];
  }>({ past: [], present: { state, zoomSegments }, future: [] });
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
      const cur: EditSnapshot = { state, zoomSegments };
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
  }, [state, zoomSegments]);

  const liveSnapRef = useRef<EditSnapshot>({ state, zoomSegments });
  liveSnapRef.current = { state, zoomSegments };

  const applySnapshot = (snap: EditSnapshot) => {
    histApplyingRef.current = true;
    setState(snap.state);
    setZoomSegments(snap.zoomSegments);
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

  // Esc clears the active zoom selection — surfaces the icon-rail tab again.
  // Delete/Backspace removes the selected zoom block (unless the user is
  // typing in a field, where those keys mean "edit text").
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelectedZoomId(null);
        return;
      }
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (!selectedZoomId) return;
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
      setZoomSegments(zoomSegments.filter((s) => s.id !== selectedZoomId));
      setSelectedZoomId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedZoomId, zoomSegments, setZoomSegments]);

  // When a segment is selected, highlight the cursor rail icon.
  useEffect(() => {
    if (selectedZoomId) setActiveRail("cursor");
  }, [selectedZoomId]);

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

  const videoSrc = useMemo(
    () => (artifact ? convertFileSrc(artifact.path) : SAMPLE_VIDEO),
    [artifact],
  );

  // The demo timeline is 12s; once a real recording is loaded use its duration.
  const DEMO_DURATION = 12;
  const duration = videoDuration ?? DEMO_DURATION;
  const [currentTime, setCurrentTime] = useState(2.4);
  const [playing, setPlaying] = useState(false);
  const [cropOpen, setCropOpen] = useState(false);
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
      if (v.videoWidth > 0 && v.videoHeight > 0) {
        setVideoNaturalSize({ w: v.videoWidth, h: v.videoHeight });
      }
    };
    v.addEventListener("loadedmetadata", onMeta);
    return () => v.removeEventListener("loadedmetadata", onMeta);
  }, [videoSrc]);

  // Decode the recording's audio and produce a peaks array so the timeline
  // clip-block can render a real waveform (instead of the placeholder SVG).
  useEffect(() => {
    if (!videoSrc) {
      setAudioPeaks(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const buf = await fetch(videoSrc).then((r) => r.arrayBuffer());
        const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new Ctx();
        const audio: AudioBuffer = await new Promise((resolve, reject) =>
          ctx.decodeAudioData(buf, resolve, reject),
        );
        const N = 260;
        const ch0 = audio.getChannelData(0);
        const hasCh1 = audio.numberOfChannels > 1;
        const ch1 = hasCh1 ? audio.getChannelData(1) : null;
        const block = Math.max(1, Math.floor(ch0.length / N));
        const out: number[] = new Array(N);
        let peak = 0;
        for (let i = 0; i < N; i++) {
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
        ctx.close();
        const norm = peak > 0.001 ? out.map((v) => v / peak) : null;
        if (!cancelled) setAudioPeaks(norm);
      } catch {
        if (!cancelled) setAudioPeaks(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [videoSrc]);

  // Drive playback / scrubbing on the real <video>.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (videoSrc) {
      if (playing) v.play().catch(() => {});
      else v.pause();
    }
  }, [playing, videoSrc]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !videoSrc) return;
    const onEnded = () => setPlaying(false);
    v.addEventListener("ended", onEnded);
    return () => v.removeEventListener("ended", onEnded);
  }, [videoSrc]);

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
        setCurrentTime(v.currentTime);
      };
      v.addEventListener("timeupdate", onTime);
      return () => v.removeEventListener("timeupdate", onTime);
    }
    let raf = 0;
    const tick = () => {
      if (!isHoveringRef.current) setCurrentTime(v.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, videoSrc]);

  // Scrubbing the timeline should seek the real video.
  const seek = (t: number) => {
    setCurrentTime(t);
    const v = videoRef.current;
    if (v && videoSrc) v.currentTime = t;
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
      v.currentTime = currentTime;
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
    v.currentTime = t;
  };

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
    setState((s) => ({ ...s, ...project.editorState }));
    setZoomSettingsRaw((s) => ({ ...s, ...project.zoomSettings }));
    setZoomSegments(project.zoomSegments ?? []);
    setSelectedZoomId(null);
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

  // Route the native File-menu items to the handlers. Refs keep the
  // listeners stable while always calling the latest closures.
  const saveRef = useRef(handleSaveProject);
  const openRef = useRef(handleOpenProject);
  saveRef.current = handleSaveProject;
  openRef.current = handleOpenProject;
  useEffect(() => {
    let offSave: (() => void) | undefined;
    let offOpen: (() => void) | undefined;
    native.onMenuSaveProject(() => void saveRef.current()).then((u) => {
      offSave = u;
    });
    native.onMenuOpenProject(() => void openRef.current()).then((u) => {
      offOpen = u;
    });
    return () => {
      offSave?.();
      offOpen?.();
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
          videoNaturalSize={videoNaturalSize}
          previewFps={previewFpsFor(perfSettings)}
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
        trimStart={state.trimStart}
        trimEnd={state.trimEnd}
        onTrimStart={() => set({ trimStart: Math.min(currentTime, duration - state.trimEnd) })}
        onTrimEnd={() => set({ trimEnd: Math.min(duration - currentTime, duration - state.trimStart) })}
        splits={state.splits}
        zoom={state.zoom}
        setZoom={(v) => set({ zoom: v })}
        playing={playing}
        audioPeaks={audioPeaks}
        zoomSegments={zoomSegments}
        setZoomSegments={setZoomSegments}
        cursorSidecar={cursorSidecar}
        selectedZoomId={selectedZoomId}
        setSelectedZoomId={setSelectedZoomId}
        onHover={handleTimelineHover}
      />
      {cropOpen && (
        <CropDialog
          videoSrc={videoSrc}
          previewTime={currentTime}
          videoNaturalSize={videoNaturalSize}
          initialCrop={state.cropRect}
          onClose={() => setCropOpen(false)}
          onApply={(rect) => {
            set({ cropRect: rect });
            setCropOpen(false);
          }}
        />
      )}
    </div>
  );
}
