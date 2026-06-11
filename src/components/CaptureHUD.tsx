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

// What gets recorded alongside the screen. Resolved device ids, not toggles —
// the HUD owns persistence; App just forwards this to start_capture.
export type CaptureAVSettings = {
  systemAudio: boolean;
  micDeviceId: string | null;
  cameraDeviceId: string | null;
};

const LS = {
  camera: "oss.capture.cameraOn",
  mic: "oss.capture.micOn",
  system: "oss.capture.systemOn",
  cameraId: "oss.capture.cameraId",
  micId: "oss.capture.micId",
};

const lsGet = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const lsSet = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {}
};

/// A camera/mic/system pill: the button toggles the source on/off and an
/// invisible native <select> over the label picks the device (macOS renders
/// its menu as an OS popup, so it isn't clipped by the tiny HUD window).
function SourcePill({
  className,
  on,
  onToggle,
  iconOn,
  iconOff,
  label,
  devices,
  deviceId,
  onDevice,
  disabled,
  tip,
}: {
  className: string;
  on: boolean;
  onToggle: () => void;
  iconOn: React.ReactNode;
  iconOff: React.ReactNode;
  label: string;
  devices?: CaptureSource[];
  deviceId?: string;
  onDevice?: (id: string) => void;
  disabled?: boolean;
  tip?: string;
}) {
  const selectable = on && !disabled && devices && devices.length > 1 && onDevice;
  return (
    <div
      className={`status-pill ${className} ${on ? "on" : ""} ${disabled ? "disabled" : ""}`}
      {...(tip ? { "data-tip": tip } : {})}
    >
      <button
        className="pill-toggle"
        onClick={() => !disabled && onToggle()}
        disabled={disabled}
        title={on ? "Turn off" : "Turn on"}
      >
        {on ? iconOn : iconOff}
      </button>
      <span className="pill-label" onClick={() => !disabled && !selectable && onToggle()}>
        {label}
      </span>
      {selectable && (
        <>
          <Ico.chevDown size={11} style={{ opacity: 0.55, flexShrink: 0 }} />
          <select
            className="pill-select"
            value={deviceId}
            onChange={(e) => onDevice(e.target.value)}
            title="Choose device"
          >
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </>
      )}
    </div>
  );
}

export function CaptureHUD({
  onOpenPicker,
  onClosePicker,
  pickerOpen,
}: {
  onOpenPicker: (mode: "display" | "window" | "area", av: CaptureAVSettings) => void;
  onClosePicker: () => void;
  pickerOpen: boolean;
}) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [camera, setCamera] = useState(() => lsGet(LS.camera) === "1");
  const [mic, setMic] = useState(() => lsGet(LS.mic) === "1");
  const [system, setSystem] = useState(() => lsGet(LS.system) === "1");
  const [cameraId, setCameraId] = useState(() => lsGet(LS.cameraId) ?? "");
  const [micId, setMicId] = useState(() => lsGet(LS.micId) ?? "");
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

  // Resolve persisted device choices against what's actually connected:
  // fall back to the default (or first) device when the saved one is gone.
  const pickDevice = (list: CaptureSource[], saved: string) =>
    list.find((d) => d.id === saved) ?? list.find((d) => d.isDefault) ?? list[0] ?? null;
  const activeCamera = pickDevice(cameras, cameraId);
  const activeMic = pickDevice(audios, micId);

  const setCameraOn = (v: boolean) => {
    setCamera(v);
    lsSet(LS.camera, v ? "1" : "0");
    // Resolve the TCC prompt now, not mid-recording-countdown.
    if (v) void native.requestCameraAccess().catch(() => {});
  };
  const setMicOn = (v: boolean) => { setMic(v); lsSet(LS.mic, v ? "1" : "0"); };
  const setSystemOn = (v: boolean) => { setSystem(v); lsSet(LS.system, v ? "1" : "0"); };
  const chooseCamera = (id: string) => { setCameraId(id); lsSet(LS.cameraId, id); };
  const chooseMic = (id: string) => { setMicId(id); lsSet(LS.micId, id); };

  const cameraLabel = camera ? (activeCamera?.label ?? "No camera") : "No camera";
  const micLabel = mic ? (activeMic?.label ?? "No microphone") : "No microphone";
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
    onOpenPicker(m, {
      systemAudio: system,
      micDeviceId: mic ? (activeMic?.id ?? null) : null,
      cameraDeviceId: camera ? (activeCamera?.id ?? null) : null,
    });
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

          <SourcePill
            className="pill-camera"
            on={camera && !!activeCamera}
            onToggle={() => setCameraOn(!(camera && !!activeCamera))}
            iconOn={<Ico.camera size={16} sw={1.6} />}
            iconOff={<Ico.cameraSlash size={16} sw={1.6} />}
            label={cameraLabel}
            devices={cameras}
            deviceId={activeCamera?.id}
            onDevice={chooseCamera}
            disabled={cameras.length === 0}
            tip={cameras.length === 0 ? "No camera detected" : undefined}
          />

          <SourcePill
            className="pill-mic"
            on={mic && !!activeMic}
            onToggle={() => setMicOn(!(mic && !!activeMic))}
            iconOn={<Ico.mic size={16} sw={1.6} />}
            iconOff={<Ico.micSlash size={16} sw={1.6} />}
            label={micLabel}
            devices={audios}
            deviceId={activeMic?.id}
            onDevice={chooseMic}
            disabled={audios.length === 0}
            tip={audios.length === 0 ? "No microphone detected" : undefined}
          />

          <SourcePill
            className="pill-system"
            on={system}
            onToggle={() => setSystemOn(!system)}
            iconOn={<Ico.systemAudio size={16} sw={1.6} />}
            iconOff={<Ico.systemAudioSlash size={16} sw={1.6} />}
            label={systemLabel}
          />

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
