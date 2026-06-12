import { useEffect, useMemo, useState } from "react";
import { CheckMenuItem, Menu, Submenu } from "@tauri-apps/api/menu";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { HudIco } from "./hudIcons";
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

// Sentinel device-select value that turns the source off (it can't collide
// with a real device id).
const OFF_OPTION = "__off__";

// What gets recorded alongside the screen. Resolved device ids, not toggles —
// the HUD owns persistence; App just forwards this to start_capture.
export type CaptureAVSettings = {
  systemAudio: boolean;
  micDeviceId: string | null;
  cameraDeviceId: string | null;
};

// Only device *choices* persist. The camera/mic/system toggles always start
// OFF on launch, so we no longer remember their on/off state.
const LS = {
  cameraId: "oss.capture.cameraId",
  micId: "oss.capture.micId",
  countdownSecs: "oss.capture.countdownSecs",
};

export const COUNTDOWN_OPTIONS = [0, 3, 5, 10] as const;
const DEFAULT_COUNTDOWN_SECS = 3;

// Shared with App so the countdown phase reads the same persisted choice.
export const getCountdownSecs = () => {
  const v = Number(lsGet(LS.countdownSecs));
  return (COUNTDOWN_OPTIONS as readonly number[]).includes(v) ? v : DEFAULT_COUNTDOWN_SECS;
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
          <HudIco.chevronDown size={11} style={{ opacity: 0.55, flexShrink: 0 }} />
          <select
            className="pill-select"
            value={deviceId}
            onChange={(e) => {
              if (e.target.value === OFF_OPTION) onToggle();
              else onDevice(e.target.value);
            }}
            title="Choose device"
          >
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
            <option value={OFF_OPTION}>Turn off</option>
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
  // Camera/mic/system always start OFF on launch; only device choices persist.
  const [camera, setCamera] = useState(false);
  const [mic, setMic] = useState(false);
  const [system, setSystem] = useState(false);
  const [cameraId, setCameraId] = useState(() => lsGet(LS.cameraId) ?? "");
  const [micId, setMicId] = useState(() => lsGet(LS.micId) ?? "");
  const [countdownSecs, setCountdownSecs] = useState(getCountdownSecs);
  const [enumError, setEnumError] = useState<string | null>(null);
  const [permHint, setPermHint] = useState<
    { text: string; pane: "camera" | "microphone" | "screen" } | null
  >(null);

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

  const showHint = (
    text: string,
    pane: "camera" | "microphone" | "screen",
  ) => {
    setPermHint({ text, pane });
    window.setTimeout(() => setPermHint(null), 6000);
  };

  // Camera toggle: gate on TCC, only flip on once access is granted, and bring
  // up / tear down the floating preview window.
  const setCameraOn = async (v: boolean) => {
    setPermHint(null);
    if (!v) {
      setCamera(false);
      void native.hideCameraPreview().catch(() => {});
      return;
    }
    let status = await native.checkCameraAccess().catch(() => "denied" as const);
    if (status === "notDetermined") {
      const granted = await native.requestCameraAccess().catch(() => false);
      status = granted ? "authorized" : "denied";
    }
    if (status !== "authorized") {
      showHint(
        "Camera access is off. Enable it in System Settings → Privacy & Security → Camera.",
        "camera",
      );
      return;
    }
    setCamera(true);
    void native.showCameraPreview(activeCamera?.label ?? null).catch(() => {});
  };

  const setMicOn = async (v: boolean) => {
    setPermHint(null);
    if (!v) {
      setMic(false);
      return;
    }
    let status = await native.checkMicAccess().catch(() => "denied" as const);
    if (status === "notDetermined") {
      const granted = await native.requestMicAccess().catch(() => false);
      status = granted ? "authorized" : "denied";
    }
    if (status !== "authorized") {
      showHint(
        "Microphone access is off. Enable it in System Settings → Privacy & Security → Microphone.",
        "microphone",
      );
      return;
    }
    setMic(true);
  };

  const setSystemOn = async (v: boolean) => {
    setPermHint(null);
    if (!v) {
      setSystem(false);
      return;
    }
    const perms = await native.checkPermissions().catch(() => null);
    if (perms?.screenRecording) {
      setSystem(true);
      return;
    }
    // Triggers the native prompt or deep-links to Settings on a repeat click.
    void native.requestScreenRecording().catch(() => {});
    showHint(
      "Screen Recording permission is required for system audio.",
      "screen",
    );
  };

  const chooseCamera = (id: string) => {
    setCameraId(id);
    lsSet(LS.cameraId, id);
    // Keep the live preview in sync when the user switches camera.
    if (camera) {
      const next = cameras.find((d) => d.id === id);
      void native.setCameraPreviewDevice(next?.label ?? null).catch(() => {});
    }
  };
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

  const close = () => { void native.quitApp().catch(() => getCurrentWindow().hide()); };

  // Native popup so "Countdown" can host a real submenu (a <select> can't
  // nest); macOS draws it outside the tiny HUD window.
  const openSettingsMenu = async () => {
    try {
      const countdownItems = await Promise.all(
        COUNTDOWN_OPTIONS.map((s) =>
          CheckMenuItem.new({
            id: `countdown-${s}`,
            text: s === 0 ? "Off (start immediately)" : `${s} seconds`,
            checked: s === countdownSecs,
            action: () => {
              setCountdownSecs(s);
              lsSet(LS.countdownSecs, String(s));
            },
          }),
        ),
      );
      const countdown = await Submenu.new({ text: "Countdown", items: countdownItems });
      const menu = await Menu.new({ items: [countdown] });
      await menu.popup();
    } catch (e) {
      setEnumError(String(e));
    }
  };

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
            <HudIco.close size={13} />
          </button>

          <div className="mode-row">
            <ModeBtn id="display" label="Display" icon={<HudIco.display size={20} />} />
            <ModeBtn id="window" label="Window" icon={<HudIco.window size={20} />} />
            <ModeBtn id="area" label="Area" icon={<HudIco.area size={20} />} />
            <ModeBtn id="device" label="Device" icon={<HudIco.device size={20} />} disabled />
          </div>

          <div className="divider" />

          <SourcePill
            className="pill-camera"
            on={camera && !!activeCamera}
            onToggle={() => setCameraOn(!(camera && !!activeCamera))}
            iconOn={<HudIco.camera size={16} />}
            iconOff={<HudIco.cameraOff size={16} />}
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
            iconOn={<HudIco.mic size={16} />}
            iconOff={<HudIco.micOff size={16} />}
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
            iconOn={<HudIco.systemAudio size={16} />}
            iconOff={<HudIco.systemAudioOff size={16} />}
            label={systemLabel}
          />

          <div className="divider" />

          <button className="hud-gear" title="Settings" onClick={() => void openSettingsMenu()}>
            <HudIco.settings size={16} />
            <HudIco.chevronDown size={11} style={{ opacity: 0.7 }} />
          </button>
        </div>
        {enumError && (
          <div className="hud-label" style={{ color: "#ff8a8a" }}>
            {enumError}
          </div>
        )}
        {permHint && (
          <div className="hud-label hud-perm-hint">
            <span>{permHint.text}</span>
            <button
              className="hud-perm-settings"
              onClick={() => void native.openPrivacySettings(permHint.pane)}
            >
              Open Settings
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
