#!/usr/bin/env node
// Resolve pnpm workspace symlinks in apps/desktop/node_modules/@zyquor/*
// into real directories so electron-builder can copy them into the asar.
// Run before: pnpm electron-builder ...
// Restore:    node scripts/prepack-zyq.mjs --undo

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP_DIR = fileURLToPath(new URL("../apps/desktop", import.meta.url));
const DEPS_DIR = join(DESKTOP_DIR, "node_modules", "@zyquor");
const BACKUP_DIR = join(DESKTOP_DIR, "node_modules", ".zyquor-backup");
const UNDO = process.argv.includes("--undo");

if (UNDO) {
  if (!existsSync(BACKUP_DIR)) {
    console.log("[prepack-zyq] Nothing to undo (no backup dir).");
    process.exit(0);
  }
  const names = readdirSync(BACKUP_DIR);
  for (const name of names) {
    const symlinkPath = join(DEPS_DIR, name);
    const backupPath = join(BACKUP_DIR, name);
    if (existsSync(symlinkPath)) {
      rmSync(symlinkPath, { recursive: true, force: true });
    }
    renameSync(backupPath, symlinkPath);
    console.log(`[prepack-zyq] Restored symlink: ${name}`);
  }
  rmSync(BACKUP_DIR, { recursive: true, force: true });
  console.log("[prepack-zyq] Undo complete.");
  process.exit(0);
}

if (!existsSync(DEPS_DIR)) {
  console.log("[prepack-zyq] No @zyquor deps dir, skipping.");
  process.exit(0);
}

const entries = [];
for (const name of readdirSync(DEPS_DIR)) {
  const full = join(DEPS_DIR, name);
  try {
    if (lstatSync(full).isSymbolicLink()) {
      entries.push({ name, full });
    }
  } catch { /* ignore permission errors */ }
}

if (entries.length === 0) {
  console.log("[prepack-zyq] No symlinks to resolve.");
  process.exit(0);
}

console.log(`[prepack-zyq] Resolving ${entries.length} workspace symlinks...`);
mkdirSync(BACKUP_DIR, { recursive: true });

for (const { name, full } of entries) {
  const realPath = realpathSync(full);
  console.log(`[prepack-zyq]   ${name} -> ${realPath}`);

  // Move symlink to backup
  const backupPath = join(BACKUP_DIR, name);
  renameSync(full, backupPath);

  // Copy real directory content
  cpSync(realPath, full, { recursive: true });
}

console.log("[prepack-zyq] Done. Symlinks resolved. Run with --undo after packaging to restore.");
