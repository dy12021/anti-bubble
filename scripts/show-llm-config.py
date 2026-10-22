"""打印 llm-quant 的 LLM 配置，密钥脱敏。只用于本机端到端验证。"""
import os
import re
import sys

# Repo root is derived from this script's own location.
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# LLM config comes from the sibling llm-quant checkout by default; override
# with the LLM_CONFIG environment variable.
path = os.environ.get(
    "LLM_CONFIG", os.path.join(REPO, "..", "llm-quant", "config.toml")
)
with open(path, "r", encoding="utf-8") as f:
    text = f.read()

# 只脱敏 key/token/secret 这类字段的值
pattern = re.compile(r'(?im)^(\s*(?:api_?key|key|token|secret|password)\s*=\s*")([^"]*)(")')
masked = pattern.sub(lambda m: m.group(1) + (m.group(2)[:8] + "..." if len(m.group(2)) > 8 else "***") + m.group(3), text)
print(masked[:2500])
