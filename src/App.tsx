import { useEffect, useState } from "react";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { CaptureHUD, type CaptureAVSettings } from "./components/CaptureHUD";
import { Editor } from "./components/Editor";
import { Permissions } from "./components/Permissions";
import { PickerOverlay } from "./components/PickerOverlay";
import { Ico } from "./components/icons";
import { useAccent } from "./hooks/useAccent";
import { useTheme, useThemeMode } from "./hooks/useTheme";
import { native, type CaptureArtifact, type CropRect } from "./lib/native";
import "./styles/globals.css";

type HudPhase = "idle" | "countdown" | "recording";

const HUD_IDLE_SIZE = new LogicalSize(900, 75);
const HUD_REC_SIZE = new LogicalSize(260, 52);

function Countdown({ from = 3, onDone }: { from?: number; onDone: () => void }) {
  const [n, setN] = useState(from);
  useEffect(() => {
    if (n <= 0) {
      onDone();
      return;
    }
    const id = setTimeout(() => setN(n - 1), 700);
    return () => clearTimeout(id);
  }, [n, onDone]);
  return (
    <div className="hud-stage">
      <div key={n} className="countdown">
        {n > 0 ? n : "Go"}
      </div>
    </div>
  );
}

function fmt(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function RecordingPill({
  elapsedMs,
  paused,
  onStop,
  onPauseToggle,
  onRestart,
  onCancel,
}: {
  elapsedMs: number;
  paused: boolean;
  onStop: () => void;
  onPauseToggle: () => void;
  onRestart: () => void;
  onCancel: () => void;
}) {
  const startDrag = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    if (e.button !== 0) return;
    e.preventDefault();
    void getCurrentWindow().startDragging();
  };
  return (
    <div className="hud-stage" onMouseDown={startDrag}>
      <div className="rec-pill" onMouseDown={startDrag}>
        <button className="rec-stop" onClick={onStop} title="Stop recording">
          <Ico.stopCircle size={20} sw={2} />
          <span className="rec-time">{fmt(Math.max(0, elapsedMs))}</span>
        </button>
        <div className="rec-divider" />
        <button
          className="rec-btn"
          onClick={onPauseToggle}
          title={paused ? "Resume" : "Pause"}
        >
          {paused ? <Ico.playCircle size={20} sw={1.6} /> : <Ico.pauseCircle size={20} sw={1.6} />}
        </button>
        <button className="rec-btn" onClick={onRestart} title="Restart recording">
          <Ico.restart size={18} sw={1.8} />
        </button>
        <button className="rec-btn" onClick={onCancel} title="Discard recording">
          <Ico.trash size={18} sw={1.6} />
        </button>
      </div>
    </div>
  );
}

