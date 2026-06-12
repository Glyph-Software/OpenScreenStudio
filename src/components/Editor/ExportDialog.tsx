import { useEffect, useMemo, useRef, useState } from "react";
import { Ico } from "../icons";
import type { CaptureArtifact, CursorSidecar } from "../../lib/native";
import type { ZoomSegment } from "../../lib/autoZoom";
import { computeFrameLayout, type CropRect } from "../../lib/compositor";
import {
  estimateExport,
  exportVideo,
  formatBytes,
  resolveOutputDims,
  type ExportAudioTrack,
  type ExportCameraTrack,
  type ExportResolution,
  type ExportTarget,
} from "../../lib/exporter";
import type { ExportFormat, ExportPreset } from "../../lib/native";

const FORMATS: { id: ExportFormat; label: string }[] = [
  { id: "mp4", label: "MP4" },
  { id: "gif", label: "GIF" },
];
const FPS_OPTIONS = [24, 30, 60];
const RESOLUTIONS: { id: ExportResolution; label: string }[] = [
  { id: "720", label: "720p" },
  { id: "1080", label: "1080p" },
  { id: "4k", label: "4K" },
];
const PRESETS: {
  id: ExportPreset;
  label: string;
  desc: string;
}[] = [
  {
    id: "studio",
    label: "Studio",
    desc: "Highest quality, near-lossless. Best for re-editing or archiving. Largest file size.",
  },
  {
    id: "social",
    label: "Social Media",
    desc: "Good for sharing on social media. Compression is noticeable on close inspection, and platforms may compress the video further.",
  },
  {
    id: "web",
    label: "Web",
    desc: "Smaller files tuned for fast web delivery. Quality is good for most screen content.",
  },
  {
    id: "weblow",
    label: "Web (Low)",
    desc: "Smallest files. Visible compression — use when size matters more than fidelity.",
  },
];

