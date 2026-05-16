# Contributing to OpenScreen Studio

Thank you for your interest in contributing. OpenScreen Studio is a macOS desktop app (Tauri 2 + React 19 + Rust) that records the screen in-process via ScreenCaptureKit and edits recordings in a built-in editor.

## Prerequisites

- **macOS 13+** for development (the ScreenCaptureKit recording path requires **macOS 15+**).
- **[Bun](https://bun.sh)** — this repo uses Bun exclusively for JavaScript tooling.
- **Rust** (stable) and Xcode command-line tools for the Tauri backend.

Grant **Screen Recording** and **Accessibility** in System Settings → Privacy & Security when testing capture or cursor tracking.

## Getting started

```sh
git clone <your-fork-url>
cd OpenScreenStudio
bun install
bun run tauri dev
```

If audio-device enumeration fails, bundled ffmpeg may be missing: `bun run fetch-ffmpeg`.

## What to work on

Check [open issues](https://github.com/Glyph-Software/OpenScreenStudio/issues) or the **Roadmap** in [README.md](./README.md). Good first contributions include docs, UI polish, bug fixes, and small features that do not require deep ScreenCaptureKit knowledge.

For architecture and capture flow, see [AGENTS.md](./AGENTS.md).

## Development workflow

1. **Fork** the repository and create a branch from `main` (e.g. `fix/hud-timer-pause`, `feat/system-audio`).
2. **Make focused changes** — one logical change per pull request when possible.
3. **Follow project conventions** (summary below; details in [AGENTS.md](./AGENTS.md)).
4. **Verify locally** before opening a PR.
5. **Open a pull request** with a clear description, screenshots or screen recordings for UI changes, and steps to reproduce for bug fixes.

## Toolchain rules

| Do | Don't |
|----|--------|
| `bun install`, `bun run …`, `bunx tsc` | `npm`, `npx`, `pnpm`, `yarn` |
| `cd src-tauri && cargo check` / `cargo clippy` | Rename `openscreen_studio_lib` without updating `main.rs` |
| Reuse classes in `globals.css` / `tokens.css` | Inline styles or new component-local CSS files |
| Add Tauri commands in `lib.rs` **and** `src/lib/native.ts` | Break `--probe-screen-recording` in `main.rs` |

## Code conventions

- **TypeScript**, strict mode. Inline prop types; no `React.FC`.
- **Relative imports** (no path aliases yet).
- **CSS via design-system classes** — preserve handoff class names; add new rules next to peers in `globals.css`.
- **macOS-first** — non-macOS builds may stub capture; don't block macOS features for cross-platform parity unless discussed first.
- **Avoid new dependencies** unless they clearly reduce complexity.
- **Comments** only for non-obvious *why*, not narration.

New Rust `#[tauri::command]` handlers belong in `src-tauri/src/lib.rs` with matching typed wrappers in `src/lib/native.ts`.

## Verification checklist

Before submitting a PR, run:

```sh
bunx tsc --noEmit
bun run build
cd src-tauri && cargo check
```

For changes that touch capture, the picker, HUD, or editor:

```sh
bun run tauri dev
```

Exercise: permissions (if needed) → HUD → picker → countdown → record → stop → editor. For UI work, click through every affected window (HUD, picker overlays, editor).

## Pull request guidelines

- Keep PRs reasonably small and reviewable.
- Describe **what** changed and **why**.
- Link related issues (`Fixes #123` when applicable).
- Include before/after visuals for UI changes.
- Do not commit secrets, `.env` files, or generated `src-tauri/binaries/ffmpeg-*` blobs (they are fetched by `postinstall`).

Maintainers may request changes or suggest splitting large PRs. Be patient — capture and multi-window UI can be tricky to review.

## Reporting bugs

Open an issue with:

- macOS version
- Steps to reproduce
- Expected vs actual behavior
- Relevant logs (Tauri dev console, terminal output)
- Screenshots or short screen recordings when helpful

## Questions

- **Architecture / agent-oriented notes:** [AGENTS.md](./AGENTS.md)
- **Project contact:** [glyphsoftware.org](https://glyphsoftware.org) · [contact@glyphsoftware.org](mailto:contact@glyphsoftware.org)

We appreciate every contribution — from typo fixes to major features.
