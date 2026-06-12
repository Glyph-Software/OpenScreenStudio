import { getCurrentWindow } from "@tauri-apps/api/window";
import { CameraPreview } from "./components/CameraPreview";
import { Editor } from "./components/Editor";
import { HudWindow } from "./components/HudWindow";
import { Permissions } from "./components/Permissions";
import { PickerOverlay } from "./components/PickerOverlay";
import { useAccent } from "./hooks/useAccent";
import { useTheme, useThemeMode } from "./hooks/useTheme";
import "./styles/globals.css";

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
  if (label === "camera-preview") return <CameraPreview />;
  if (label.startsWith("picker-")) return <PickerOverlay />;
  return <HudWindow />;
}
