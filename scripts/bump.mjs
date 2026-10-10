#!/usr/bin/env node
// Set the app version everywhere it lives, e.g.  node scripts/bump.mjs 0.3.0
// Then:  git commit -am "release v0.3.0" && git tag v0.3.0 && git push --follow-tags
import fs from "node:fs";

const v = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(v ?? "")) {
  console.error("usage: node scripts/bump.mjs <major.minor.patch>");
  process.exit(1);
}
const edit = (file, f) => {
  const s = fs.readFileSync(file, "utf8");
  const out = f(s);
  if (out === s) throw new Error(`no version found in ${file}`);
  fs.writeFileSync(file, out);
  console.log(`${file} → ${v}`);
};
edit("apps/desktop/src-tauri/tauri.conf.json", (s) => s.replace(/"version": "[^"]+"/, `"version": "${v}"`));
edit("apps/desktop/src-tauri/Cargo.toml", (s) => s.replace(/^version = "[^"]+"/m, `version = "${v}"`));
edit("apps/desktop/package.json", (s) => s.replace(/"version": "[^"]+"/, `"version": "${v}"`));
