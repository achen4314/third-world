#!/usr/bin/env bash
# 第三世界 · 服务器端安装脚本（幂等；不碰 Dify 现有配置）
#
# 在服务器上以 root 执行：
#   ARC_ADMIN_TOKEN='<你的长随机口令>' sudo -E bash /opt/arc-training/deploy/install.sh
#
# 前提：
#   1. 项目已放到 /opt/arc-training（git clone 或 rsync）
#   2. 已安装 node >= 18、nginx
#   3. 域名 A 记录已指向本机（脚本会检查，但不会替你改 DNS）
#   4. 大陆机房 + 域名公网访问：必须先完成 ICP 备案，否则 80/443 会被拦截
# 明确不做的事：不改 Dify 的 nginx server 块、不重装 nginx、不改数据库密码、不覆盖已有 env.js 以外任何业务文件。

set -euo pipefail
ROOT="${ARC_ROOT:-/opt/arc-training}"
DOMAIN="${ARC_DOMAIN:-app.trthirdworld.online}"
TOKEN="${ARC_ADMIN_TOKEN:-}"

if [[ $EUID -ne 0 ]]; then echo "✗ 请用 root 执行（sudo -E）"; exit 1; fi
if [[ -z "$TOKEN" || ${#TOKEN} -lt 16 ]]; then echo "✗ ARC_ADMIN_TOKEN 至少 16 位，且不要写进仓库"; exit 1; fi
if [[ ! -f "$ROOT/prototype/index.html" ]]; then echo "✗ 找不到 $ROOT/prototype/index.html"; exit 1; fi
command -v node >/dev/null || { echo "✗ 缺少 node"; exit 1; }
command -v nginx >/dev/null || { echo "✗ 缺少 nginx"; exit 1; }

echo "── 1/6 目录与权限 ──"
install -d -m 755 "$ROOT/deploy/runtime"
install -d -m 750 /etc/arc-training
chown -R www-data:www-data "$ROOT/prototype" "$ROOT/deploy/runtime"

echo "── 2/6 管理口令（0600，仅 root 可读）──"
umask 077
printf 'ARC_ADMIN_TOKEN=%s\nARC_DOMAIN=%s\n' "$TOKEN" "$DOMAIN" > /etc/arc-training/admin.env
chmod 600 /etc/arc-training/admin.env
chown root:root /etc/arc-training/admin.env

echo "── 3/6 nginx 增量配置（不动现有 server 块）──"
sed "s/app\.trthirdworld\.online/$DOMAIN/g" "$ROOT/deploy/nginx.arc-training.conf" > /etc/nginx/conf.d/arc-training.conf
nginx -t
systemctl reload nginx
echo "    ✓ nginx 已重载；Dify 的原有站点未改动"

echo "── 4/6 管理控制台服务 ──"
install -m 644 "$ROOT/deploy/arc-admin.service" /etc/systemd/system/arc-admin.service
systemctl daemon-reload
systemctl enable --now arc-admin
sleep 1
systemctl is-active arc-admin | sed 's/^/    ✓ 服务状态: /'

echo "── 5/6 本机自检 ──"
curl -fsS -o /dev/null -w '    静态站 HTTP %{http_code}\n' -H "Host: $DOMAIN" "http://127.0.0.1/" || true
curl -fsS -o /dev/null -w '    控制台 HTTP %{http_code}\n' "http://127.0.0.1/admin/" -H "Host: $DOMAIN" || true
curl -fsS -o /dev/null -w '    未带口令 /api/config -> %{http_code}（应为 401）\n' "http://127.0.0.1/api/config" -H "Host: $DOMAIN" || true

echo "── 6/6 域名解析检查 ──"
IP=$(curl -fsS --max-time 5 https://api.ipify.org || echo "")
CUR=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)
echo "    本机公网 IP: ${IP:-未知}"
echo "    $DOMAIN 解析到: ${CUR:-<无 A 记录>}"
if [[ -z "$CUR" ]]; then
  echo "    ⚠ 域名尚无 A 记录：请在云解析 DNS 添加 A 记录指向 $IP，等生效后再访问。"
elif [[ -n "$IP" && "$CUR" != "$IP" ]]; then
  echo "    ⚠ 解析到的地址与本机公网 IP 不一致，请核对 A 记录。"
else
  echo "    ✓ 解析正常"
fi

echo
echo "完成。入口： http://$DOMAIN/  后台： http://$DOMAIN/admin/"
echo "注意：大陆机房对外提供 Web 服务需先完成 ICP 备案；备案后再用 certbot 签 HTTPS。"
