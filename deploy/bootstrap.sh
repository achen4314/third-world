#!/usr/bin/env bash
# 第三世界 · 服务器一键引导
#
#   用法（在服务器上以 root 执行，不需要先上传任何文件）：
#     ARC_ADMIN_TOKEN='<16位以上随机串>' bash bootstrap.sh          # 默认 https（443 独占）
#     ARC_ADMIN_TOKEN='<16位以上随机串>' bash bootstrap.sh http     # 过渡：IP:8080 验收
#
#   它只做三件事：取回代码 → 交给 install.sh → 打印结果。
#   取代码优先走 HTTPS 克隆（443），不依赖 GitHub 的 raw 域名。
#
#   绝不触碰：80 端口、Dify 的任何容器/目录、主机 nginx、数据库
set -euo pipefail

MODE="${1:-https}"
ROOT="${ARC_ROOT:-/opt/arc-training}"
REPO="${ARC_REPO:-https://github.com/achen4314/third-world.git}"
BRANCH="${ARC_BRANCH:-main}"
TOKEN="${ARC_ADMIN_TOKEN:-}"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
warn()  { printf '\033[33m%s\033[0m\n' "$*"; }
die()   { red "✗ $*"; exit 1; }

[[ $EUID -eq 0 ]] || die "请用 root 执行（sudo -i 后再跑）"
[[ -n "$TOKEN" && ${#TOKEN} -ge 16 ]] || die "请设置 ARC_ADMIN_TOKEN，至少 16 位：ARC_ADMIN_TOKEN='xxxxxxxxxxxxxxxx' bash bootstrap.sh"
[[ "$MODE" == "https" || "$MODE" == "http" ]] || die "模式只能是 https 或 http"

echo "== 0/4 环境检查 =="
. /etc/os-release 2>/dev/null || true
green "    ${PRETTY_NAME:-unknown}"
MEM_MB=$(awk '/MemTotal/{printf "%d", $2/1024}' /proc/meminfo)
green "    内存 ${MEM_MB} MB · 磁盘剩余 $(df -h /opt 2>/dev/null | awk 'NR==2{print $4}')"

# 80 端口不该由我们占用；只做告知，不做处置
if command -v ss >/dev/null && ss -lnt 2>/dev/null | grep -q ':80 '; then
  warn "    80 端口已有进程在监听（预期是 Dify）——本脚本不会去动它"
fi
if [[ "$MODE" == "https" ]] && command -v ss >/dev/null && ss -lnt 2>/dev/null | grep -q ':443 '; then
  die "443 已被占用，停止（不会强抢）。请先确认是谁在监听：ss -lntp | grep ':443 '"
fi

echo "== 1/4 安装基础工具 =="
need=()
command -v git  >/dev/null || need+=(git)
command -v curl >/dev/null || need+=(curl)
if [[ ${#need[@]} -gt 0 ]]; then
  green "    安装：${need[*]}"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${need[@]}" >/dev/null
fi
green "    git $(git --version | awk '{print $3}')"

echo "== 2/4 取回代码 → $ROOT =="
mkdir -p "$(dirname "$ROOT")"
if [[ -d "$ROOT/.git" ]]; then
  green "    已有仓库，原地更新（保留 env.js 等运行时文件）"
  git -C "$ROOT" remote set-url origin "$REPO"
  git -C "$ROOT" fetch -q --depth 1 origin "$BRANCH"
  git -C "$ROOT" checkout -q -B "$BRANCH" "origin/$BRANCH"
  git -C "$ROOT" reset -q --hard "origin/$BRANCH"
else
  green "    全新克隆"
  rm -rf "$ROOT"
  git clone -q --depth 1 --branch "$BRANCH" "$REPO" "$ROOT"
fi
green "    版本 $(git -C "$ROOT" rev-parse --short HEAD) · $(git -C "$ROOT" log -1 --format=%s | cut -c1-50)"

echo "== 3/4 交给安装脚本（模式：$MODE）=="
cd "$ROOT"
ARC_MODE="$MODE" ARC_ADMIN_TOKEN="$TOKEN" ARC_DOMAIN="${ARC_DOMAIN:-trthirdworld.online}" \
  bash deploy/install.sh

echo
echo "== 4/4 结果 =="
IP=$(curl -sS --max-time 6 https://api.ipify.org 2>/dev/null || echo "?")
D="${ARC_DOMAIN:-trthirdworld.online}"
if [[ "$MODE" == "https" ]]; then
  green "    尝试访问： https://$D/"
  warn  "    若返回 403 / Non-compliance ICP Filing：域名未备案，被机房拦截（与本次部署无关）"
  green "    后台入口： https://$D/admin/"
else
  green "    访问地址： http://$IP:8080/"
  warn  "    过渡模式：无 HTTPS。备案通过后改用： ARC_ADMIN_TOKEN='…' bash bootstrap.sh https"
  green "    后台入口： http://$IP:8080/admin/"
fi
echo
green "    验证没打扰 80 上的现有服务："
curl -sS --max-time 6 -o /dev/null -w "      http://$IP/ → %{http_code}（应仍为 307）\n" "http://$IP/" || true
