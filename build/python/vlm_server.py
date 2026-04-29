"""
Minimal OpenAI-compatible HTTP server wrapping mlx_vlm.generate().

mlx_vlm 0.1.x ships no server module — only generate()/load(). This is a
thin shim so the vision runtime answers /v1/chat/completions like a normal
OpenAI-compat endpoint, matching what mlx_lm.server provides for text.

Bound to 127.0.0.1 only (enforced by runtime_entry.py before this loads).
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import re
import sys
import time
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

# PyInstaller + namespace-package fix: transformers' is_mlx_available() uses
# importlib.util.find_spec("mlx"), which returns None inside frozen bundles
# even when mlx is fully bundled (mlx is a namespace package). Force-flip the
# flag BEFORE importing mlx_vlm so BatchFeature(...).convert_to_tensors("mlx")
# succeeds. Without this, image preprocessing throws:
#   "Unable to convert output to MLX tensors format, MLX is not installed."
def _force_mlx_available() -> None:
    try:
        import transformers.utils.import_utils as iu  # type: ignore
        iu._mlx_available = True
        # Newer transformers cache via lru: clear if present.
        if hasattr(iu, "is_mlx_available") and hasattr(iu.is_mlx_available, "cache_clear"):
            iu.is_mlx_available.cache_clear()
    except Exception as exc:  # noqa: BLE001
        print(f"[vlm-server] mlx-availability patch skipped: {exc}", file=sys.stderr, flush=True)


_force_mlx_available()

# Lazy imports — touched only after CLI args parsed.
_model = None
_processor = None
_config = None


def _ensure_loaded(model_path: str) -> None:
    global _model, _processor, _config
    if _model is not None:
        return
    print(f"[vlm-server] loading model from {model_path}…", file=sys.stderr, flush=True)
    from mlx_vlm import load
    from mlx_vlm.utils import load_config
    _model, _processor = load(model_path)
    _config = load_config(model_path)
    print(f"[vlm-server] model loaded.", file=sys.stderr, flush=True)


def _extract_image_and_prompt(messages: list[dict[str, Any]]) -> tuple[str | None, str]:
    """
    From an OpenAI-compatible messages array, pull the first image_url
    (base64 data: URL) plus the concatenated text from user messages.
    Returns (data_uri_or_path, prompt_text).
    """
    image: str | None = None
    text_parts: list[str] = []

    for msg in messages:
        if msg.get("role") == "system":
            text_parts.append(str(msg.get("content", "")))
            continue
        content = msg.get("content")
        if isinstance(content, str):
            text_parts.append(content)
        elif isinstance(content, list):
            for part in content:
                if part.get("type") == "text":
                    text_parts.append(str(part.get("text", "")))
                elif part.get("type") == "image_url":
                    url = part.get("image_url", {}).get("url", "")
                    if url and image is None:
                        image = url

    return image, "\n\n".join(t for t in text_parts if t)


def _data_uri_to_path(data_uri: str) -> str:
    """Decode `data:image/png;base64,…` into a tmpfile path."""
    m = re.match(r"data:image/(\w+);base64,(.+)$", data_uri)
    if not m:
        # Already a file path or http url — pass through.
        return data_uri
    ext, b64 = m.group(1), m.group(2)
    raw = base64.b64decode(b64)
    import tempfile
    fd, path = tempfile.mkstemp(prefix="glint-vlm-", suffix=f".{ext}")
    with open(fd, "wb") as f:
        f.write(raw)
    return path


def _generate_answer(image: str | None, prompt: str, max_tokens: int) -> str:
    from mlx_vlm import apply_chat_template, generate
    image_path = _data_uri_to_path(image) if image else None
    formatted_prompt = apply_chat_template(
        _processor, _config, prompt, num_images=1 if image_path else 0,
    )
    output = generate(
        _model,
        _processor,
        formatted_prompt,
        image=image_path,
        max_tokens=max_tokens,
        verbose=False,
    )
    # mlx_vlm.generate return shape varies by version:
    #   0.1.x  → str
    #   0.2.x  → tuple (text, ...)
    #   0.4.x  → GenerationResult dataclass with .text attribute
    if hasattr(output, "text"):
        return str(output.text)
    if isinstance(output, tuple):
        return str(output[0]) if output else ""
    return str(output)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        sys.stderr.write(f"[vlm-server] {format % args}\n")
        sys.stderr.flush()

    def _set_headers(self, status: int = 200, content_type: str = "application/json") -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._set_headers(204)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/v1/models":
            self._set_headers(200)
            payload = {"object": "list", "data": [{"id": "default_model", "object": "model"}]}
            self.wfile.write(json.dumps(payload).encode())
            return
        if self.path == "/health":
            self._set_headers(200, "text/plain")
            self.wfile.write(b"ok")
            return
        self._set_headers(404)
        self.wfile.write(b'{"error":"not found"}')

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/v1/chat/completions":
            self._set_headers(404)
            self.wfile.write(b'{"error":"not found"}')
            return

        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length).decode("utf-8"))
        messages = body.get("messages", [])
        max_tokens = int(body.get("max_tokens", 512))
        stream = bool(body.get("stream", False))

        image, prompt = _extract_image_and_prompt(messages)

        try:
            answer = _generate_answer(image, prompt, max_tokens)
        except Exception as exc:  # noqa: BLE001
            self.log_message("generate failed: %s", exc)
            self._set_headers(500)
            self.wfile.write(json.dumps({"error": str(exc)}).encode())
            return

        cmpl_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"
        created = int(time.time())

        if stream:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            # mlx_vlm.generate is non-streaming by default; chunk the result
            # into ~16-char SSE pieces so the client UI animates progressively.
            for i in range(0, len(answer), 16):
                chunk = answer[i:i + 16]
                event = {
                    "id": cmpl_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "choices": [{"index": 0, "delta": {"content": chunk}, "finish_reason": None}],
                }
                self.wfile.write(f"data: {json.dumps(event)}\n\n".encode())
                self.wfile.flush()
            done = {
                "id": cmpl_id, "object": "chat.completion.chunk", "created": created,
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            }
            self.wfile.write(f"data: {json.dumps(done)}\n\ndata: [DONE]\n\n".encode())
            return

        payload = {
            "id": cmpl_id,
            "object": "chat.completion",
            "created": created,
            "model": "default_model",
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": answer},
                "finish_reason": "stop",
            }],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        }
        self._set_headers(200)
        self.wfile.write(json.dumps(payload).encode())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8766)
    args = parser.parse_args()

    if args.host not in {"127.0.0.1", "localhost"}:
        print(f"[vlm-server] refused to bind {args.host!r}; localhost only.", file=sys.stderr)
        sys.exit(2)

    _ensure_loaded(args.model)

    server = HTTPServer((args.host, args.port), Handler)
    print(f"[vlm-server] listening on {args.host}:{args.port}", file=sys.stderr, flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
