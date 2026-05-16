#!/usr/bin/env bun
// Bump version across package.json, src-tauri/tauri.conf.json, and
// src-tauri/Cargo.toml, then create a git commit + tag (mirrors
// `npm version <patch|minor|major>`).
//
// Usage: bun run scripts/bump-version.ts <patch|minor|major|x.y.z>

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = resolve(root, "package.json");
const confPath = resolve(root, "src-tauri/tauri.conf.json");
const cargoPath = resolve(root, "src-tauri/Cargo.toml");

const arg = process.argv[2];
if (!arg) {
  console.error("usage: bump-version <patch|minor|major|x.y.z>");
  process.exit(1);
}

function parse(v: string): [number, number, number] {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) throw new Error(`invalid semver: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
const current = pkg.version;

let next: string;
if (arg === "patch" || arg === "minor" || arg === "major") {
  const [maj, min, pat] = parse(current);
  next =
    arg === "major"
      ? `${maj + 1}.0.0`
      : arg === "minor"
        ? `${maj}.${min + 1}.0`
        : `${maj}.${min}.${pat + 1}`;
} else {
  parse(arg);
  next = arg;
}

const status = execSync("git status --porcelain", { cwd: root, encoding: "utf8" });
if (status.trim()) {
  console.error("working tree not clean; commit or stash changes first");
  process.exit(1);
}

pkg.version = next;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

const conf = readFileSync(confPath, "utf8");
writeFileSync(
  confPath,
  conf.replace(/("version"\s*:\s*)"[^"]+"/, `$1"${next}"`),
);

const cargo = readFileSync(cargoPath, "utf8");
writeFileSync(
  cargoPath,
  cargo.replace(/^version\s*=\s*"[^"]+"/m, `version = "${next}"`),
);

execSync("cargo update -p openscreen-studio --offline", {
  cwd: resolve(root, "src-tauri"),
  stdio: "ignore",
});

execSync(`git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock`, {
  cwd: root,
});
execSync(`git commit -m "v${next}"`, { cwd: root, stdio: "inherit" });
execSync(`git tag -a v${next} -m "v${next}"`, { cwd: root, stdio: "inherit" });

console.log(`bumped ${current} -> ${next}, tagged v${next}`);
