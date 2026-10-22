"""探测 M3.1 的 reasoning_effort 支持 + 真实判定场景的返回质量。

背景：M3.1 是带 thinking 的推理模型。给 JSON 分类任务开思考会：
1. 吃掉 token 预算 -> content 变空 -> 解析失败 -> 整条流水线静默失效
2. 让每次判定变慢、变贵
所以要确认 reasoning_effort=none 能不能关掉思考，以及真实判定 prompt 的返回质量。
"""
import json
import os
import re
import time
import urllib.request

# Repo root is derived from this script's own location.
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# LLM config comes from the sibling llm-quant checkout by default; override
# with the LLM_CONFIG environment variable.
CFG = os.environ.get(
    "LLM_CONFIG", os.path.join(REPO, "..", "llm-quant", "config.toml")
)
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


def call(extra: dict, system: str, user: str):
    body = {
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
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
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = r.read().decode("utf-8")
            dt = time.time() - t0
            return r.status, raw, dt
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")[:400], time.time() - t0
    except Exception as e:  # noqa: BLE001
        return -1, str(e)[:400], time.time() - t0


def inspect(label: str, extra: dict):
    status, raw, dt = call(extra, JUDGE_SYS, JUDGE_USER)
    print(f"\n--- {label} -> HTTP {status}  {dt:.1f}s")
    try:
        d = json.loads(raw)
    except Exception:
        print("    非 JSON: " + raw.replace("\n", " ")[:250])
        return
    if "choices" not in d:
        print("    " + raw.replace("\n", " ")[:300])
        return
    msg = d["choices"][0].get("message", {})
    content = msg.get("content") or ""
    reasoning = msg.get("reasoning_content") or ""
    usage = d.get("usage", {})
    print(f"    content 长度={len(content)}  reasoning 长度={len(reasoning)}")
    print(f"    usage: completion={usage.get('completion_tokens')} reasoning={usage.get('reasoning_tokens')} total={usage.get('total_tokens')}")
    print(f"    finish_reason={d['choices'][0].get('finish_reason')}")
    if content:
        print(f"    content = {content[:220]}")
        # 试解析出 JSON
        m = re.search(r'\{[\s\S]*\}', content)
        if m:
            try:
                obj = json.loads(m.group(0))
                print(f"    解析出 {len(obj.get('results', []))} 条判定")
            except Exception as e:  # noqa: BLE001
                print(f"    JSON 解析失败: {e}")
    else:
        print("    !! content 为空 —— 解析会失败，流水线会静默降级")


print(f"model = {model}")
inspect("A. 只带 max_tokens=2000（当前扩展的做法）", {"max_tokens": 2000})
inspect("B. max_tokens=2000 + reasoning_effort=none", {"max_tokens": 2000, "reasoning_effort": "none"})
inspect("C. reasoning_effort=none 单独", {"reasoning_effort": "none"})
inspect("D. max_completion_tokens=8000 + reasoning_effort=none", {"max_completion_tokens": 8000, "reasoning_effort": "none"})
