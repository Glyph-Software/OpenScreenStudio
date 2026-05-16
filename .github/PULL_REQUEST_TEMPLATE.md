<!--
Thanks for contributing to OpenScreen Studio!
See CONTRIBUTION.md for conventions and the verification checklist.
-->

## What & why

<!-- What does this PR change, and why? Keep PRs focused — one logical change when possible. -->

## Related issues

<!-- e.g. Fixes #123 -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] UI / polish
- [ ] Docs
- [ ] Refactor / chore

## Screenshots / screen recordings

<!-- Required for any UI change. Include before/after when relevant. -->

## Verification

Ran locally before opening this PR:

- [ ] `bunx tsc --noEmit`
- [ ] `bun run build`
- [ ] `cd src-tauri && cargo check`
- [ ] For capture / picker / HUD / editor changes: exercised `bun run tauri dev` (permissions → HUD → picker → countdown → record → stop → editor)

## Checklist

- [ ] Followed project conventions (Bun only; relative imports; design-system CSS classes)
- [ ] New Tauri commands added in `src-tauri/src/lib.rs` **and** `src/lib/native.ts`
- [ ] No secrets, `.env` files, or generated `src-tauri/binaries/ffmpeg-*` blobs committed
- [ ] Did not break `--probe-screen-recording` in `main.rs`
