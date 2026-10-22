"""生成三个尺寸的纯色 PNG 图标（无需设计资源）。"""
import struct
import zlib
import os


def png(path, size, rgba=(31, 111, 235, 255)):
    def chunk(t, d):
        c = t + d
        return struct.pack(">I", len(d)) + c + struct.pack(">I", zlib.crc32(c) & 0xffffffff)

    raw = b"".join(b"\x00" + bytes(rgba) * size for _ in range(size))
    data = (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(data)


base = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public")
os.makedirs(base, exist_ok=True)
for s in (16, 48, 128):
    png(os.path.join(base, "icon-%d.png" % s), s)
print("icons written")