function ExportSeg<T extends string>(p: {
  options: { id: T; label: string }[];
  value: T;
  disabled: boolean;
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg export-seg">
      {p.options.map((o) => (
        <button
          key={o.id}
          className={p.value === o.id ? "on" : ""}
          onClick={() => p.onChange(o.id)}
          disabled={p.disabled}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ExportDialog(props: {
  artifact: CaptureArtifact;
  videoDurationSec: number;
  videoNaturalSize: { w: number; h: number };
  aspectRatio: number;
  isSystem: boolean;
  wallpaper: string;
  blur: number;
  padding: number;
  cropRect: CropRect | null;
  cursorSidecar: CursorSidecar | null;
  zoomSegments: ZoomSegment[];
  zoomEnabled: boolean;
  smoothing: number;
  trimStart: number;
  trimEnd: number;
  audioTracks: ExportAudioTrack[];
  camera: ExportCameraTrack | null;
  onClose: () => void;
}) {
  const [format, setFormat] = useState<ExportFormat>("mp4");
  const [fps, setFps] = useState(60);
  const [fpsOpen, setFpsOpen] = useState(false);
  const [resolution, setResolution] = useState<ExportResolution>("720");
  const [preset, setPreset] = useState<ExportPreset>("social");
  const [target, setTarget] = useState<ExportTarget>("file");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Reproduce the exact preview geometry by measuring the live editor
  // viewport — keeps the exported frame WYSIWYG with what the user sees.
  const [box, setBox] = useState<{ w: number; h: number }>({
    w: 1280,
    h: 720,
  });
  useEffect(() => {
    const el = document.querySelector(".viewport");
    if (el) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setBox({ w: r.width, h: r.height });
    }
  }, []);

  const layout = useMemo(
    () =>
      computeFrameLayout({
        aspectRatio: props.aspectRatio,
        isSystem: props.isSystem,
        videoNaturalSize: props.videoNaturalSize,
        cropRect: props.cropRect,
        padding: props.padding,
        box,
      }),
    [
      props.aspectRatio,
      props.isSystem,
      props.videoNaturalSize,
      props.cropRect,
      props.padding,
      box,
    ],
  );
  const dims = useMemo(
    () => resolveOutputDims(layout.ratio, resolution),
    [layout.ratio, resolution],
  );

  const durationSec = Math.max(
    0,
    props.videoDurationSec - props.trimStart - props.trimEnd,
  );
  const est = useMemo(
    () =>
      estimateExport({
        durationSec,
        fps,
        width: dims.w,
        height: dims.h,
        format,
        preset,
      }),
    [durationSec, fps, dims.w, dims.h, format, preset],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !running) props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [running, props]);

  useEffect(
    () => () => abortRef.current?.abort(),
    [],
  );

  const presetDesc = PRESETS.find((p) => p.id === preset)?.desc ?? "";

  const startExport = async () => {
    setError(null);
    setRunning(true);
    setProgress(0);
    setProgressLabel("Preparing…");
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const res = await exportVideo({
      artifact: props.artifact,
      videoDurationSec: props.videoDurationSec,
      videoNaturalSize: props.videoNaturalSize,
      aspectRatio: props.aspectRatio,
      isSystem: props.isSystem,
      wallpaper: props.wallpaper,
      blur: props.blur,
      padding: props.padding,
      cropRect: props.cropRect,
      cursorSidecar: props.cursorSidecar,
      zoomSegments: props.zoomSegments,
      zoomEnabled: props.zoomEnabled,
      smoothing: props.smoothing,
      trimStart: props.trimStart,
      trimEnd: props.trimEnd,
      audioTracks: props.audioTracks,
      camera: props.camera,
      viewportBox: box,
      resolution,
      fps,
      format,
      preset,
      target,
      onProgress: (frac, label) => {
        setProgress(frac);
        setProgressLabel(label);
      },
      signal: ctrl.signal,
    });
    abortRef.current = null;
    if (res.ok) {
      props.onClose();
    } else if ("canceled" in res) {
      setRunning(false);
      setProgress(0);
    } else {
      setRunning(false);
      setError(res.error);
    }
  };

  return (
    <div
      className="crop-modal-backdrop"
      onMouseDown={() => !running && props.onClose()}
    >
      <div
        className="crop-modal export-modal"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="crop-modal-head">
          <span>
            <Ico.upload size={15} /> Export recording
          </span>
          <button
            className="tb-icon-btn"
            title="Close"
            onClick={() => !running && props.onClose()}
          >
            <Ico.xMark size={16} />
          </button>
        </div>

        <div className="export-body">
          <div className="export-grid">
            <div className="export-field">
              <div className="export-label">
                <Ico.film size={14} /> Format
              </div>
              <ExportSeg
                options={FORMATS}
                value={format}
                disabled={running}
                onChange={setFormat}
              />
            </div>

            <div className="export-field">
              <div className="export-label">
                <Ico.speedo size={14} /> Frame rate
              </div>
              <div className="export-dropdown-wrap">
                <button
                  className="export-dropdown"
                  onClick={() => !running && setFpsOpen((o) => !o)}
                  disabled={running}
                >
                  <span>
                    {fps} <span className="dim">FPS</span>
                  </span>
                  <Ico.chevDown size={11} style={{ opacity: 0.6 }} />
                </button>
                {fpsOpen && (
                  <>
                    <div
                      className="export-dd-backdrop"
                      onMouseDown={() => setFpsOpen(false)}
                    />
                    <div className="export-dd-menu">
                      {FPS_OPTIONS.map((f) => (
                        <button
                          key={f}
                          className={f === fps ? "on" : ""}
                          onClick={() => {
                            setFps(f);
                            setFpsOpen(false);
                          }}
                        >
                          {f} FPS
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="export-field">
              <div className="export-label">
                <Ico.crop size={14} /> Resolution
              </div>
              <ExportSeg
                options={RESOLUTIONS}
                value={resolution}
                disabled={running}
                onChange={setResolution}
              />
              <div className="export-sub">
                {dims.w}px × {dims.h}px
              </div>
            </div>

            <div className="export-field">
              <div className="export-label">
                <Ico.sparkles size={14} /> Compression
              </div>
              <ExportSeg
                options={PRESETS.map((p) => ({ id: p.id, label: p.label }))}
                value={preset}
                disabled={running}
                onChange={setPreset}
              />
              <div className="export-sub">{presetDesc}</div>
              <div className="export-sub">
                Quality setting does not impact export speed.
              </div>
            </div>
          </div>
        </div>

        <div className="export-foot">
          <div className="export-foot-row">
            <div className="export-target">
              <div className="export-label">Export to</div>
              <div className="seg export-seg">
                <button
                  className={target === "file" ? "on" : ""}
                  onClick={() => setTarget("file")}
                  disabled={running}
                >
                  <Ico.upload size={13} /> File
                </button>
                <button
                  className={target === "clipboard" ? "on" : ""}
                  onClick={() => setTarget("clipboard")}
                  disabled={running}
                >
                  <Ico.image size={13} /> Clipboard
                </button>
                <button
                  className="disabled"
                  disabled
                  data-tip="Coming soon"
                >
                  <Ico.link size={13} /> Shareable link
                </button>
              </div>
            </div>

            <div className="export-actions">
              {!running ? (
                <>
                  <button
                    className="crop-cancel"
                    onClick={props.onClose}
                  >
                    Cancel
                  </button>
                  <button className="export-btn" onClick={startExport}>
                    <Ico.upload size={13} />
                    {target === "clipboard"
                      ? "Export to clipboard"
                      : "Export to file…"}
                  </button>
                </>
              ) : (
                <button
                  className="crop-cancel"
                  onClick={() => abortRef.current?.abort()}
                >
                  Cancel export
                </button>
              )}
            </div>
          </div>

          {running ? (
            <div className="export-progress">
              <div className="export-progress-bar">
                <div
                  className="export-progress-fill"
                  style={{ width: `${Math.round(progress * 100)}%` }}
                />
              </div>
              <div className="export-estimate">
                {progressLabel} — {Math.round(progress * 100)}%
              </div>
            </div>
          ) : (
            <div className="export-estimate">
              {error ? (
                <span className="export-error">{error}</span>
              ) : (
                <>
                  Estimation — Export time{" "}
                  {Math.max(1, Math.round(est.seconds))} seconds — Output
                  size {formatBytes(est.bytes)}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
