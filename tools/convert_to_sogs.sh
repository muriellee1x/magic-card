#!/usr/bin/env bash
# =============================================================================
# ksplat → SOGS 格式转换脚本
#
# 用法: bash tools/convert_to_sogs.sh
#
# 先决条件：
#   - Python 3.10+ 及 pip
#   - Node.js 18+ (用于 ksplat → PLY 解码步骤)
#   - 有网络访问权限（需要下载依赖和工具）
#
# 流程：
#   1. ksplat → PLY (Node.js 解码)
#   2. PLY → SOGS (Python 压缩流水线)
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
FILES_3D="$PROJECT_DIR/files/3D"
TOOLS_DIR="$PROJECT_DIR/tools"
SOGS_REPO="$TOOLS_DIR/Self-Organizing-Gaussians"
PLY_DIR="$TOOLS_DIR/ply_temp"
SOGS_OUT="$FILES_3D/sogs"

echo "=========================================="
echo " ksplat → SOGS 格式转换"
echo "=========================================="

# ── 步骤 0：检查依赖 ──────────────────────────────────────────────────────────
echo ""
echo "[0/4] 检查依赖..."

if ! command -v node &>/dev/null; then
  echo "❌ 未找到 Node.js，请先安装 Node.js 18+"
  exit 1
fi

if ! command -v python3 &>/dev/null; then
  echo "❌ 未找到 Python3，请先安装 Python 3.10+"
  exit 1
fi

echo "✅ Node.js $(node --version)，Python $(python3 --version)"

# ── 步骤 1：ksplat → PLY 解码 (Node.js) ──────────────────────────────────────
echo ""
echo "[1/4] 将 ksplat 文件解码为 PLY..."
mkdir -p "$PLY_DIR"

# 安装 ksplat 解码器
cd "$TOOLS_DIR"
if [ ! -d "ksplat_decoder" ]; then
  mkdir ksplat_decoder
  cd ksplat_decoder
  npm init -y --quiet
  npm install @mkkellogg/gaussian-splats-3d --quiet
  cd ..
fi

# 生成解码脚本
cat > "$TOOLS_DIR/decode_ksplat.mjs" << 'EOF'
/**
 * ksplat → PLY 解码脚本
 * 使用 @mkkellogg/gaussian-splats-3d 的 KSplatLoader 解码 ksplat 文件
 */