function HudWindow() {
  const [phase, setPhase] = useState<HudPhase>("idle");
  const [pending, setPending] = useState<{ displayId: number; windowId: number | null; av: CaptureAVSettings; crop: CropRect | null } | null>(null);
  const [recStart, setRecStart] = useState<number | null>(null);
  const [pausedAt, setPausedAt] = useState<number | null>(null);
  const [pausedAccumMs, setPausedAccumMs] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [avSettings, setAvSettings] = useState<CaptureAVSettings>({
    systemAudio: false,
    micDeviceId: null,
    cameraDeviceId: null,
  });

  // Tick the recording timer.
  useEffect(() => {
    if (phase !== "recording") return;
    if (pausedAt !== null) return; // freeze while paused
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [phase, pausedAt]);

  // Resize the HUD window when entering/leaving the recording pill so the
  // small pill isn't pinned to the giant idle bar's footprint. Re-center
  // after each resize — `setSize` keeps the top-left anchored, which would
  // otherwise leave the pill off to one side of where the idle bar sat.
  useEffect(() => {
    const win = getCurrentWindow();
    const target = phase === "recording" ? HUD_REC_SIZE : HUD_IDLE_SIZE;
    void (async () => {
      try {
        await win.setSize(target);
        await win.center();
      } catch {}
    })();
  }, [phase]);

  // Listen for picker open/close + selection.
  useEffect(() => {
    const offState = native.onPickerState((s) => setPickerOpen(s === "open"));
    const offSel = native.onPickerSelected((sel) => {
      setError(null);
      setPending({ displayId: sel.displayId, windowId: sel.windowId, av: avSettings, crop: sel.crop });
      setPhase("countdown");
    });
    return () => {
      void offState.then((f) => f());
      void offSel.then((f) => f());
    };
  }, [avSettings]);

  const openPicker = (mode: "display" | "window" | "area", av: CaptureAVSettings) => {
    setAvSettings(av);
    void native.openPickerOverlays(mode).catch((e) => setError(String(e)));
  };

  const closePicker = () => {
    void native.closePickerOverlays().catch((e) => setError(String(e)));
  };

  const finishCountdown = async () => {
    if (!pending) return;
    try {
      await native.startCapture({
        displayId: pending.displayId,
        windowId: pending.windowId,
        systemAudio: pending.av.systemAudio,
        micDeviceId: pending.av.micDeviceId,
        cameraDeviceId: pending.av.cameraDeviceId,
        framerate: 30,
        crop: pending.crop,
      });
      setRecStart(Date.now());
      setPhase("recording");
    } catch (e) {
      setError(String(e));
      setPhase("idle");
    }
  };

  const resetRecordingState = () => {
    setRecStart(null);
    setPending(null);
    setPausedAt(null);
    setPausedAccumMs(0);
  };

  const handoffArtifact = async (artifact: CaptureArtifact) => {
    await native.openEditorWithArtifact(artifact);
    setPhase("idle");
    resetRecordingState();
    // The Rust side hides this HUD window after handing off.
  };

  const stopRecording = async () => {
    try {
      const artifact = await native.stopCapture();
      await handoffArtifact(artifact);
    } catch (e) {
      setError(String(e));
      setPhase("idle");
      resetRecordingState();
    }
  };

  const togglePause = async () => {
    try {
      if (pausedAt === null) {
        await native.pauseCapture();
        setPausedAt(Date.now());
      } else {
        await native.resumeCapture();
        setPausedAccumMs((m) => m + (Date.now() - pausedAt));
        setPausedAt(null);
        setNow(Date.now());
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const restartRecording = async () => {
    try {
      await native.restartCapture();
      setRecStart(Date.now());
      setPausedAt(null);
      setPausedAccumMs(0);
      setNow(Date.now());
    } catch (e) {
      setError(String(e));
      setPhase("idle");
      resetRecordingState();
    }
  };

  const cancelRecording = async () => {
    try {
      await native.cancelCapture();
    } catch (e) {
      setError(String(e));
    }
    setPhase("idle");
    resetRecordingState();
  };

  // Honor the macOS menu-bar stop pill: when SCK reports the stream was
  // stopped externally, run the same end-of-recording flow as the in-app pill.
  useEffect(() => {
    const off = native.onRecordingStoppedExternally(async () => {
      if (phase !== "recording") return;
      try {
        const artifact = await native.finalizeExternalStop();
        await handoffArtifact(artifact);
      } catch (e) {
        setError(String(e));
        setPhase("idle");
      }
    });
    return () => {
      void off.then((f) => f());
    };
  }, [phase]);

  return (
    <>
      {phase === "idle" && (
        <CaptureHUD
          onOpenPicker={openPicker}
          onClosePicker={closePicker}
          pickerOpen={pickerOpen}
        />
      )}
      {phase === "countdown" && <Countdown from={3} onDone={finishCountdown} />}
      {phase === "recording" && (
        <RecordingPill
          elapsedMs={
            recStart
              ? (pausedAt ?? now) - recStart - pausedAccumMs
              : 0
          }
          paused={pausedAt !== null}
          onStop={stopRecording}
          onPauseToggle={togglePause}
          onRestart={restartRecording}
          onCancel={cancelRecording}
        />
      )}
      {error && (
        <div className="hud-stage" style={{ pointerEvents: "none" }}>
          <div
            style={{
              position: "absolute",
              bottom: 12,
              fontSize: 11,
              color: "#ff8a8a",
              background: "rgba(0,0,0,0.6)",
              padding: "4px 10px",
              borderRadius: 6,
            }}
          >
            {error}
          </div>
        </div>
      )}
    </>
  );
}

export default function App() {
  useAccent("Brand Blue");
  const [themeMode, setThemeMode] = useThemeMode();
  const label = getCurrentWindow().label;
  const themed = label === "editor" || label === "permissions";
  // HUD and picker overlays float over live screen content — keep them dark
  // regardless of the user's app theme.
  useTheme(themed ? themeMode : "dark");
  if (label === "editor")
    return <Editor themeMode={themeMode} setThemeMode={setThemeMode} />;
  if (label === "permissions") return <Permissions />;
  if (label.startsWith("picker-")) return <PickerOverlay />;
  return <HudWindow />;
}
