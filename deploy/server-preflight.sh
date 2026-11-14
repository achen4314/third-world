#!/usr/bin/env bash
# 第三世界 · 服务器只读巡查（不改任何东西，可安全重复执行）
#
#   bash server-preflight.sh            # 人读
#   bash server-preflight.sh --json     # 机读
#
# 目的：在动任何配置之前，先弄清这台机器上已经有什么。
# 全部命令只读；不装包、不改服务、不写 /etc。

set -uo pipefail
JSON=0
[[ "${1:-}" == "--json" ]] && JSON=1

say() { [[ $JSON -eq 0 ]] && echo "$@"; }

have() { command -v "$1" >/dev/null 2>&1; }

# ── 端口占用：谁在听 ──────────────────────────────────────────
port_owner() {
  local p="$1"
  if have ss; then ss -lntp 2>/dev/null | awk -v P=":$p" '$4 ~ P"$" {print $4"  "$6}' | head -3
  elif have netstat; then netstat -lntp 2>/dev/null | awk -v P=":$p" '$4 ~ P"$" {print $4"  "$7}' | head -3
  fi
}

PORT80=$(port_owner 80)
PORT443=$(port_owner 443)
PORT8787=$(port_owner 8787)

# ── Docker ───────────────────────────────────────────────────
DOCKER_OK=0
CONTAINERS=""
if have docker; then
  if docker info >/dev/null 2>&1; then
    DOCKER_OK=1
    CONTAINERS=$(docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}' 2>/dev/null | head -20)
  fi
fi

# ── 现有 web 服务 ────────────────────────────────────────────
HOST_NGINX=0; have nginx && HOST_NGINX=1
HOST_CADDY=0; have caddy && HOST_CADDY=1
NGINX_SITES=""
if [[ $HOST_NGINX -eq 1 ]]; then
  NGINX_SITES=$(grep -rhoE '^\s*server_name\s+[^;]+' /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null | sed 's/^[[:space:]]*//' | head -20)
fi

# ── 运行环境 ─────────────────────────────────────────────────
NODE_V=$(have node && node -v || echo "-")
NPM_V=$(have npm && npm -v || echo "-")
OS_V=$(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || uname -sr)
MEM_MB=$(awk '/MemTotal/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)
DISK=$(df -Pk / 2>/dev/null | awk 'NR==2{printf "%d/%dMB (%s)", $3/1024, $2/1024, $5}')

# ── 防火墙 ───────────────────────────────────────────────────
UFW=$(have ufw && (ufw status 2>/dev/null | head -1) || echo "-")
FW_CMD=$(have firewall-cmd && firewall-cmd --state 2>/dev/null || echo "-")

# ── 已被占用的目录 ───────────────────────────────────────────
OCCUPIED=""
for d in /opt/dify /opt/*/docker-compose.yaml /root/dify /www/wwwroot /var/www; do
  [[ -e "$d" ]] && OCCUPIED+="$d "
done

# ── 出网能力（决定能不能装包 / 签证书）───────────────────────
NET_SUPA=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 https://bffuuxdnztowlwbxjlzp.supabase.co/auth/v1/settings 2>/dev/null || echo "000")
NET_LE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 https://acme-v02.api.letsencrypt.org/directory 2>/dev/null || echo "000")
NET_NPM=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 https://registry.npmjs.org/ 2>/dev/null || echo "000")

PUBIP=$(curl -s --max-time 6 https://api.ipify.org 2>/dev/null || echo "?")

if [[ $JSON -eq 1 ]]; then
  cat <<EOF
{
  "time": "$(date -Is)",
  "host": "$(hostname)",
  "os": "$(echo "$OS_V" | sed 's/"/\\"/g')",
  "publicIp": "$PUBIP",
  "memMB": $MEM_MB,
  "disk": "$DISK",
  "node": "$NODE_V",
  "npm": "$NPM_V",
  "nginxHost": $HOST_NGINX,
  "caddyHost": $HOST_CADDY,
  "docker": $DOCKER_OK,
  "port80": "$(echo "$PORT80" | tr '\n' ';')",
  "port443": "$(echo "$PORT443" | tr '\n' ';')",
  "port8787": "$(echo "$PORT8787" | tr '\n' ';')",
  "ufw": "$(echo "$UFW" | tr '\n' ';')",
  "net": {"supabase": "$NET_SUPA", "letsencrypt": "$NET_LE", "npm": "$NET_NPM"}
}
EOF
  exit 0
fi

cat <<EOF
══════════════════════════════════════════════════
 第三世界 · 服务器巡查 $(date '+%F %T')
══════════════════════════════════════════════════
主机            $(hostname)   $OS_V
公网 IP         $PUBIP
内存 / 磁盘     ${MEM_MB}MB   $DISK
Node / npm      $NODE_V  /  $NPM_V

── 端口 80 ────────────────────────────────────
${PORT80:-（无人监听）}

── 端口 443 ───────────────────────────────────
${PORT443:-（空闲 ✓）}

── 端口 8787（我们的控制台打算用）─────────────
${PORT8787:-（空闲 ✓）}

── Docker ─────────────────────────────────────
EOF
if [[ $DOCKER_OK -eq 1 ]]; then
  printf '%s\n' "${CONTAINERS:-（无运行中容器）}" | sed 's/^/  /'
else
  echo "  未安装或不可用"
fi

cat <<EOF

── 主机级 web 服务 ────────────────────────────
主机 nginx      $([[ $HOST_NGINX -eq 1 ]] && echo "已安装 $(nginx -v 2>&1 | sed 's#nginx version: ##')" || echo "未安装")
主机 caddy      $([[ $HOST_CADDY -eq 1 ]] && caddy version 2>/dev/null | head -1 || echo "未安装")
EOF
if [[ -n "$NGINX_SITES" ]]; then
  echo "现有 server_name:"; printf '%s\n' "$NGINX_SITES" | sed 's/^/  /'
fi

cat <<EOF

── 防火墙 ─────────────────────────────────────
ufw             $UFW
firewalld       $FW_CMD

── 已存在的站点目录 ───────────────────────────
${OCCUPIED:-（/opt、/var/www 下没有常见站点）}

── 出网能力 ───────────────────────────────────
Supabase        $NET_SUPA   $([[ "$NET_SUPA" == "200" ]] && echo "✓ 可连" || echo "✗ 需排查")
Let's Encrypt   $NET_LE    $([[ "$NET_LE" == "200" ]] && echo "✓ 可签证书" || echo "✗ HTTPS 签不了")
npm registry    $NET_NPM   $([[ "$NET_NPM" == "200" ]] && echo "✓" || echo "✗")

══════════════════════════════════════════════════
EOF

# ── 结论 ─────────────────────────────────────────────────────
echo "结论："
if [[ -n "$PORT443" ]]; then
  echo "  ⚠ 443 已被占用，部署前必须先决定是否让位；不要直接覆盖。"
else
  echo "  ✓ 443 空闲，可以用它给 ARC 做 HTTPS 门面，完全不碰 80 上的现有站点。"
fi
if echo "$PORT80" | grep -qi docker; then
  echo "  • 80 端口由 Docker 代理持有 —— 主机 nginx 的 conf.d 加 vhost 对它无效，不要走那条路。"
fi
if [[ "$NET_LE" != "200" ]]; then
  echo "  • 签不到证书：先只用 http://IP:8080 验证，再补 TLS。"
fi
