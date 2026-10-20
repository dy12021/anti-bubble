"""打印 llm-quant 的 LLM 配置，密钥脱敏。只用于本机端到端验证。"""
import re
import sys

path = r"D:\coding\llm-quant\config.toml"
with open(path, "r", encoding="utf-8") as f:
    text = f.read()

# 只脱敏 key/token/secret 这类字段的值
pattern = re.compile(r'(?im)^(\s*(?:api_?key|key|token|secret|password)\s*=\s*")([^"]*)(")')
masked = pattern.sub(lambda m: m.group(1) + (m.group(2)[:8] + "..." if len(m.group(2)) > 8 else "***") + m.group(3), text)
print(masked[:2500])
