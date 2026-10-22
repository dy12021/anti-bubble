"""给 page-bridge 测试里剩余的消息对象补上 kind 字段。

协议升级后：请求 kind:'req'，响应 kind:'res'。
"""
import os
import re

# Target file is resolved relative to this script's own location.
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PATH = os.path.join(REPO, "tests", "unit", "page-bridge.test.ts")

with open(PATH, "r", encoding="utf-8") as f:
    text = f.read()

before = text

# 单行对象：{ __ab: true, id: X, ... }  ->  { __ab: true, kind: 'res', id: X, ... }
# 这些都是**响应**（测试里喂给监听器的），除了 fakeEvent 那个请求。
text = re.sub(
    r"\{ __ab: true, id: (sent\.id|'[^']+'),",
    r"{ __ab: true, kind: 'res', id: \1,",
    text,
)

# 多行请求对象（handlePageMessage 的入参）：id + url 同现 -> req
text = re.sub(
    r"(__ab: true,)\r?\n(\s*)(id: '[^']+',\r?\n\s*url:)",
    r"\1\n\2kind: 'req',\n\2\3",
    text,
)

# 期望值里的对象（toEqual）也补上
text = re.sub(
    r"(__ab: true,)\r?\n(\s*)(id: 'ab-2',\r?\n\s*ok: true,)",
    r"\1\n\2kind: 'res',\n\2\3",
    text,
)

with open(PATH, "w", encoding="utf-8", newline="") as f:
    f.write(text)

print("changed" if text != before else "NO CHANGE")
