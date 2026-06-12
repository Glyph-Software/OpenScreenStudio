# AGENTS.md

Guidance for AI coding agents working on **OpenScreen Studio** — an open-source macOS clone of [screen.studio](https://screen.studio).

## What this is

Tauri 2 desktop app. React 19 + TypeScript + Vite frontend, Rust backend. There is **no single React state machine** — `App.tsx` routes purely by the native window label:

- **permissions** (720×760) — onboarding screen shown when screen-recording or accessibility is missing.
- **hud** (900×75 idle, 560×64 during the countdown pill, 260×52 while recording) — small frameless always-on-top bar; its internal `HudPhase` is `idle | countdown | recording`. The ✕ button quits the app via `quit_app` (unless the editor window is visible, in which case it only hides the HUD).
- **editor** (1440×900, min 1100×700) — the full editor; hidden until a recording finishes.
- **picker-\*** — dynamically-created transparent overlay windows (one per display) used to pick a display / window / drag-area before recording.
- **camera-preview** — floating live webcam preview shown while the HUD's camera toggle is on; rendered via `getUserMedia` in `CameraPreview.tsx` (the device is matched by label, not deviceId).

On launch the Rust `setup` hook reads `check_permissions` (`CGPreflightScreenCaptureAccess()` for screen recording, `AXIsProcessTrusted()` for accessibility — the latter is required for cursor tracking). If either is missing the permissions window is shown, otherwise the hud is. macOS only (entitlements + Info.plist target macOS 13+; ScreenCaptureKit recording path needs macOS 15+).

The UI was ported from a Claude Design handoff bundle. **Capture is real and in-process:**

- **Screen recording: ScreenCaptureKit**, entirely in-process via the `screencapturekit` crate (`macos_15_0` feature). An `SCStream` + `SCRecordingOutput` writes mp4 directly. Supports display, window, and cropped-area capture, plus pause / resume / restart / cancel (pause/restart segments are concatenated with the bundled ffmpeg on stop).
- **AV sidecar tracks.** System audio and microphone are captured through the same SCK stream (`SCStreamOutputType::Audio` / `::Microphone`) and written to sidecar WAVs; the camera records to a sidecar movie via `camera.rs` (AVFoundation `AVCaptureDevice` by uniqueID). The artifact carries `systemAudioPath` / `cameraPath` (+ offsets) alongside the screen mp4. All three sources are **off by default** on every launch; only the chosen device ids persist (localStorage). Each HUD toggle checks its TCC permission at toggle time.
- **Device enumeration is native** — microphones via the SCK bridge's `AudioInputDevice::list()`, cameras via `camera::list_camera_devices()`. No ffmpeg parsing.
- **Cursor sidecar.** During recording a `CursorTrack` polls cursor position, clicks, and cursor-*shape* transitions; on stop it writes a `<recording>.cursor.json` next to the mp4 (`cursorSidecarPathFor`). The editor consumes this for auto-zoom-on-click.
- **Mic-level metering:** `cpal` default input, peak amplitude emitted as `mic-level` events at ~30 Hz.
- **Artifact handoff:** `open_editor_with_artifact` shows the editor window, hides the hud, and emits `recording-artifact`; the editor loads the mp4 in a `<video>` via `convertFileSrc` (asset protocol scoped to `$HOME/Movies/**`, `$TEMP/**`, and `/System/Library/Desktop Pictures/**`).
- **External stop.** The macOS menu-bar "stop" pill ends the SCK stream out-of-band; the app gets a `recording-stopped-externally` event and runs `finalize_external_stop` to produce the same artifact.

Recordings land in `~/Movies/OpenScreen Studio/OpenScreen-<timestamp>-<uuid>.mp4` (+ matching `.cursor.json`, and audio/camera sidecar files when those sources were on).

**ffmpeg is bundled, not a `$PATH` dependency.** `scripts/fetch-ffmpeg.sh` runs on `postinstall` and downloads `src-tauri/binaries/ffmpeg-{aarch64,x86_64}-apple-darwin`; `tauri.conf.json` ships it as `externalBin: ["binaries/ffmpeg"]`. It is used for segment concat (pause/restart), muxing, and encoding exported frames — not for device enumeration or the live recording path.

**macOS permissions:** because recording is in-process via ScreenCaptureKit, the TCC screen-recording grant attaches to the **OpenScreen Studio.app bundle** (or the dev binary in `bun run tauri dev`), not to ffmpeg. Grant Screen Recording once in System Settings → Privacy & Security. Accessibility is also requested — cursor/click tracking needs it. `check_permissions` runs the screen-recording probe in a fresh subprocess because `CGPreflightScreenCaptureAccess()` caches its answer per-process.

## Toolchain

This project uses **Bun**, not npm/pnpm/yarn. Always use `bun` and `bun run`.

**Never use `npm`, `npx`, `pnpm`, `yarn`, or `pnpx`** — not even for one-off commands like `tsc` or `vite`. Use `bunx` for binaries and `bun run <script>` for package.json scripts. This applies to ad-hoc verification too (e.g. always `bunx tsc --noEmit`, never `npx tsc --noEmit`).

```sh
bun install            # install JS deps; postinstall fetches the ffmpeg binaries
bun run tauri dev      # run the desktop app (frontend + Rust)
bun run tauri build    # produce .app + .dmg in src-tauri/target/release/bundle/
bun run build          # frontend-only build (tsc && vite build)
bun run fetch-ffmpeg   # re-fetch the bundled ffmpeg binaries
bunx tsc --noEmit      # type-check
```

For Rust: `cd src-tauri && cargo check` / `cargo clippy`.

### Bumping the app version

There is no built-in Tauri version-bump command, so we ship one. It mirrors `npm version <patch|minor|major>` and keeps `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` (+ `Cargo.lock`) in sync — `tauri.conf.json > version` is what the macOS bundler reads into `CFBundleShortVersionString`.

```sh
bun run version:patch    # 0.2.1 -> 0.2.2
bun run version:minor    # 0.2.1 -> 0.3.0
bun run version:major    # 0.2.1 -> 1.0.0
bun run version 1.2.3    # explicit semver
```

The script ([`scripts/bump-version.ts`](scripts/bump-version.ts)) refuses to run on a dirty tree, edits the three files, runs `cargo update -p openscreen-studio --offline`, then `git commit -m "v<next>"` and `git tag -a v<next>`. It does **not** push — run `git push --follow-tags` yourself. All three files must already share the same base version; if they drift, hand-align them before bumping.

## Project layout

```
src/
  App.tsx                       routes by window label: editor | permissions | picker-* | hud
  main.tsx                      React entry
  components/
    CaptureHUD.tsx              pre-record HUD: mode row, camera/mic/system pills with
                                per-toggle TCC checks, gear menu (native Tauri menu with a
                                Countdown submenu: off/3/5/10s, persisted in localStorage)
    CameraPreview.tsx           floating live webcam preview (getUserMedia, matched by label)
    Permissions.tsx             onboarding: screen-recording + accessibility grant flow
    PickerOverlay.tsx           per-display overlay: pick display / window / drag an area
    Editor/index.tsx            full editor (~4400 lines): TitleBar, Viewport, IconRail,
                                Inspector, Timeline, auto-zoom, cursor overlay, save/open,
                                export (Editor/ExportDialog.tsx)
    demo/Spreadsheet.tsx        placeholder content rendered inside the editor viewport
    icons.tsx                   `Ico` namespace of monoline SVG glyphs (editor)
    hudIcons.tsx                `HudIco` namespace of glyphs used by the HUD windows
  hooks/
    useAccent.ts                applies --accent-* CSS variables from a preset name
    useTheme.ts                 light/dark theme mode (useTheme / useThemeMode)
  lib/
    native.ts                   typed Tauri command wrappers + listen helpers + sidecar types
    autoZoom.ts                 derive zoom segments from cursor-sidecar clicks
  styles/
    globals.css                 design system (~2100 lines, ported from the handoff)
    tokens.css                  CSS custom properties / design tokens
  assets/                       wallpaper.png, hero-app-ui-2.png, react.svg
  vite-env.d.ts

src-tauri/
  src/lib.rs                    ~3500 lines: SCK capture, picker, cursor sidecar, export,
                                all #[command]s
  src/camera.rs                 AVFoundation camera: enumeration, TCC auth, sidecar recorder
  src/main.rs                   thin entry; also handles --probe-screen-recording subprocess
  build.rs                      tauri-build
  binaries/                     bundled ffmpeg-{aarch64,x86_64}-apple-darwin (gitignored, fetched)
  Cargo.toml                    crate: openscreen-studio, lib: openscreen_studio_lib
  tauri.conf.json               window config + asset-protocol scope + externalBin ffmpeg
  Info.plist                    NSCameraUsageDescription, NSMicrophone…, NSScreenCapture…
  entitlements.plist            camera / audio-input / screen-capture
  capabilities/default.json     Tauri capability file
  gen/                          generated Tauri schemas

scripts/fetch-ffmpeg.sh         downloads the platform ffmpeg binaries (run on postinstall)
```

`MenuBar.tsx` no longer exists — don't reference it. The native macOS menu is built in Rust (`lib.rs`).

## Hot spots

- **Rust capture backend** — [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs). One large file (camera split into [`camera.rs`](src-tauri/src/camera.rs)). ~45 `#[tauri::command]`s grouped roughly as:
  - permissions: `check_permissions`, `request_screen_recording`, `request_accessibility`, `dismiss_permissions`, `check_camera_access`, `request_camera_access`, `check_mic_access`, `request_mic_access`, `open_privacy_settings`
  - capture: `list_capture_sources`, `start_capture`, `pause_capture`, `resume_capture`, `cancel_capture`, `restart_capture`, `stop_capture`, `finalize_external_stop`, `is_recording`
  - camera preview: `show_camera_preview`, `hide_camera_preview`, `set_camera_preview_device`
  - mic: `start_mic_meter`, `stop_mic_meter`
  - picker: `list_displays`, `list_windows`, `open_picker_overlays`, `close_picker_overlays`, `picker_select_display`, `picker_select_window`, `picker_select_area`
  - editor/project: `open_editor_with_artifact`, `open_dev_editor`, `confirm_and_discard_editor`, `present_editor`, `save_project`, `open_project`
  - export: `export_begin`, `export_frame`, `export_finish`, `export_cancel`, `pick_export_path`, `copy_file_to_clipboard`
  - wallpaper: `list_macos_wallpapers`, `current_macos_wallpaper`
  - app: `quit_app` (exit unless the editor window is visible)

  The SCK stream + recording output live in `RecordingState`; the `cpal` mic stream owns its own thread because `cpal::Stream` is `!Send` on macOS; `CursorTrack` runs a polling thread and serializes the sidecar on stop.
- **Frontend ↔ Rust bridge** — [`src/lib/native.ts`](src/lib/native.ts). The `native` object wraps every command; listen helpers: `onMicLevel`, `onRecordingArtifact`, `onRecordingStoppedExternally`, `onPickerSelected`, `onPickerState`, `onPickerHover`, `onMenuSaveProject`, `onMenuOpenProject`. Cursor-sidecar TypeScript types (`CursorSidecar`, `CursorSidecarShapeName`, …) live here too. Add new commands here, keep return types narrow.
- **Editor** — [`src/components/Editor/index.tsx`](src/components/Editor/index.tsx). The largest component. Owns video playback, timeline scrubbing, auto-zoom segments (via `lib/autoZoom.ts` + the cursor sidecar), the cursor overlay, preview-quality settings, and project save/open.
- **Auto-zoom** — [`src/lib/autoZoom.ts`](src/lib/autoZoom.ts). Pure logic: derives `ZoomSegment`s from sidecar clicks; the editor renders/edits them.
- **Design system** — [`src/styles/globals.css`](src/styles/globals.css) and [`tokens.css`](src/styles/tokens.css) are the single source of truth for colors, spacing, and component classes. **Do not** restyle components inline; reuse existing class names.
- **Accent presets** — [`src/hooks/useAccent.ts`](src/hooks/useAccent.ts). Adds `--accent`, `--accent-vibrant`, `--accent-shadow`, `--accent-foreground` to `:root`.

## Conventions

- **TypeScript everywhere**, strict. Component prop types are inline (`{ foo: string }`); no `React.FC`.
- **CSS classes drive styling.** The handoff's class names are load-bearing — preserve them. New CSS should live in `globals.css` next to its peers, not in component-local stylesheets.
- **Imports use relative paths** (no path aliases configured yet).
- **Don't add Tweaks panel / design-tool affordances.** The original handoff had a `tweaks-panel.jsx` for in-design tweaking; it was intentionally dropped.
- **macOS-only assumptions are fine.** Non-macOS builds compile but stub capture. Don't bend over backwards for Windows/Linux.
- **No new top-level deps without a reason.** Prefer the standard library / existing deps.
- **Comments**: only when the *why* is non-obvious. Don't narrate what the code does.

## End-to-end capture flow

1. HUD enumerates cameras + mics (`native.listCaptureSources`), lets the user toggle camera / mic / system audio (TCC-checked per toggle; camera opens the floating preview window), and opens the picker for a display / window / area. The resolved choices travel as `CaptureAVSettings`.
2. Picker overlays open over every display (`open_picker_overlays`). The user picks; Rust emits `picker-selected` with `{ displayId, windowId, crop }`.
3. The HUD shows a countdown pill ("Get ready…" with cancel + Continue-now); duration comes from the gear menu (off/3/5/10 s, `getCountdownSecs()` reading `oss.capture.countdownSecs`; 0 skips the pill entirely). Then it calls `native.startCapture({ displayId, windowId, systemAudio, micDeviceId, cameraDeviceId, framerate: 30, crop })`. ScreenCaptureKit starts an in-process `SCStream` writing mp4; AV sidecar tracks and the cursor track start alongside.
4. The HUD shrinks to the recording pill (resize + re-center). Pause/resume/restart/cancel are wired to the matching commands. The timer freezes while paused.
5. Stop via the in-app pill (`stop_capture`) or the macOS menu-bar pill (`recording-stopped-externally` → `finalize_external_stop`). Either returns a `CaptureArtifact { id, path, durationMs }`; the `.cursor.json` sidecar is flushed alongside.
6. `native.openEditorWithArtifact(artifact)` shows the editor, hides the HUD, emits `recording-artifact`. The editor loads `<video src={convertFileSrc(path)}>`, reads the sidecar, derives auto-zoom segments, and enables timeline scrubbing / play-pause.

## Future capture upgrades

- **Device capture mode.** The HUD's "Device" mode button exists but is disabled.
- **More gear-menu settings.** The settings menu currently has only the Countdown submenu; new app-level settings belong there (`openSettingsMenu` in `CaptureHUD.tsx`).
- **Drop the bundled ffmpeg** by doing segment concat and export encoding through AVFoundation/VideoToolbox instead.

## Verification before declaring done

- `bunx tsc --noEmit` clean.
- `bun run build` succeeds (frontend only).
- `cd src-tauri && cargo check` clean.
- `bun run tauri dev` boots and the flow `permissions (if needed) → HUD → picker → countdown → recording → editor` plays through end-to-end without console errors.
- For UI changes: actually click through to the affected screen — don't just trust the type-check. Picker overlays and the recording pill span multiple windows; exercise them.

## Things to be careful about

- **Don't revert build commands to pnpm/npm.** `tauri.conf.json` and scripts point at `bun run`. Same for any docs.
- **Don't rename `openscreen_studio_lib`.** It's referenced from `src-tauri/src/main.rs`. If you rename, update both files.
- **Don't break the `--probe-screen-recording` subprocess path** in `main.rs`/`lib.rs` — `check_permissions` relies on it to detect post-launch grants.
- **`src-tauri/binaries/ffmpeg-*` is fetched, not committed.** If capture-source enumeration fails locally, run `bun run fetch-ffmpeg`.
- **The wallpaper PNG is large (~1.6MB).** Don't bundle additional uncompressed assets without reason.
- **Rebuilt debug bundles lose TCC grants.** After a fresh `tauri dev`/debug build, macOS may require re-granting Screen Recording before recording works — recording silently failing after a rebuild is usually this, not a code bug.
