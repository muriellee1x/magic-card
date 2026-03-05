#!/usr/bin/env python3
"""
PLY → .sog 格式转换脚本
输出 SparkJS 0.1.10 兼容的 pcsogszip 格式

格式规范从 SparkJS 0.1.10 源码逆向工程得出：
  - .sog 文件 = ZIP 压缩包
  - 包含 meta.json + 多张 PNG 图像（每张图像存储一类高斯参数）
  - SparkJS 内部类型名: SplatFileType.PCSOGSZIP
"""

import sys
import os
import json
import zipfile
import io
import math
import struct

# 将本地 pylib 加入 sys.path
PYLIB = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'pylib')
sys.path.insert(0, PYLIB)

import numpy as np
from PIL import Image

SH_C0  = 0.28209479177387814
SQRT2  = math.sqrt(2)


# ──────────────────────────────────────────────────────────────────────────────
# 读取 3DGS PLY 文件
# ──────────────────────────────────────────────────────────────────────────────

def read_ply(path: str) -> dict:
    """读取标准 3DGS PLY 文件，返回各属性的 numpy float32 数组。"""
    with open(path, 'rb') as f:
        props, num_verts = [], 0
        while True:
            line = f.readline().decode('ascii', errors='replace').strip()
            if line.startswith('element vertex'):
                num_verts = int(line.split()[-1])
            elif line.startswith('property float'):
                props.append(line.split()[-1])
            elif line == 'end_header':
                break

        raw = f.read(num_verts * len(props) * 4)

    data = np.frombuffer(raw, dtype='<f4').reshape(num_verts, len(props))
    idx  = {p: i for i, p in enumerate(props)}

    return {
        'xyz':     data[:, [idx['x'],       idx['y'],       idx['z']]],
        'f_dc':    data[:, [idx['f_dc_0'],  idx['f_dc_1'],  idx['f_dc_2']]],
        'opacity': data[:,  idx['opacity']],
        'scale':   data[:, [idx['scale_0'], idx['scale_1'], idx['scale_2']]],
        # PLY 3DGS 惯例: rot_0=w, rot_1=x, rot_2=y, rot_3=z
        'rot':     data[:, [idx['rot_0'],   idx['rot_1'],   idx['rot_2'],   idx['rot_3']]],
    }


# ──────────────────────────────────────────────────────────────────────────────
# 图像尺寸计算
# ──────────────────────────────────────────────────────────────────────────────

def find_image_dims(n: int) -> tuple[int, int]:
    """寻找 W×H≈n 且接近正方形的整数因子对（W ≤ H）。"""
    w = int(math.isqrt(n))
    while w >= 1:
        if n % w == 0:
            return w, n // w
        w -= 1
    return 1, n  # 极端退路


# ──────────────────────────────────────────────────────────────────────────────
# 各属性编码（全向量化，无 Python 循环）
# ──────────────────────────────────────────────────────────────────────────────

def encode_means(xyz: np.ndarray):
    """
    位置编码为两张 RGBA PNG（16-bit 精度，双字节拆分）。
    SparkJS 解码：
      x_raw = lerp(mins[0], maxs[0], (lo + hi*256) / 65535)
      x = sign(x_raw) * (exp(|x_raw|) - 1)
    因此存储 sign(x)*log(|x|+1) 再归一化。
    """
    xyz_log = np.sign(xyz) * np.log(np.abs(xyz) + 1.0)
    mins = xyz_log.min(axis=0).tolist()
    maxs = xyz_log.max(axis=0).tolist()

    vals16 = np.zeros((len(xyz), 3), dtype=np.uint16)
    for c in range(3):
        rng = maxs[c] - mins[c]
        if abs(rng) < 1e-8:
            vals16[:, c] = 0
        else:
            vals16[:, c] = (
                np.clip(np.round((xyz_log[:, c] - mins[c]) / rng * 65535), 0, 65535)
                .astype(np.uint16)
            )

    lo = (vals16 & 0xFF).astype(np.uint8)   # 低字节 → means0
    hi = (vals16 >> 8  ).astype(np.uint8)   # 高字节 → means1
    return lo, hi, mins, maxs


