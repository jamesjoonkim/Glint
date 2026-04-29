"""
Entry point bundled by PyInstaller. Forwards CLI args to mlx_lm.server.

This indirection lets us add a localhost-only safety check before the server
starts, regardless of how the binary is invoked.
"""
import sys


def main() -> None:
    args = sys.argv[1:]
    # Enforce localhost binding — refuse to start with --host other than 127.0.0.1.
    for i, arg in enumerate(args):
        if arg == "--host" and i + 1 < len(args):
            host = args[i + 1]
            if host not in {"127.0.0.1", "localhost"}:
                print(
                    f"[glint-mlx-server] refused to bind {host!r}; localhost only.",
                    file=sys.stderr,
                )
                sys.exit(2)

    from mlx_lm.server import main as mlx_main
    mlx_main()


if __name__ == "__main__":
    main()
