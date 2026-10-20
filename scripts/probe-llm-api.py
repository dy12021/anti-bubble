"""探测 MiniMax M3.1 的 chat/completions 参数兼容性。

背景：M3.1 文档说用 max_completion_tokens，而通用 OpenAI 兼容协议用 max_tokens。
扩展的 LLM 客户端目前发的是 max_tokens —— 如果 M3.1 不认，整个判定链路就废了。
这个脚本直接打真接口验证。
"""
import json
import re
import urllib.request

CFG = r"D:\coding\llm-quant\config.toml"

with open(CFG, "r", encoding="utf-8") as f:
    text = f.read()


def grab(key: str) -> str:
    m = re.search(rf'^\s*{key}\s*=\s*"([^"]*)"', text, re.M)
    return m.group(1) if m else ""


base = grab("base_url").rstrip("/")
api_key = grab("api_key")
model = grab("model")

print(f"base_url = {base}")
print(f"model    = {model}")
print(f"key      = {api_key[:8]}...（长度 {len(api_key)}）")

BODY = {
    "model": model,
    "messages": [{"role": "user", "content": "回复「ok」两个字即可。"}],
}


def call(extra: dict) -> tuple:
    body = dict(BODY)
    body.update(extra)
    req = urllib.request.Request(
        base + "/chat/completions",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read().decode("utf-8")
            return r.status, raw
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")[:400]
    except Exception as e:  # noqa: BLE001
        return -1, str(e)[:400]


for label, extra in [
    ("max_tokens=16", {"max_tokens": 16}),
    ("max_completion_tokens=16", {"max_completion_tokens": 16}),
    ("两者都带", {"max_tokens": 16, "max_completion_tokens": 16}),
    ("不带", {}),
]:
    status, raw = call(extra)
    ok = '"content"' in raw and '"choices"' in raw
    print(f"\n--- {label} -> HTTP {status} {'✓' if ok else '✗'}")
    if not ok:
        print("    " + raw.replace("\n", " ")[:300])
    else:
        try:
            d = json.loads(raw)
            content = d["choices"][0]["message"]["content"]
            print(f"    content = {content!r}")
        except Exception as e:  # noqa: BLE001
            print(f"    解析失败: {e} | {raw[:200]}")
