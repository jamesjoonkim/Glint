"""
Entry point bundled by PyInstaller. Dispatches to mlx_lm.server (text models)
or mlx_vlm.server (vision models) based on a leading --backend flag.

Usage (called by Glint's main process):
  glint-mlx-server --backend text   --model <path> --host 127.0.0.1 --port 8765
  glint-mlx-server --backend vision --model <path> --host 127.0.0.1 --port 8766

Adds a localhost-only safety check: refuses to bind anything other than
127.0.0.1 / localhost regardless of backend.
"""
import sys


def _enforce_localhost(args):
    for i, arg in enumerate(args):
        if arg == "--host" and i + 1 < len(args):
            host = args[i + 1]
            if host not in {"127.0.0.1", "localhost"}:
                print(
                    f"[glint-mlx-server] refused to bind {host!r}; localhost only.",
                    file=sys.stderr,
                )
                sys.exit(2)


def main() -> None:
    args = sys.argv[1:]

    # Pop the optional --backend selector (defaults to text for back-compat).
    backend = "text"
    cleaned = []
    skip = False
    for i, arg in enumerate(args):
        if skip:
            skip = False
            continue
        if arg == "--backend" and i + 1 < len(args):
            backend = args[i + 1]
            skip = True
            continue
        cleaned.append(arg)

    _enforce_localhost(cleaned)

    # Re-write argv so the underlying server sees only its own flags.
    sys.argv = [sys.argv[0], *cleaned]

    if backend == "vision":
        from mlx_vlm.server import main as vlm_main
        vlm_main()
    else:
        from mlx_lm.server import main as lm_main
        lm_main()


if __name__ == "__main__":
    main()
