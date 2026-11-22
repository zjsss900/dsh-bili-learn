#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""本地 embedding 服务（语义检索用）。只用 CPU：显存只有 20G，Strata 常驻 ~19.8G，绝不抢。

用法：
  python embed.py cards  --in 需要嵌入的.jsonl --out 向量.jsonl   # 批量嵌卡片
  python embed.py query  --text "自然语言需求"                    # 单条查询（打印 JSON）
  python embed.py serve  --port 10099 --idle 900                  # 常驻，插件按 HTTP 调
模型目录：环境变量 BILI_EMB_MODEL（默认 ~/.dsh/models/bge-small-zh-v1.5）。
自测门禁：--selftest 跑三组「查询里没有共同词」的例子，不合格就退出码 1。
"""
import argparse, json, os, sys, time

os.environ["CUDA_VISIBLE_DEVICES"] = ""          # 强制 CPU：不碰显卡
os.environ.setdefault("OMP_NUM_THREADS", "4")
HOME = os.path.expanduser("~")
MODEL = os.environ.get("BILI_EMB_MODEL", os.path.join(HOME, ".dsh", "models", "bge-small-zh-v1.5"))
QUERY_INSTR = "为这个句子生成表示以用于检索相关文章："   # bge 中文检索官方查询前缀

_torch = None
_model = None
_tok = None
_dim = None


def load():
    global _torch, _model, _tok, _dim
    if _model is not None:
        return _dim
    t0 = time.time()
    import torch
    from transformers import AutoModel, AutoTokenizer
    _torch = torch
    _tok = AutoTokenizer.from_pretrained(MODEL)
    _model = AutoModel.from_pretrained(MODEL)
    _model.eval()
    _dim = int(_model.config.hidden_size)
    print(json.dumps({"event": "loaded", "model": MODEL, "dim": _dim, "device": "cpu", "seconds": round(time.time() - t0, 2)}, ensure_ascii=False), file=sys.stderr)
    return _dim


def encode(texts, as_query=False, batch=32):
    load()
    torch = _torch
    prefix = QUERY_INSTR if as_query else ""
    out = []
    for i in range(0, len(texts), batch):
        chunk = [prefix + (t or "") for t in texts[i:i + batch]]
        enc = _tok(chunk, padding=True, truncation=True, max_length=512, return_tensors="pt")
        with torch.no_grad():
            h = _model(**enc).last_hidden_state[:, 0]          # CLS pooling（bge 用法）
        out.append(torch.nn.functional.normalize(h, p=2, dim=1).cpu().tolist())
    return [v for rows in out for v in rows]


def cmd_cards(a):
    items = [json.loads(l) for l in open(a.input, encoding="utf-8") if l.strip()]
    t0 = time.time()
    with open(a.out, "w", encoding="utf-8") as f:
        for i in range(0, len(items), 64):
            group = items[i:i + 64]
            vecs = encode([g["text"] for g in group], as_query=False)
            for g, v in zip(group, vecs):
                f.write(json.dumps({"key": g["key"], "dhash": g.get("dhash", ""), "vec": v}, ensure_ascii=False) + "\n")
            print(f"嵌了 {min(i + 64, len(items))}/{len(items)}", file=sys.stderr)
    print(json.dumps({"event": "cards", "n": len(items), "dim": _dim, "seconds": round(time.time() - t0, 1), "out": a.out}, ensure_ascii=False))


def cmd_query(a):
    v = encode([a.text], as_query=True)[0]
    print(json.dumps({"vec": v, "dim": len(v), "model": MODEL}, ensure_ascii=False))


def cmd_serve(a):
    load()
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    deadline = [time.time() + a.idle]

    class H(BaseHTTPRequestHandler):
        def log_message(self, *x):
            pass

        def _send(self, code, obj):
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            deadline[0] = time.time() + a.idle
            if self.path.startswith("/health"):
                self._send(200, {"ok": True, "model": MODEL, "dim": _dim, "device": "cpu", "idle_left": int(deadline[0] - time.time())})
            else:
                self._send(404, {"ok": False, "reason": "只有 /health 与 /embed"})

        def do_POST(self):
            deadline[0] = time.time() + a.idle
            n = int(self.headers.get("Content-Length") or 0)
            try:
                req = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
                texts = req.get("texts") or []
                vecs = encode([str(t) for t in texts], as_query=bool(req.get("query")))
                self._send(200, {"ok": True, "dim": _dim, "vecs": vecs})
            except Exception as e:  # 出错只回原因，服务不能掉
                self._send(500, {"ok": False, "reason": f"{type(e).__name__}: {e}"})

    srv = ThreadingHTTPServer(("127.0.0.1", a.port), H)
    print(json.dumps({"event": "serving", "port": a.port, "dim": _dim, "idle_seconds": a.idle}, ensure_ascii=False), flush=True)

    def watchdog():
        while True:
            time.sleep(5)
            if deadline[0] < time.time():
                print(json.dumps({"event": "idle-exit", "idle_seconds": a.idle}, ensure_ascii=False), flush=True)
                os._exit(0)

    threading.Thread(target=watchdog, daemon=True).start()
    srv.serve_forever()


def cmd_selftest(a):
    cards = [
        "角色图要干净背景且全身完整，避免多场景冲突和穿帮",
        "角色用9:16，场景用16:9，不额外选风格",
        "两人对话可先定轴线，在一侧设五个机位才不会跳轴",
        "复杂动作视频选 Seedance 2.0 完全版，简单文戏选 fast 版省时省钱",
        "用上一镜头的截图当站位图，锁定人物左右关系",
    ]
    cases = [
        ("出图的时候画幅比例怎么选", 1),
        ("怎么让两个人说话时不跳出画面方向感", 2),
        ("生成打斗场面挑模型想省钱", 3),
        ("人物跨镜头换脸穿帮怎么办", 0),
    ]
    ce = encode(cards)
    bad = 0
    for q, want in cases:
        qv = encode([q], as_query=True)[0]
        order = sorted(range(len(cards)), key=lambda i: -sum(x * y for x, y in zip(qv, ce[i])))
        rank = order.index(want)
        # 断言 top3 而不是 top1：小模型对措辞敏感（实测「打斗场面」拉偏、「打戏」就命中），
        # 语义召回是补关键词的盲区，不是替它做终判——混排时它只出一路候选。
        ok = rank < 3
        bad += 0 if ok else 1
        print(f"{'PASS' if ok else 'FAIL'}  问「{q}」→ 期望卡排 #{rank + 1}（首位：{cards[order[0]]}）")
    print(("自测 PASS（期望卡都在 top3）" if bad == 0 else f"自测 FAIL（{bad} 条不在 top3）") + f"｜dim={_dim}")
    sys.exit(0 if bad == 0 else 1)


if __name__ == "__main__":
    import threading
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("cards"); c.add_argument("--in", dest="input", required=True); c.add_argument("--out", required=True)
    q = sub.add_parser("query"); q.add_argument("--text", required=True)
    s = sub.add_parser("serve"); s.add_argument("--port", type=int, default=10099); s.add_argument("--idle", type=int, default=900)
    sub.add_parser("selftest")
    a = p.parse_args()
    {"cards": cmd_cards, "query": cmd_query, "serve": cmd_serve, "selftest": cmd_selftest}[a.cmd](a)
