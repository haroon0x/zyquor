#!/usr/bin/env python3
"""Build the Tauri updater manifest (`latest.json`) from signed bundle artifacts.

Tauri's bundler writes a detached signature next to each updater artifact
(`*.exe.sig` / `*.msi.sig`) when `bundle.createUpdaterArtifacts` is enabled and
`TAURI_SIGNING_PRIVATE_KEY` is set. Pull requests and unsigned builds have no
manifest, so this script fails loudly when the signatures are missing — a
release must never publish an unsigned updater artifact by accident.

Usage:
    python3 scripts/generate-updater-manifest.py \
        --bundle-dir target/release/bundle \
        --version 0.1.0 \
        --repo haroon0x/zyquor \
        --tag v0.1.0 \
        --output target/release/bundle/latest.json

The output matches the Tauri v2 updater endpoint format:
    {
      "version": "0.1.0",
      "notes": "...",
      "pub_date": "2026-11-17T09:00:00Z",
      "platforms": {
        "windows-x86_64": {"signature": "...", "url": "https://..."}
      }
    }
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

PLATFORM = "windows-x86_64"


def fail(message: str) -> "NoReturn":  # noqa: F821 - tiny script, keep deps at zero
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def pick_artifact(bundle_dir: Path) -> tuple[Path, Path]:
    """Return (installer, signature) for the updater. Prefer the NSIS setup exe."""
    candidates: list[Path] = []
    nsis = sorted((bundle_dir / "nsis").glob("*-setup.exe")) if (bundle_dir / "nsis").is_dir() else []
    candidates.extend(nsis)
    if not candidates:
        msi = sorted((bundle_dir / "msi").glob("*.msi")) if (bundle_dir / "msi").is_dir() else []
        candidates.extend(msi)
    if not candidates:
        fail(f"no NSIS setup exe or MSI found under {bundle_dir}")

    for artifact in candidates:
        signature = artifact.with_name(artifact.name + ".sig")
        if signature.is_file():
            return artifact, signature
    names = ", ".join(candidate.name for candidate in candidates)
    fail(
        "no detached signature next to any installer "
        f"({names}); enable bundle.createUpdaterArtifacts and set "
        "TAURI_SIGNING_PRIVATE_KEY (and its password) before building"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle-dir", required=True, type=Path)
    parser.add_argument("--version", required=True)
    parser.add_argument("--repo", required=True, help="GitHub owner/repo, e.g. haroon0x/zyquor")
    parser.add_argument("--tag", required=True, help="release tag the artifacts are attached to")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--notes", default=None)
    args = parser.parse_args()

    bundle_dir: Path = args.bundle_dir
    if not bundle_dir.is_dir():
        fail(f"bundle dir does not exist: {bundle_dir}")

    artifact, signature = pick_artifact(bundle_dir)
    signature_text = signature.read_text(encoding="utf-8").strip()
    if not signature_text:
        fail(f"signature file is empty: {signature}")

    filename = urllib.parse.quote(artifact.name)
    url = f"https://github.com/{args.repo}/releases/download/{args.tag}/{filename}"
    manifest = {
        "version": args.version,
        "notes": args.notes or f"Zyquor {args.version}",
        "pub_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "platforms": {
            PLATFORM: {
                "signature": signature_text,
                "url": url,
            }
        },
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {args.output}")
    print(f"  artifact: {artifact.name}")
    print(f"  url:      {url}")
    print(f"  platform: {PLATFORM}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