def encode_scales(scale: np.ndarray):
    """
    缩放编码（log 空间，8-bit）。
    SparkJS 解码：scale = exp(lerp(mins[c], maxs[c], byte/255))
    存储 log(scale) 归一化到 [0,255]。
    """
    ls = np.log(np.maximum(scale, 1e-10))
    mins = ls.min(axis=0).tolist()
    maxs = ls.max(axis=0).tolist()

    out = np.zeros((len(scale), 3), dtype=np.uint8)
    for c in range(3):
        rng = maxs[c] - mins[c]
        if abs(rng) < 1e-8:
            out[:, c] = 0
        else:
            out[:, c] = np.clip(np.round((ls[:, c] - mins[c]) / rng * 255), 0, 255).astype(np.uint8)
    return out, mins, maxs


def encode_quats(rot: np.ndarray):
    """
    四元数 quaternion_packed 编码（向量化）。
    SparkJS 解码规则：
      r0,r1,r2 从 byte 解码为 (byte/255 - 0.5)*sqrt(2)
      rOrder = alpha_byte - 252   (0=W排除, 1=X排除, 2=Y排除, 3=Z排除)
      排除分量 rr = sqrt(1 - r0^2 - r1^2 - r2^2)
    存储顺序（[W,X,Y,Z] 中排除最大绝对值分量）：
      order=0: r0=X, r1=Y, r2=Z
      order=1: r0=W, r1=Y, r2=Z
      order=2: r0=W, r1=X, r2=Z
      order=3: r0=W, r1=X, r2=Y
    """
    # PLY: rot_0=w, rot_1=x, rot_2=y, rot_3=z
    qw, qx, qy, qz = rot[:, 0], rot[:, 1], rot[:, 2], rot[:, 3]

    # 归一化
    nrm = np.maximum(np.sqrt(qw**2 + qx**2 + qy**2 + qz**2), 1e-8)
    qw, qx, qy, qz = qw / nrm, qx / nrm, qy / nrm, qz / nrm

    # 找最大绝对值分量（0=W, 1=X, 2=Y, 3=Z）
    stk = np.stack([qw, qx, qy, qz], axis=1)   # (N, 4)
    order = np.argmax(np.abs(stk), axis=1)       # (N,)

    # 确保最大分量为正
    signs = np.where(stk[np.arange(len(stk)), order] < 0, -1.0, 1.0)
    qw, qx, qy, qz = qw * signs, qx * signs, qy * signs, qz * signs

    # 向量化选取 r0, r1, r2
    r0 = np.where(order == 0, qx, qw)              # 0→X, 1,2,3→W
    r1 = np.where(order <= 1, qy, qx)              # 0,1→Y; 2,3→X
    r2 = np.where(order <= 2, qz, qy)              # 0,1,2→Z; 3→Y

    encode = lambda v: np.clip(np.round((v / SQRT2 + 0.5) * 255), 0, 255).astype(np.uint8)
    return encode(r0), encode(r1), encode(r2), (order + 252).astype(np.uint8)


def encode_sh0(f_dc: np.ndarray, opacity_raw: np.ndarray):
    """
    颜色 (f_dc) + 透明度 (raw logit) 编码为一张 RGBA PNG。
    SparkJS 解码：
      color = SH_C0 * lerp(mins[c], maxs[c], byte/255) + 0.5   → clamp(0,1)
      opacity = sigmoid( lerp(mins[3], maxs[3], byte/255) )
    """
    fmin = f_dc.min(axis=0).tolist()
    fmax = f_dc.max(axis=0).tolist()

    rgb = np.zeros((len(f_dc), 3), dtype=np.uint8)
    for c in range(3):
        rng = fmax[c] - fmin[c]
        if abs(rng) < 1e-8:
            rgb[:, c] = 0
        else:
            rgb[:, c] = np.clip(np.round((f_dc[:, c] - fmin[c]) / rng * 255), 0, 255).astype(np.uint8)

    op_clean = np.nan_to_num(opacity_raw, nan=0.0, posinf=10.0, neginf=-10.0)
    omin, omax = float(op_clean.min()), float(op_clean.max())
    orng = omax - omin
    if abs(orng) < 1e-8:
        alpha = np.zeros(len(f_dc), dtype=np.uint8)
    else:
        alpha = np.clip(np.round((op_clean - omin) / orng * 255), 0, 255).astype(np.uint8)

    mins = fmin + [omin]
    maxs = fmax + [omax]
    return rgb, alpha, mins, maxs


# ──────────────────────────────────────────────────────────────────────────────
# 辅助：生成 RGBA PNG bytes
# ──────────────────────────────────────────────────────────────────────────────

