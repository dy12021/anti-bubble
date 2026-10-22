"""生成扩展图标：蓝绿渐变底 + 白色对话气泡 + 一道裂痕（打破信息茧房）。

纯 Python 实现，不依赖 PIL——仓库里所有脚本都该是「clone 下来就能跑」的。
做法：先按 4 倍超采样画到内存，再盒式降采样回目标尺寸，边缘才不会锯齿。

形状用有向距离场（SDF）判定：
  - 圆角矩形 = 圆角盒 SDF
  - 三角形 = 三个半平面取交集
  - 裂痕 = 旋转矩形（用两组正交投影判定）
"""
import struct
import zlib
import os
import math

TOP = (47, 211, 195)      # 亮青绿
BOTTOM = (13, 128, 158)   # 深青蓝
BG = (0, 0, 0)
SS = 4                   # 超采样倍数


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def sd_round_rect(px, py, cx, cy, hw, hh, r):
    """圆角矩形有向距离（负=在内部）。"""
    qx = abs(px - cx) - (hw - r)
    qy = abs(py - cy) - (hh - r)
    ox, oy = max(qx, 0.0), max(qy, 0.0)
    return math.hypot(ox, oy) + min(max(qx, qy), 0.0) - r


def in_triangle(px, py, a, b, c):
    """点是否在三角形内（三点逆时针为正）。"""
    def sign(p1, p2, p3):
        return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])
    d1 = sign((px, py), a, b)
    d2 = sign((px, py), b, c)
    d3 = sign((px, py), c, a)
    neg = (d1 < 0) or (d1 == 0)
    neg = neg and ((d2 < 0) or (d2 == 0)) and ((d3 < 0) or (d3 == 0))
    pos = (d1 > 0) or (d1 == 0)
    pos = pos and ((d2 > 0) or (d2 == 0)) and ((d3 > 0) or (d3 == 0))
    return neg or pos


def render(size):
    """渲染 size×size 的 RGBA 像素（已降采样）。"""
    big = size * SS
    buf = [[(0, 0, 0, 0)] * big for _ in range(big)]

    # 单位坐标里的关键点
    body_cx, body_cy = 0.5, 0.435
    body_hw, body_hh = 0.315, 0.215
    body_r = 0.125
    tail = ((0.315, 0.63), (0.285, 0.845), (0.525, 0.63))
    # 「缺口」：从右侧咬进去的一个楔形，把气泡打破
    notch = ((1.08, 0.285), (0.615, 0.445), (1.08, 0.585))

    for y in range(big):
        v = (y + 0.5) / big
        row = buf[y]
        for x in range(big):
            u = (x + 0.5) / big
            # 底：竖直渐变
            col = lerp(TOP, BOTTOM, v)
            # 气泡主体
            if sd_round_rect(u, v, body_cx, body_cy, body_hw, body_hh, body_r) <= 0:
                col = (255, 255, 255)
            # 气泡尾巴
            if in_triangle(u, v, *tail):
                col = (255, 255, 255)
            # 缺口：用底色咬掉一块，气泡就「打开」了
            if in_triangle(u, v, *notch):
                col = lerp(TOP, BOTTOM, v)
            row[x] = (col[0], col[1], col[2], 255)

    # 盒式降采样
    out = []
    for y in range(size):
        row = []
        for x in range(size):
            r = g = b = a = 0
            for dy in range(SS):
                src = buf[y * SS + dy]
                for dx in range(SS):
                    p = src[x * SS + dx]
                    r += p[0]; g += p[1]; b += p[2]; a += p[3]
            n = SS * SS
            row.append((r // n, g // n, b // n, a // n))
        out.append(row)
    return out


def write_png(path, pixels):
    size = len(pixels)

    def chunk(t, d):
        c = t + d
        return struct.pack(">I", len(d)) + c + struct.pack(">I", zlib.crc32(c) & 0xffffffff)

    raw = b"".join(
        b"\x00" + b"".join(bytes(p) for p in row) for row in pixels
    )
    data = (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(data)


def main():
    base = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public")
    os.makedirs(base, exist_ok=True)
    for s in (16, 48, 128):
        path = os.path.join(base, "icon-%d.png" % s)
        write_png(path, render(s))
        print("wrote %s (%d bytes)" % (path, os.path.getsize(path)))


if __name__ == "__main__":
    main()
