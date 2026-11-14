#!/usr/bin/env bash
# 第三世界 · 服务器端安装脚本（幂等 / 可重跑 / 不碰 80 上的现有服务）
#
#   ARC_MODE=https  ARC_ADMIN_TOKEN='<32位以上随机串>'  bash install.sh   # 域名 + 自动 HTTPS（443）
#   ARC_MODE=http   ARC_ADMIN_TOKEN='<32位以上随机串>'  bash install.sh   # 先用 IP:8080 验收
#
# 环境变量：
#   ARC_MODE           https(默认，443) | http(8080)
#   ARC_ADMIN_TOKEN    后台口令，必填，≥16 位
#   ARC_DOMAIN         默认 trthirdworld.online
#   ARC_ROOT           默认 /opt/arc-training
#   ARC_SUPABASE_URL   仅首次生成 env.js 时用
#   ARC_SUPABASE_KEY    同上（只接受 sb_publishable_…）
#
# 明确不做的事：
#   ✗ 不停止/重配 Dify 或任何已有容器
#   ✗ 不占用 80 端口（Dify 的 nginx 在用）
#   ✗ 不覆盖已存在的 prototype/env.js（后台改过的配置不会被冲掉）
#   ✗ 不碰数据库、不改任何密码

set -euo pipefail

MODE="${ARC_MODE:-https}"
ROOT="${ARC_ROOT:-/opt/arc-training}"
DOMAIN="${ARC_DOMAIN:-trthirdworld.online}"
TOKEN="${ARC_ADMIN_TOKEN:-}"
SUPA_URL="${ARC_SUPABASE_URL:-https://bffuuxdnztowlwbxjlzp.supabase.co}"
SUPA_KEY="${ARC_SUPABASE_KEY:-}"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
warn()  { printf '\033[33m%s\033[0m\n' "$*"; }

die() { red "✗ $*"; exit 1; }

