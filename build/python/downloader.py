"""
Download a Hugging Face repo into a local directory, emitting one JSON
object per stdout line for the parent process to parse.

Usage (invoked by glint-mlx-server when argv[1] == "download"):
    glint-mlx-server download --repo <repo> --dest <dir>

Event schema:
    {"event": "file_start", "name": str, "size": int}
    {"event": "progress",   "name": str, "bytes": int, "total": int}
    {"event": "file_done",  "name": str}
    {"event": "complete",   "repo": str}
    {"event": "error",      "msg": str, "retryable": bool}

Exit codes:
    0 -> complete event emitted, all files on disk
    1 -> error event emitted (retryable or fatal — caller decides)
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from huggingface_hub import snapshot_download
from huggingface_hub.utils import disable_progress_bars
from tqdm.auto import tqdm


def _emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


class JsonlTqdm(tqdm):
    """tqdm subclass that emits JSONL events instead of drawing a bar.

    huggingface_hub instantiates one tqdm per file with desc=<filename>.
    file_start fires on construction, progress events on update (throttled),
    and file_done on close. Emitting from __init__/close (rather than the
    first update call) ensures zero-byte files still produce paired
    file_start/file_done events.
    """

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._last_emitted = 0
        _emit({
            "event": "file_start",
            "name": self.desc or "unknown",
            "size": int(self.total or 0),
        })

    def display(self, *_args: Any, **_kwargs: Any) -> None:
        # Suppress the default rendering — we don't want tqdm's bars
        # mixing into our JSONL stream.
        return

    def update(self, n: int = 1) -> bool | None:
        result = super().update(n)
        # Throttle progress emits to ~once per 4 MiB to keep JSONL volume sane.
        is_final = self.total is not None and self.n == self.total
        if self.n - self._last_emitted >= 4 * 1024 * 1024 or is_final:
            _emit({
                "event": "progress",
                "name": self.desc or "unknown",
                "bytes": int(self.n),
                "total": int(self.total or 0),
            })
            self._last_emitted = self.n
        return result

    def close(self) -> None:
        _emit({"event": "file_done", "name": self.desc or "unknown"})
        super().close()


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="glint-mlx-server download")
    parser.add_argument("--repo", required=True, help="Hugging Face repo id")
    parser.add_argument("--dest", required=True, help="Local destination directory")
    args = parser.parse_args(argv)

    # Disable the library's own progress UI so only our tqdm subclass speaks.
    # Set this BEFORE any huggingface_hub side-effect that might check the flag.
    disable_progress_bars()

    dest = Path(args.dest)
    dest.mkdir(parents=True, exist_ok=True)

    try:
        snapshot_download(
            repo_id=args.repo,
            local_dir=str(dest),
            local_dir_use_symlinks=False,
            tqdm_class=JsonlTqdm,
        )
    except Exception as err:  # noqa: BLE001 — we re-emit as a structured event
        retryable = not isinstance(err, (PermissionError, IsADirectoryError))
        _emit({"event": "error", "msg": str(err), "retryable": retryable})
        return 1

    _emit({"event": "complete", "repo": args.repo})
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
