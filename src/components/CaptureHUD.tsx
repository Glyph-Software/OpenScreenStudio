import { useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Ico } from "./icons";
import { native, type CaptureSource } from "../lib/native";

const startWindowDrag = (e: React.MouseEvent) => {
  if ((e.target as HTMLElement).closest("button, kbd, input, a, [role='button'], select")) {
    return;
  }
  if (e.button !== 0) return;
  e.preventDefault();
  void getCurrentWindow().startDragging();
};

type Mode = "display" | "window" | "area" | "device";

export function CaptureHUD({
  onOpenPicker,
  onClosePicker,
  pickerOpen,
}: {
  onOpenPicker: (mode: "display" | "window" | "area", audioIndex: number | null) => void;
  onClosePicker: () => void;
  pickerOpen: boolean;
}) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [camera] = useState(false);
  const [mic] = useState(false);
  const [system] = useState(false);
  const [enumError, setEnumError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    native.listCaptureSources()
      .then((list) => { if (!cancelled) setSources(list); })
      .catch((e) => setEnumError(String(e)));
    return () => { cancelled = true; };
  }, []);

  const cameras = useMemo(() => sources.filter((s) => s.kind === "camera"), [sources]);
  const audios = useMemo(() => sources.filter((s) => s.kind === "audio"), [sources]);

  const cameraLabel = camera && cameras[0] ? cameras[0].label : "No camera";
  const micLabel = mic && audios[0] ? audios[0].label : "No microphone";
  const systemLabel = system ? "System audio" : "No system audio";

  // Reset mode highlight when the picker closes for any reason (Esc, selection, etc.).
  useEffect(() => {
    if (!pickerOpen) setMode(null);
  }, [pickerOpen]);

  const startWithMode = (m: Mode) => {
    // Toggle off if the user clicks the already-selected mode.
    if (mode === m) {
      setMode(null);
      onClosePicker();
      return;
    }
    setMode(m);
    if (m !== "display" && m !== "window" && m !== "area") return;
    const audioIndex = mic && audios[0] ? audios[0].index : null;
    onOpenPicker(m, audioIndex);
  };

  const close = () => { void getCurrentWindow().hide(); };

  const ModeBtn = ({ id, icon, label, disabled }: { id: Mode; icon: React.ReactNode; label: string; disabled?: boolean }) => (
    <button
      className={`mode-btn ${mode === id ? "on" : ""}`}
      onClick={() => !disabled && startWithMode(id)}
      disabled={disabled}
    >
      <span className="mode-icon">{icon}</span>
      <span className="mode-label">{label}</span>
    </button>
  );

  return (
    <div className="hud-stage" onMouseDown={startWindowDrag}>
      <div style={{ position: "relative" }} onMouseDown={startWindowDrag}>
        <div className="hud hud-v2" onMouseDown={startWindowDrag}>
          <button className="hud-close" onClick={close} title="Close">
            <Ico.xMark size={13} />
          </button>

          <div className="mode-row">
            <ModeBtn id="display" label="Display" icon={<Ico.display size={20} sw={1.6} />} />
            <ModeBtn id="window" label="Window" icon={<Ico.windowApp size={20} sw={1.6} />} />
            <ModeBtn id="area" label="Area" icon={<Ico.area size={20} sw={1.6} />} />
            <ModeBtn id="device" label="Device" icon={<Ico.device size={20} sw={1.6} />} disabled />
          </div>

          <div className="divider" />

          <button
            className="status-pill pill-camera disabled"
            aria-disabled
            data-tip="Coming soon"
          >
            <Ico.cameraSlash size={16} sw={1.6} />
            <span>{cameraLabel}</span>
          </button>

          <button
            className="status-pill pill-mic disabled"
            aria-disabled
            data-tip="Coming soon"
          >
            <Ico.micSlash size={16} sw={1.6} />
            <span>{micLabel}</span>
          </button>

          <button
            className="status-pill pill-system disabled"
            aria-disabled
            data-tip="Coming soon"
          >
            <Ico.systemAudioSlash size={16} sw={1.6} />
            <span>{systemLabel}</span>
          </button>

          <div className="divider" />

          <button className="hud-gear" title="Settings">
            <Ico.gear size={16} sw={1.6} />
            <Ico.chevDown size={11} style={{ opacity: 0.7 }} />
          </button>
        </div>
        {enumError && (
          <div className="hud-label" style={{ color: "#ff8a8a" }}>
            {enumError}
          </div>
        )}
      </div>
    </div>
  );
}
