import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type CaptureSourceKind = "screen" | "camera" | "audio";

export type CaptureSource = {
  id: string;
  kind: CaptureSourceKind;
  label: string;
  index: number;
};

export type CaptureArtifact = {
  id: string;
  path: string;
  durationMs: number;
};

export type CursorSidecarSample = { tMs: number; x: number; y: number };
export type CursorSidecarClick = {
  tMs: number;
  x: number;
  y: number;
  button: "left" | "right" | "other";
  kind: "down" | "up";
};
// Known macOS system cursor shapes. Names mirror CSS `cursor` keywords where
// one exists. "unknown" = a non-standard/app-custom cursor we couldn't match.
export type CursorSidecarShapeName =
  | "arrow"
  | "text"
  | "verticalText"
  | "pointer"
  | "grab"
  | "grabbing"
  | "crosshair"
  | "notAllowed"
  | "alias"
  | "copy"
  | "contextMenu"
  | "disappearingItem"
  | "resizeLeft"
  | "resizeRight"
  | "resizeLeftRight"
  | "resizeUp"
  | "resizeDown"
  | "resizeUpDown"
  | "unknown";
// Shape transitions only. The shape in effect at time `t` is the last entry
// whose `tMs <= t`.
export type CursorSidecarShape = { tMs: number; shape: CursorSidecarShapeName };
export type CursorSidecar = {
  version: number;
  recordingId: string;
  startedEpochMs: number;
  durationMs: number;
  display: {
    id: number;
    originX: number;
    originY: number;
    width: number;
    height: number;
    scaleFactor: number;
  };
  crop: CropRect | null;
  samples: CursorSidecarSample[];
  clicks: CursorSidecarClick[];
  cursorShapes: CursorSidecarShape[];
};

export function cursorSidecarPathFor(artifact: CaptureArtifact): string {
  return artifact.path.replace(/\.mp4$/i, ".cursor.json");
}

export type CropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type StartCaptureArgs = {
  displayId: number;
  windowId?: number | null;
  audioIndex: number | null;
  framerate?: number;
  crop?: CropRect | null;
};

export type PermissionsStatus = {
  screenRecording: boolean;
  accessibility: boolean;
};

export type DisplayInfo = {
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
  refreshHz: number;
  isMain: boolean;
};

export type PickerSelection = {
  displayId: number;
  windowId: number | null;
  crop: CropRect | null;
};

export type PickerMode = "display" | "window" | "area";

export type AreaSelection = {
  displayId: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type WindowInfo = {
  id: number;
  owner: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  displayId: number;
};

export type PickerHover =
  | { mode: "display"; displayId: number | null }
  | {
      mode: "window";
      displayId: number | null;
      windowId: number | null;
      owner: string | null;
      title: string | null;
      rect: { x: number; y: number; w: number; h: number } | null;
    };

export type MacWallpaper = {
  name: string;
  thumb: string;
  full: string;
};

export const native = {
  listMacWallpapers: () => invoke<MacWallpaper[]>("list_macos_wallpapers"),
  currentMacWallpaper: () => invoke<string | null>("current_macos_wallpaper"),
  listCaptureSources: () => invoke<CaptureSource[]>("list_capture_sources"),
  startCapture: (args: StartCaptureArgs) =>
    invoke<string>("start_capture", { args }),
  stopCapture: () => invoke<CaptureArtifact>("stop_capture"),
  pauseCapture: () => invoke<void>("pause_capture"),
  resumeCapture: () => invoke<void>("resume_capture"),
  cancelCapture: () => invoke<void>("cancel_capture"),
  restartCapture: () => invoke<string>("restart_capture"),
  finalizeExternalStop: () => invoke<CaptureArtifact>("finalize_external_stop"),
  isRecording: () => invoke<boolean>("is_recording"),
  startMicMeter: () => invoke<void>("start_mic_meter"),
  stopMicMeter: () => invoke<void>("stop_mic_meter"),
  openEditorWithArtifact: (artifact: CaptureArtifact) =>
    invoke<void>("open_editor_with_artifact", { artifact }),
  openDevEditor: () => invoke<void>("open_dev_editor"),
  confirmAndDiscardEditor: () => invoke<boolean>("confirm_and_discard_editor"),

  saveProject: (defaultName: string, contents: string) =>
    invoke<string | null>("save_project", { defaultName, contents }),
  openProject: () =>
    invoke<{ path: string; contents: string } | null>("open_project"),
  presentEditor: () => invoke<void>("present_editor"),

  onMenuSaveProject: (cb: () => void): Promise<UnlistenFn> =>
    listen<null>("menu:save-project", () => cb()),
  onMenuOpenProject: (cb: () => void): Promise<UnlistenFn> =>
    listen<null>("menu:open-project", () => cb()),

  onMicLevel: (cb: (level: number) => void): Promise<UnlistenFn> =>
    listen<number>("mic-level", (e) => cb(e.payload)),

  onRecordingArtifact: (cb: (a: CaptureArtifact) => void): Promise<UnlistenFn> =>
    listen<CaptureArtifact>("recording-artifact", (e) => cb(e.payload)),

  onRecordingStoppedExternally: (cb: () => void): Promise<UnlistenFn> =>
    listen<null>("recording-stopped-externally", () => cb()),

  checkPermissions: () => invoke<PermissionsStatus>("check_permissions"),
  requestScreenRecording: () => invoke<boolean>("request_screen_recording"),
  requestAccessibility: () => invoke<boolean>("request_accessibility"),
  dismissPermissions: () => invoke<void>("dismiss_permissions"),

  listDisplays: () => invoke<DisplayInfo[]>("list_displays"),
  listWindows: () => invoke<WindowInfo[]>("list_windows"),
  openPickerOverlays: (mode: PickerMode) => invoke<void>("open_picker_overlays", { mode }),
  closePickerOverlays: () => invoke<void>("close_picker_overlays"),
  pickerSelectDisplay: (displayId: number) =>
    invoke<void>("picker_select_display", { displayId }),
  pickerSelectWindow: (windowId: number) =>
    invoke<void>("picker_select_window", { windowId }),
  pickerSelectArea: (sel: AreaSelection) =>
    invoke<void>("picker_select_area", { sel }),

  onPickerSelected: (cb: (s: PickerSelection) => void): Promise<UnlistenFn> =>
    listen<PickerSelection>("picker-selected", (e) => cb(e.payload)),
  onPickerState: (cb: (state: "open" | "closed") => void): Promise<UnlistenFn> =>
    listen<"open" | "closed">("picker-state", (e) => cb(e.payload)),
  onPickerHover: (cb: (h: PickerHover) => void): Promise<UnlistenFn> =>
    listen<PickerHover>("picker-hover", (e) => cb(e.payload)),

};
