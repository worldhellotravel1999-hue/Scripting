#!/usr/bin/env python3
"""返回 OpenAI 兼容 SSE 流；?hb=1 时在流开头插入注释行 `: heartbeat`。"""
import json, time, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 45300
HB = len(sys.argv) > 2 and sys.argv[2] == "hb"


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(length)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

        def emit(payload):
            self.wfile.write(f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode())
            self.wfile.flush()

        # hb 模式：复刻 Workbuddy 上游行为，流开头先发一条 SSE 注释行。
        if HB:
            self.wfile.write(b": heartbeat\n\n")
            self.wfile.flush()

        base = {"created": int(time.time()), "id": "mock1", "model": "mock-model",
                "object": "chat.completion.chunk"}
        emit({"choices": [{"delta": {"content": "OK", "role": "assistant"}, "finish_reason": None, "index": 0}], "usage": None, **base})
        emit({"choices": [{"delta": {"role": "assistant"}, "finish_reason": "stop", "index": 0}],
              "usage": {"completion_tokens": 3, "prompt_tokens": 24, "total_tokens": 27}, **base})
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
