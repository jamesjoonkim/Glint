"""
PyInstaller entry point. Dispatches to the appropriate backend:
  --backend text   → mlx_lm.server (built-in OpenAI-compat HTTP)
  --backend vision → vlm_server (custom shim over mlx_vlm.generate)

Localhost-only enforcement is duplicated below for defense-in-depth.
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
    sys.argv = [sys.argv[0], *cleaned]

    if backend == "vision":
        # vlm_server is a sibling module bundled alongside this entry point.
        import vlm_server
        vlm_server.main()
    else:
        from mlx_lm.server import main as lm_main
        lm_main()


if __name__ == "__main__":
    main()
