#!/usr/bin/env node
/**
 * Prepares the website as a self-contained server inside the desktop installer:
 *
 *   1. next build (standalone) for apps/web
 *   2. copy .next/standalone (+ .next/static, public) → apps/desktop/src-tauri/resources/web
 *      (symlinks/junctions resolved, so the folder is relocatable)
 *   3. copy the current node executable → apps/desktop/src-tauri/binaries/node-<target>(.exe)
 *      (Tauri sidecar naming), so the installed app needs no Node.js on the PC
 *
 * Run from anywhere: `npm run desktop:build` calls it.
 */
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const web = path.join(root, "apps/web");
const tauri = path.join(root, "apps/desktop/src-tauri");
const out = path.join(tauri, "resources/web");
const bin = path.join(tauri, "binaries");

const step = (m) => console.log(`\n[bundle-web] ${m}`);

step("next build (standalone)");
execSync("npm run build -w @deadlock/web", { cwd: root, stdio: "inherit", env: { ...process.env, NEXT_STANDALONE: "1" } });

const standalone = path.join(web, ".next/standalone");
if (!fs.existsSync(standalone)) throw new Error(`no standalone output at ${standalone}`);

step(`copy server → ${path.relative(root, out)}`);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.cpSync(standalone, out, {
  recursive: true,
  dereference: true,
  // never ship local secrets (office proxy, API key) inside the installer
  filter: (src) => !/\.env(\..*)?$/.test(path.basename(src)),
});
const appDir = path.join(out, "apps/web");
fs.cpSync(path.join(web, ".next/static"), path.join(appDir, ".next/static"), { recursive: true, dereference: true });
if (fs.existsSync(path.join(web, "public"))) fs.cpSync(path.join(web, "public"), path.join(appDir, "public"), { recursive: true, dereference: true });
if (!fs.existsSync(path.join(appDir, "server.js"))) throw new Error("server.js missing in standalone output");

step("copy node runtime (sidecar)");
const host = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/host: (\S+)/)?.[1];
if (!host) throw new Error("could not read target triple from `rustc -vV`");
const ext = process.platform === "win32" ? ".exe" : "";
fs.mkdirSync(bin, { recursive: true });
fs.copyFileSync(process.execPath, path.join(bin, `node-${host}${ext}`));

const size = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((s, e) => s + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
step(`done: web ${(size(out) / 1e6).toFixed(0)} MB, node ${(fs.statSync(process.execPath).size / 1e6).toFixed(0)} MB (${host})`);
