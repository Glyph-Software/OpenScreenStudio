import type { LucideProps } from "lucide-react";
import {
  AppWindow,
  Camera,
  CameraOff,
  ChevronDown,
  CirclePause,
  CirclePlay,
  CircleStop,
  Mic,
  MicOff,
  Monitor,
  MonitorOff,
  MonitorSpeaker,
  RotateCcw,
  Scan,
  Settings,
  Smartphone,
  Trash2,
  X,
} from "lucide-react";

type HudIconProps = Omit<LucideProps, "ref">;

/** Lucide icons tuned for the capture HUD — consistent stroke + optical sizing. */
export const HudIco = {
  close: (p: HudIconProps) => <X className="hud-lucide" strokeWidth={2.25} {...p} />,
  display: (p: HudIconProps) => <Monitor className="hud-lucide" strokeWidth={1.65} {...p} />,
  window: (p: HudIconProps) => <AppWindow className="hud-lucide" strokeWidth={1.65} {...p} />,
  area: (p: HudIconProps) => <Scan className="hud-lucide" strokeWidth={1.65} {...p} />,
  device: (p: HudIconProps) => <Smartphone className="hud-lucide" strokeWidth={1.65} {...p} />,
  camera: (p: HudIconProps) => <Camera className="hud-lucide" strokeWidth={1.75} {...p} />,
  cameraOff: (p: HudIconProps) => <CameraOff className="hud-lucide" strokeWidth={1.75} {...p} />,
  mic: (p: HudIconProps) => <Mic className="hud-lucide" strokeWidth={1.75} {...p} />,
  micOff: (p: HudIconProps) => <MicOff className="hud-lucide" strokeWidth={1.75} {...p} />,
  systemAudio: (p: HudIconProps) => <MonitorSpeaker className="hud-lucide" strokeWidth={1.75} {...p} />,
  systemAudioOff: (p: HudIconProps) => <MonitorOff className="hud-lucide" strokeWidth={1.75} {...p} />,
  settings: (p: HudIconProps) => <Settings className="hud-lucide" strokeWidth={1.75} {...p} />,
  chevronDown: (p: HudIconProps) => <ChevronDown className="hud-lucide" strokeWidth={2.25} {...p} />,
  stop: (p: HudIconProps) => <CircleStop className="hud-lucide" strokeWidth={2} {...p} />,
  play: (p: HudIconProps) => <CirclePlay className="hud-lucide" strokeWidth={1.75} {...p} />,
  pause: (p: HudIconProps) => <CirclePause className="hud-lucide" strokeWidth={1.75} {...p} />,
  restart: (p: HudIconProps) => <RotateCcw className="hud-lucide" strokeWidth={1.85} {...p} />,
  trash: (p: HudIconProps) => <Trash2 className="hud-lucide" strokeWidth={1.75} {...p} />,
};