def make_rgba_png(r, g, b, a, W: int, H: int) -> bytes:
    """将 RGBA 各通道打包为 W×H RGBA PNG（不足处补零）。

    SparkJS 解码时使用 UNPACK_FLIP_Y_WEBGL=true + readPixels(从底部开始)，
    净效果是 PNG 行顺序被倒置（最后一行先读）。
    因此这里预先翻转行顺序，使 splat 0 存到 PNG 最后一行，
    SparkJS 读回后 buffer[0] 对应 splat 0。
    """
    n = len(r)
    rgba = np.zeros((W * H, 4), dtype=np.uint8)
    rgba[:n, 0] = r
    rgba[:n, 1] = g
    rgba[:n, 2] = b
    rgba[:n, 3] = a
    # 垂直翻转行（抵消 SparkJS 的 UNPACK_FLIP_Y_WEBGL + readPixels from bottom）
    arr = rgba.reshape(H, W, 4)[::-1, :, :].copy()
    img = Image.fromarray(arr, 'RGBA')
    buf = io.BytesIO()
    img.save(buf, 'PNG', optimize=True)
    return buf.getvalue()


# ──────────────────────────────────────────────────────────────────────────────
# 主转换函数
# ──────────────────────────────────────────────────────────────────────────────

def ply_to_sog(ply_path: str, sog_path: str):
    print(f"\n  [{os.path.basename(ply_path)}]")
    data = read_ply(ply_path)
    n = data['xyz'].shape[0]
    W, H = find_image_dims(n)
    print(f"    高斯点: {n:,}  →  图像: {W}×{H}")

    print("    编码 means...", end='', flush=True)
    lo, hi, m_mins, m_maxs = encode_means(data['xyz'])
    print(" scales...", end='', flush=True)
    sc, s_mins, s_maxs = encode_scales(data['scale'])
    print(" quats...", end='', flush=True)
    r0, r1, r2, rord = encode_quats(data['rot'])
    print(" sh0...", end='', flush=True)
    rgb, alpha, c_mins, c_maxs = encode_sh0(data['f_dc'], data['opacity'])
    print(" PNG...", end='', flush=True)

    z0 = np.zeros(n, dtype=np.uint8)
    means0_png = make_rgba_png(lo[:, 0], lo[:, 1], lo[:, 2], z0, W, H)
    means1_png = make_rgba_png(hi[:, 0], hi[:, 1], hi[:, 2], z0, W, H)
    scales_png = make_rgba_png(sc[:, 0], sc[:, 1], sc[:, 2], z0, W, H)
    quats_png  = make_rgba_png(r0, r1, r2, rord, W, H)
    sh0_png    = make_rgba_png(rgb[:, 0], rgb[:, 1], rgb[:, 2], alpha, W, H)
    print(" ZIP...", end='', flush=True)

    meta = {
        "means": {
            "shape": [n, 3],
            "files": ["means0.png", "means1.png"],
            "mins": m_mins, "maxs": m_maxs,
        },
        "scales": {
            "shape": [n, 3],
            "files": ["scales.png"],
            "mins": s_mins, "maxs": s_maxs,
        },
        "quats": {
            "shape": [n, 4],
            "files": ["quats.png"],
            "encoding": "quaternion_packed",
        },
        "sh0": {
            "shape": [n, 4],
            "files": ["sh0.png"],
            "mins": c_mins, "maxs": c_maxs,
        },
    }

    os.makedirs(os.path.dirname(os.path.abspath(sog_path)), exist_ok=True)
    with zipfile.ZipFile(sog_path, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        zf.writestr('meta.json',  json.dumps(meta, separators=(',', ':')))
        zf.writestr('means0.png', means0_png)
        zf.writestr('means1.png', means1_png)
        zf.writestr('scales.png', scales_png)
        zf.writestr('quats.png',  quats_png)
        zf.writestr('sh0.png',    sh0_png)

    ply_mb = os.path.getsize(ply_path)  / 1024**2
    sog_mb = os.path.getsize(sog_path)  / 1024**2
    print(f" 完成\n    {ply_mb:.1f}MB → {sog_mb:.1f}MB  (压缩比 {ply_mb/sog_mb:.1f}x)")


# ──────────────────────────────────────────────────────────────────────────────
# CLI 入口
# ──────────────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("用法: python3 ply_to_sog.py <input.ply> <output.sog>")
        sys.exit(1)
    ply_to_sog(sys.argv[1], sys.argv[2])
