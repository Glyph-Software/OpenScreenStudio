<div align="center">

<img src="logo.png" alt="OpenScreen Studio" width="128" />

# OpenScreen Studio

An open-source [Screen Studio](https://screen.studio) clone for macOS, built with Tauri 2 + React 19 + TypeScript.

</div>

Real, in-process screen capture via **ScreenCaptureKit** with a polished editor: auto-zoom-on-click, cursor overlay, wallpaper backgrounds, and project save/open. macOS only.

## Run

```sh
bun install            # installs JS deps; postinstall fetches bundled ffmpeg binaries
bun run tauri dev      # run the desktop app (frontend + Rust)
```

> This project uses **Bun**. Never use `npm`/`npx`/`pnpm`/`yarn` — use `bunx <bin>` and `bun run <script>`.

On first launch, if Screen Recording or Accessibility permissions are missing, an onboarding window appears. Grant both in System Settings → Privacy & Security (Accessibility is needed for cursor/click tracking). Otherwise the Capture HUD opens — pick a display / window / area, then record. Recording finishes into the editor.

## Build

```sh
bun run tauri build    # produces .app + .dmg in src-tauri/target/release/bundle/
bun run build          # frontend-only build (tsc && vite build)
bunx tsc --noEmit      # type-check
```

For Rust: `cd src-tauri && cargo check` / `cargo clippy`.

The bundle ships `entitlements.plist` (camera / audio-input / screen-capture) and usage strings in `Info.plist`. Requires macOS 13+ (the ScreenCaptureKit recording path needs macOS 15+).

## How capture works

- **Screen recording: ScreenCaptureKit**, entirely in-process via the `screencapturekit` crate. An `SCStream` + `SCRecordingOutput` writes mp4 directly — no ffmpeg sidecar in the recording path. Supports display, window, and cropped-area capture, plus pause / resume / restart / cancel.
- **Audio source enumeration** parses `ffmpeg -f avfoundation -list_devices`; capture itself uses ScreenCaptureKit's built-in microphone path.
- **Cursor sidecar.** During recording a `CursorTrack` records cursor position, clicks, and cursor-shape transitions, then writes a `<recording>.cursor.json` next to the mp4. The editor consumes this for auto-zoom-on-click and the cursor overlay.
- **Mic metering:** `cpal` samples the default input and emits peak amplitude as `mic-level` events at ~30 Hz.

Recordings land in `~/Movies/OpenScreen Studio/OpenScreen-<timestamp>-<uuid>.mp4` (+ matching `.cursor.json`).

**ffmpeg is bundled, not a `$PATH` dependency.** `scripts/fetch-ffmpeg.sh` runs on `postinstall` and downloads `src-tauri/binaries/ffmpeg-{aarch64,x86_64}-apple-darwin`, used only for audio-device enumeration.

## Layout

There is **no single React state machine** — `App.tsx` routes purely by the native window label:

- **permissions** — onboarding for screen-recording + accessibility grants.
- **hud** — small frameless always-on-top bar (`idle | countdown | recording`).
- **editor** (1440×900) — the full editor; hidden until a recording finishes.
- **picker-\*** — transparent per-display overlays for picking a display / window / drag-area.

```
src/
  App.tsx                  routes by window label: editor | permissions | picker-* | hud
  components/
    CaptureHUD.tsx         pre-record HUD (source, webcam/mic/system pills, record btn)
    Permissions.tsx        onboarding grant flow
    PickerOverlay.tsx      per-display overlay: pick display / window / drag an area
    Editor/index.tsx       full editor (~3200 lines): viewport, inspector, timeline,
                           auto-zoom, cursor overlay, save/open
  hooks/                   useAccent, useTheme
  lib/
    native.ts              typed Tauri command wrappers + listen helpers + sidecar types
    autoZoom.ts            derive zoom segments from cursor-sidecar clicks
  styles/                  globals.css + tokens.css (design system, ported from handoff)

src-tauri/
  src/lib.rs               ~2500 lines: SCK capture, picker, cursor sidecar, ~37 #[command]s
  src/main.rs              thin entry; handles --probe-screen-recording subprocess
  tauri.conf.json          window config + asset-protocol scope + externalBin ffmpeg
  Info.plist               camera / microphone / screen-capture usage strings
  entitlements.plist       camera / audio-input / screen-capture

scripts/fetch-ffmpeg.sh    downloads the platform ffmpeg binaries (run on postinstall)
```

See [AGENTS.md](./AGENTS.md) for deeper architecture notes.

## Roadmap

- Webcam capture and compositing.
- System-audio capture.
- Real export pipeline (the Export button currently `alert()`s).
- Richer timeline editing and effects.

## Contributing

Contributions are welcome — bug reports, docs, UI polish, and features. See **[CONTRIBUTION.md](./CONTRIBUTION.md)** for prerequisites, setup, conventions, and the pull-request checklist. For deeper architecture notes, see [AGENTS.md](./AGENTS.md).

## About

Built and maintained by **[Glyph Software LLP](https://glyphsoftware.org)** — _Crafting Scalable Solutions for Modern Needs_. We build AI-powered and custom software: web/mobile, cloud infrastructure, data analytics, and generative AI systems, for startups and enterprises. Based in Bengaluru, India.

- Website: [glyphsoftware.org](https://glyphsoftware.org)
- Email: [contact@glyphsoftware.org](mailto:contact@glyphsoftware.org)
- GitHub: [Glyph-Software](https://github.com/Glyph-Software)
- LinkedIn: [Glyph Software](https://www.linkedin.com/company/glyph-software)
- Hugging Face: [glyphsoftware](https://huggingface.co/glyphsoftware)