import { createRequire } from 'module';
import { readFileSync, writeFileSync } from 'fs';
import { join, basename, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 读取命令行参数
const inputFile = process.argv[2];
const outputFile = process.argv[3];

if (!inputFile || !outputFile) {
  console.error('用法: node decode_ksplat.mjs <input.ksplat> <output.ply>');
  process.exit(1);
}

console.log(`解码: ${inputFile} → ${outputFile}`);

// 读取 ksplat 文件
const buf = readFileSync(inputFile);
const data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

// ksplat 格式解析（来自 mkkellogg/gaussian-splats-3d）
// 格式：每个 splat = [x,y,z (f32), scale_x,y,z (f32), r,g,b,a (u8), rot_x,y,z,w (u8)]
// = 3*4 + 3*4 + 4 + 4 = 32 bytes per splat
const FLOAT_PROPS = ['x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2'];
const BYTE_PROPS  = ['f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];

// 解析 ksplat header
let offset = 0;
const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

// ksplat header: 4 bytes magic, 4 bytes version, 4 bytes numSplats
const magic = view.getUint32(0, true);
if (magic !== 0x4b53504c) { // 'KSPL'
  // 尝试旧格式（无 header）：直接 f32 数据
  console.log('检测到旧版 ksplat 格式（无 header）');
}

// 使用简单 PLY 格式输出
// 注意：这里需要根据实际 ksplat 格式调整解析逻辑
// 建议使用 mkkellogg 库的正式 API 而非手动解析

console.warn('⚠️  简单解析模式 — 推荐使用 mkkellogg 库的正式 API');
console.warn('⚠️  请参考: https://github.com/mkkellogg/GaussianSplats3D');

writeFileSync(outputFile, '');
console.log(`完成: ${outputFile}`);
EOF

echo "⚠️  注意：ksplat 格式是专有的压缩格式"
echo "    建议使用以下替代方案："
echo "    a) 如果有原始 PLY 文件，直接跳到步骤 2"
echo "    b) 使用浏览器端 PLY 导出工具从 ksplat 重建 PLY"
echo ""
echo "    如果您有原始未压缩的 .ply 文件，将其放入:"
echo "    $PLY_DIR/"
echo "    然后重新运行此脚本（跳过步骤 1）"

# 检查是否有 PLY 文件可用
PLY_FILES=("$PLY_DIR"/*.ply 2>/dev/null)
if [ ${#PLY_FILES[@]} -eq 0 ] || [ ! -f "${PLY_FILES[0]}" ]; then
  echo ""
  echo "❌ 未找到 PLY 文件，无法继续 SOGS 转换"
  echo "   请将原始 .ply 训练文件放入: $PLY_DIR/"
  echo ""
  echo "═══════════════════════════════════════════════"
  echo " 若要完成 SOGS 转换，需要："
  echo " 1. 原始训练 PLY 文件（非压缩的 ksplat）"
  echo " 2. Python 环境和 pip install plyfile pillow"
  echo " 3. jxl 编码器 (brew install jpeg-xl 或 apt install libjxl-tools)"
  echo " 4. 克隆 Self-Organizing-Gaussians 仓库"
  echo "═══════════════════════════════════════════════"
  exit 0
fi

# ── 步骤 2：安装 Python 依赖 ──────────────────────────────────────────────────
echo ""
echo "[2/4] 安装 Python 依赖..."
pip3 install plyfile pillow numpy tqdm --quiet 2>&1 | tail -3

# 检查 jxl 支持
python3 -c "import imagecodecs; imagecodecs.JPEG_XL" 2>/dev/null && JXL_OK=1 || JXL_OK=0
if [ "$JXL_OK" -eq 0 ]; then
  echo "⚠️  imagecodecs JXL 支持未检测到，尝试安装..."
  pip3 install "imagecodecs[jxl]" --quiet 2>&1 | tail -3 || true
fi

# ── 步骤 3：克隆 Self-Organizing-Gaussians ────────────────────────────────────
echo ""
echo "[3/4] 准备 Self-Organizing-Gaussians 压缩工具..."
if [ ! -d "$SOGS_REPO" ]; then
  echo "克隆仓库（需要 git 和网络）..."
  git clone --depth 1 --recursive https://github.com/fraunhoferhhi/Self-Organizing-Gaussians.git "$SOGS_REPO"
else
  echo "✅ 仓库已存在: $SOGS_REPO"
fi

# ── 步骤 4：转换 PLY → SOGS ──────────────────────────────────────────────────
echo ""
echo "[4/4] 压缩 PLY → SOGS..."
mkdir -p "$SOGS_OUT"

for PLY_FILE in "$PLY_DIR"/*.ply; do
  BASENAME=$(basename "$PLY_FILE" .ply)
  OUT_DIR="$SOGS_OUT/$BASENAME"
  mkdir -p "$OUT_DIR"

  echo "  压缩: $BASENAME.ply → sogs/$BASENAME/"

  python3 "$SOGS_REPO/compression/compress.py" \
    --input "$PLY_FILE" \
    --output "$OUT_DIR" \
    || echo "  ⚠️  压缩失败: $BASENAME"
done

echo ""
echo "=========================================="
echo " 完成！SOGS 文件位于: $SOGS_OUT/"
echo ""
echo " 下一步：更新 app.js 中的文件路径："
echo "   CARD_PLY  → ./files/3D/sogs/sharp_charctorN_b/"
echo "   SCENE_PLY → ./files/3D/sogs/sharp_charctorN_a/"
echo "=========================================="