# ── 0. 前置校验 ─────────────────────────────────────────────
[[ $EUID -eq 0 ]] || die "请用 root 执行"
[[ -n "$TOKEN" && ${#TOKEN} -ge 16 ]] || die "ARC_ADMIN_TOKEN 至少 16 位，且不要写进仓库"
[[ -f "$ROOT/prototype/index.html" ]] || die "找不到 $ROOT/prototype/index.html（先把项目放上去）"
[[ -f "$ROOT/deploy/admin-console.mjs" ]] || die "找不到 $ROOT/deploy/admin-console.mjs"

port_busy() {
  if command -v ss >/dev/null; then ss -lnt 2>/dev/null | awk -v P=":$1\$" '$4 ~ P {f=1} END{exit !f}'
  else return 1; fi
}

if [[ "$MODE" == "https" ]]; then
  port_busy 443 && die "443 已被占用：先跑 server-preflight.sh 看清是谁，不要强占。"
else
  port_busy 8080 && die "8080 已被占用；换 ARC_PORT 或先查清占用者。"
fi
port_busy 8787 && die "8787 已被占用（控制台内部端口）；先查清再装。"

# node
if ! command -v node >/dev/null; then
  warn "未安装 node，尝试 apt 安装（Ubuntu 24.04 自带 18.x 即可满足）"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq && apt-get install -y -qq nodejs npm >/dev/null || die "node 安装失败"
fi
NODE_BIN=$(command -v node)
NODE_MAJOR=$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')
[[ "$NODE_MAJOR" -ge 18 ]] || die "node 版本过低（$("$NODE_BIN" -v)），需要 ≥18"

# 这台机器还跑着 Dify（实测内存 2.67/4.0 GiB），别把内存吃满把人家的服务 OOM 掉
MEM_AVAIL_MB=$(awk '/MemAvailable/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 9999)
if [[ "$MEM_AVAIL_MB" -lt 300 ]]; then
  warn "可用内存只有 ${MEM_AVAIL_MB}MB（Dify 占了不少）：装完请盯一下 free -m，必要时给 Caddy 加 memory 限制"
fi

echo "── 1/7 目录与权限 ─────────────────────────────────"
install -d -m 755 "$ROOT/deploy/runtime"
install -d -m 750 /etc/arc-training
chmod 755 "$ROOT" "$ROOT/prototype"
chmod 644 "$ROOT"/prototype/*.js "$ROOT"/prototype/*.html "$ROOT"/prototype/*.css 2>/dev/null || true
green "    ✓ $ROOT 就绪"

echo "── 2/7 后台口令 ───────────────────────────────────"
umask 077
{
  printf 'ARC_ADMIN_TOKEN=%s\n' "$TOKEN"
  printf 'ARC_DOMAIN=%s\n' "$DOMAIN"
} > /etc/arc-training/admin.env
chmod 600 /etc/arc-training/admin.env
chown root:root /etc/arc-training/admin.env
green "    ✓ /etc/arc-training/admin.env（0600，root only）"

echo "── 3/7 前端连接配置 env.js ────────────────────────"
if [[ -f "$ROOT/prototype/env.js" ]] && grep -q 'SUPABASE_URL' "$ROOT/prototype/env.js" \
   && ! grep -q 'SUPABASE_PUBLISHABLE_KEY: ""' "$ROOT/prototype/env.js"; then
  green "    ✓ 已有 env.js，保持不动（后台改过的配置不会被覆盖）"
else
  [[ -n "$SUPA_KEY" ]] || warn "    未提供 ARC_SUPABASE_KEY：先写占位，之后在后台控制台填 key"
  cat > "$ROOT/prototype/env.js" <<EOF
/* 由 install.sh 生成 · $(date -Is) */
window.ARC_ENV = {
  SUPABASE_URL: "$SUPA_URL",
  SUPABASE_PUBLISHABLE_KEY: "$SUPA_KEY",
  ALLOW_RUNTIME_KEY: false
};
EOF
  chmod 644 "$ROOT/prototype/env.js"
  green "    ✓ env.js 已生成"
fi

echo "── 4/7 控制台服务 ─────────────────────────────────"
sed -e "s#__NODE__#$NODE_BIN#" "$ROOT/deploy/arc-admin.service" > /etc/systemd/system/arc-admin.service
systemctl daemon-reload
systemctl enable arc-admin >/dev/null 2>&1
systemctl restart arc-admin
sleep 1
[[ "$(systemctl is-active arc-admin)" == "active" ]] || {
  journalctl -u arc-admin -n 20 --no-pager || true
  die "arc-admin 启动失败（见上面日志）"
}
green "    ✓ arc-admin active（127.0.0.1:8787）"

echo "── 5/7 门面（Caddy，独占 443 / 或 8080）───────────"
if ! command -v caddy >/dev/null; then
  warn "未安装 caddy，从 apt 安装（universe 源）"
  export DEBIAN_FRONTEND=noninteractive
  apt-get install -y -qq caddy >/dev/null || die "caddy 安装失败（检查 universe 源或出网）"
fi
install -d -m 755 /var/log/caddy
# 不覆盖别人家的配置：如果这台机器上已有 Caddyfile 且不是我们生成的，先备份再写
CADDY_CONF=/etc/caddy/Caddyfile
if [[ -f "$CADDY_CONF" ]] && ! grep -q 'ARC-MANAGED' "$CADDY_CONF"; then
  BAK="$CADDY_CONF.bak.$(date +%s)"
  cp -a "$CADDY_CONF" "$BAK"
  warn "发现已有 Caddyfile（非本项目生成），已备份到 $BAK —— 若它服务着别的东西，请先确认再继续"
fi
if [[ "$MODE" == "https" ]]; then
  sed "s/__DOMAIN__/$DOMAIN/g" "$ROOT/deploy/Caddyfile" > /etc/caddy/Caddyfile
  chown -R caddy:caddy /var/log/caddy 2>/dev/null || true
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 \
    || { caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; die "Caddyfile 校验失败"; }
  systemctl enable caddy >/dev/null 2>&1
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
  green "    ✓ Caddy 已接管 443（证书自动申请；80 未动）"
else
  install -m 644 "$ROOT/deploy/Caddyfile.http" /etc/caddy/Caddyfile
  systemctl enable caddy >/dev/null 2>&1
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
  green "    ✓ Caddy 已在 :8080 提供 HTTP（证书稍后补）"
fi
sleep 1
[[ "$(systemctl is-active caddy)" == "active" ]] || { journalctl -u caddy -n 20 --no-pager; die "caddy 启动失败"; }

echo "── 6/7 自检 ───────────────────────────────────────"
probe() { # label url extra...
  local label="$1" url="$2"; shift 2
  local code
  code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 "$@" "$url" || echo 000)
  printf '    %-28s %s\n' "$label" "$code"
}

if [[ "$MODE" == "https" ]]; then
  probe "控制台页 /admin/"      "https://127.0.0.1/admin/"   -H "Host: $DOMAIN"
  probe "无口令 /api/config"    "https://127.0.0.1/api/config" -H "Host: $DOMAIN"   # 期望 401
  probe "静态站 /"              "https://127.0.0.1/"         -H "Host: $DOMAIN"
  probe "env.js"                "https://127.0.0.1/env.js"   -H "Host: $DOMAIN"
else
  probe "控制台页 /admin/"      "http://127.0.0.1:8080/admin/"
  probe "无口令 /api/config"    "http://127.0.0.1:8080/api/config"   # 期望 401
  probe "静态站 /"              "http://127.0.0.1:8080/"
fi

echo "── 7/7 下一步提示 ─────────────────────────────────"
PUBIP=$(curl -s --max-time 6 https://api.ipify.org 2>/dev/null || echo "?")
echo "    本机公网 IP：$PUBIP"
RESOLVED=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1{print $1}')
echo "    $DOMAIN → ${RESOLVED:-<无 A 记录>}"
if [[ -z "$RESOLVED" ]]; then
  warn "    ⚠ 域名还没有 A 记录：去云解析加两条（@ 和 www → $PUBIP），否则外网打不开"
elif [[ -n "$PUBIP" && "$RESOLVED" != "$PUBIP" ]]; then
  warn "    ⚠ 解析地址与本机公网 IP 不一致，请核对 A 记录"
else
  green "    ✓ 解析正常"
fi
echo "    ⚠ 云厂商防火墙（轻量应用服务器「防火墙」页）需放行 $([[ "$MODE" == "https" ]] && echo 443 || echo 8080)"
echo "    ⚠ 大陆机房 + 域名对外提供 Web 服务需完成 ICP 备案，未备案会被拦"
echo
if [[ "$MODE" == "https" ]]; then
  echo "入口： https://$DOMAIN/    后台： https://$DOMAIN/admin/"
else
  echo "入口： http://$PUBIP:8080/  后台： http://$PUBIP:8080/admin/"
fi
echo "（口令见 /etc/arc-training/admin.env）"
