"""找 M3.1 上真正可用的参数组合。

已知：M3.1 强制 adaptive thinking，关不掉；
      max_tokens=2000 时思考吃掉预算 -> content 为空 -> 解析失败。
所以要试：更大的预算、max_completion_tokens、不带上限。
"""
import json
import re
import time
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

JUDGE_SYS = (
    "你是一个 B 站评论审核器。输入是若干条评论，以及该视频的判据。\n"
    "请对每条评论独立判断，输出严格的 JSON，不要任何解释文字。\n"
    '输出格式：{"results":[{"id":1,"action":"pass|fold|hide|mark","reason":"一句人话理由",'
    '"reasonCode":"incitement|stance_opposite|dislike_match|off_topic","confidence":0.0-1.0}]}\n'
    "要求：results 长度必须与输入评论数一致，id 与输入序号一一对应。判不准就给 pass。"
)
JUDGE_USER = (
    "【该视频的判据】\n立场：支持国产芯片\n可疑表达：引战、地域攻击、互相嘲讽\n\n"
    "【待判评论】\n"
    "1. 作者：甲｜内容：这个视频说得有道理，我支持\n"
    "2. 作者：乙｜内容：评论区有些人就是引战，一开口就地域攻击\n"
    "3. 作者：丙｜内容：感觉作者被带了节奏，观点太片面了\n"
    "4. 作者：丁｜内容：今天天气不错"
)


def call(extra: dict):
    body = {
        "model": model,
        "messages": [{"role": "system", "content": JUDGE_SYS}, {"role": "user", "content": JUDGE_USER}],
    }
    body.update(extra)
    req = urllib.request.Request(
        base + "/chat/completions",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
        method="POST",
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return r.status, r.read().decode("utf-8"), time.time() - t0
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")[:300], time.time() - t0
    except Exception as e:  # noqa: BLE001
        return -1, str(e)[:300], time.time() - t0


def inspect(label, extra):
    status, raw, dt = call(extra)
    line = f"{label:52s} HTTP {status}  {dt:5.1f}s"
    try:
        d = json.loads(raw)
    except Exception:
        print(line + "  非JSON: " + raw[:150].replace("\n", " "))
        return
    if "choices" not in d:
        print(line + "  " + raw[:200].replace("\n", " "))
        return
    ch = d["choices"][0]
    msg = ch.get("message", {})
    content = msg.get("content") or ""
    reasoning = msg.get("reasoning_content") or ""
    usage = d.get("usage", {})
    parsed = 0
    if content:
        m = re.search(r'\{[\s\S]*\}', content)
        if m:
            try:
                parsed = len(json.loads(m.group(0)).get("results", []))
            except Exception:
                parsed = -1
    print(
        f"{line}  content={len(content):5d}  reasoning={len(reasoning):6d}  "
        f"completion={usage.get('completion_tokens')}  finish={ch.get('finish_reason')}  解析出={parsed}"
    )
    if content:
        print(f"    {content[:200]}")


print(f"model = {model}\n")
inspect("max_tokens=2000", {"max_tokens": 2000})
inspect("max_tokens=8000", {"max_tokens": 8000})
inspect("max_tokens=16000", {"max_tokens": 16000})
inspect("max_completion_tokens=8000", {"max_completion_tokens": 8000})
inspect("max_completion_tokens=16000", {"max_completion_tokens": 16000})
inspect("不带上限", {})
