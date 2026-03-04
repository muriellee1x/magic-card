#!/usr/bin/env python3
"""
Make animated WebP play as ping-pong (forward + reverse) loop.

Default behavior:
- Reads files/charactor1.webp ... files/charactor4.webp
- Writes originals into files/_original_charactors/ (only if not already backed up)
- Overwrites the original WebP with ping-pong frame order:
  0..N-1, N-2..1  (no duplicated end frames at turnarounds)
"""

from __future__ import annotations

import argparse
import hashlib
import shutil
from datetime import datetime
from pathlib import Path

from PIL import Image


def _extract_frames(im: Image.Image) -> list[Image.Image]:
    n = getattr(im, "n_frames", 1)
    frames: list[Image.Image] = []
    for i in range(n):
        im.seek(i)
        # copy() materializes the frame; convert keeps alpha consistent
        frames.append(im.convert("RGBA").copy())
    return frames


def _pick_duration_ms(im: Image.Image, fallback_ms: int) -> int:
    # Pillow may not expose duration for WebP frames depending on encoder.
    # If we can read it, use it; otherwise fall back to a constant.
    try:
        d = im.info.get("duration")
        if isinstance(d, (int, float)) and d > 0:
            return int(d)
    except Exception:
        pass
    return int(fallback_ms)


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _backup_original(in_path: Path, backup_dir: Path) -> None:
    backup_dir.mkdir(parents=True, exist_ok=True)
    base = backup_dir / in_path.name
    if not base.exists():
        shutil.copy2(in_path, base)
        return

    # If backup exists but differs, keep a timestamped copy too.
    try:
        if base.stat().st_size == in_path.stat().st_size and _sha256(base) == _sha256(in_path):
            return
    except Exception:
        # If hashing fails for any reason, fall back to always keeping a timestamped copy
        pass

    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    stamped = backup_dir / f"{in_path.stem}_{ts}{in_path.suffix}"
    shutil.copy2(in_path, stamped)


def make_pingpong(
    in_path: Path,
    *,
    fps: float,
    backup_dir: Path | None,
    lossless: bool,
    quality: int,
    method: int = 5,
    alpha_quality: int = 100,
) -> None:
    if not in_path.exists():
        raise FileNotFoundError(str(in_path))

    im = Image.open(in_path)
    frames = _extract_frames(im)
    if len(frames) < 2:
        return

    # Forward + reverse (excluding endpoints) to avoid duplicated turnarounds
    pingpong = frames + frames[-2:0:-1]

    duration_ms = _pick_duration_ms(im, fallback_ms=round(1000 / fps))

    if backup_dir is not None:
        _backup_original(in_path, backup_dir)

    tmp_path = in_path.with_suffix(in_path.suffix + ".tmp")
    pingpong[0].save(
        tmp_path,
        format="WEBP",
        save_all=True,
        append_images=pingpong[1:],
        duration=duration_ms,
        loop=0,
        lossless=bool(lossless),
        quality=int(quality),
        alpha_quality=int(alpha_quality),
        method=int(method),
    )
    tmp_path.replace(in_path)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--fps",
        type=float,
        default=24.0,
        help="Fallback fps when WebP has no per-frame duration metadata (default: 24)",
    )
    ap.add_argument(
        "--quality",
        type=int,
        default=85,
        help="Lossy WebP quality (0-100). Default: 85",
    )
    ap.add_argument(
        "--lossless",
        action="store_true",
        help="Encode as lossless WebP (can be much larger)",
    )
    ap.add_argument(
        "--inputs",
        nargs="*",
        default=[f"files/charactor{i}.webp" for i in range(1, 5)],
        help="Input WebP paths (default: files/charactor1.webp..4.webp)",
    )
    ap.add_argument(
        "--no-backup",
        action="store_true",
        help="Do not write backups to files/_original_charactors/",
    )
    args = ap.parse_args()

    backup_dir = None if args.no_backup else Path("files/_original_charactors")
    for s in args.inputs:
        in_path = Path(s)
        if not in_path.exists():
            continue
        make_pingpong(
            in_path,
            fps=args.fps,
            backup_dir=backup_dir,
            lossless=bool(args.lossless),
            quality=int(args.quality),
            method=5,
            alpha_quality=100,
        )


if __name__ == "__main__":
    main()

