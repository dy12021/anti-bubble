"""修正：带 url: 的是请求(kind:'req')，带 ok: 的是响应(kind:'res')。"""
import os
import re

# Target file is resolved relative to this script's own location.
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PATH = os.path.join(REPO, "tests", "unit", "page-bridge.test.ts")

with open(PATH, "r", encoding="utf-8") as f:
    text = f.read()

before = text

# 请求对象：__ab: true, kind: 'res', id: X, url: ...  ->  kind: 'req'
text = re.sub(
    r"(__ab: true,)\s*\n(\s*)kind: 'res',(\s*\n\s*id: '[^']+',\s*\n\s*url:)",
    r"\1\n\2kind: 'req',\3",
    text,
)

with open(PATH, "w", encoding="utf-8", newline="") as f:
    f.write(text)

print("changed" if text != before else "NO CHANGE")

# 复核
for i, line in enumerate(text.split("\n"), 1):
    if "kind:" in line:
        print(f"{i}: {line.strip()}")
