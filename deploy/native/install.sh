#!/bin/sh
set -eu

PROJECT_DIR=${1:-/opt/goip-ai-bridge}
ENV_FILE=/etc/goip-ai-bridge.env

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this script as root." >&2
  exit 1
fi

if [ ! -f "$PROJECT_DIR/bridge/package.json" ]; then
  echo "Project not found in $PROJECT_DIR" >&2
  echo "Copy it there first, or pass its absolute path as the first argument." >&2
  exit 1
fi

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  asterisk \
  ca-certificates \
  gettext-base \
  nodejs \
  npm

cd "$PROJECT_DIR/bridge"
npm ci --omit=dev

if ! id goip-bridge >/dev/null 2>&1; then
  adduser --system --group --home /var/lib/goip-ai-bridge goip-bridge
fi

install -d -o goip-bridge -g goip-bridge -m 0750 \
  /var/lib/goip-ai-bridge \
  /var/lib/goip-ai-bridge/recordings

if [ ! -f "$ENV_FILE" ]; then
  install -o root -g root -m 0600 \
    "$PROJECT_DIR/deploy/native/goip-ai-bridge.env.example" \
    "$ENV_FILE"
  echo
  echo "Created $ENV_FILE"
  echo "Edit SIP_PASSWORD, then run this script again:"
  echo "  nano $ENV_FILE"
  echo "  sh $PROJECT_DIR/deploy/native/install.sh $PROJECT_DIR"
  exit 0
fi

if grep -q '^SIP_PASSWORD=CHANGE_ME' "$ENV_FILE"; then
  echo "Set SIP_PASSWORD in $ENV_FILE before continuing." >&2
  exit 1
fi

set -a
. "$ENV_FILE"
set +a

: "${PUBLIC_IP:?PUBLIC_IP must be set in $ENV_FILE}"
: "${SIP_USERNAME:?SIP_USERNAME must be set in $ENV_FILE}"
: "${SIP_PASSWORD:?SIP_PASSWORD must be set in $ENV_FILE}"
: "${LOCAL_NETWORK:=127.0.0.0/8}"
export PUBLIC_IP SIP_USERNAME SIP_PASSWORD LOCAL_NETWORK

envsubst '${PUBLIC_IP} ${SIP_USERNAME} ${SIP_PASSWORD} ${LOCAL_NETWORK}' \
  < "$PROJECT_DIR/asterisk/etc/asterisk/pjsip.conf.template" \
  > /etc/asterisk/pjsip.conf

install -o root -g asterisk -m 0640 \
  "$PROJECT_DIR/deploy/native/extensions.conf" \
  /etc/asterisk/extensions.conf
install -o root -g asterisk -m 0640 \
  "$PROJECT_DIR/asterisk/etc/asterisk/rtp.conf" \
  /etc/asterisk/rtp.conf
chown root:asterisk /etc/asterisk/pjsip.conf
chmod 0640 /etc/asterisk/pjsip.conf

install -o root -g root -m 0644 \
  "$PROJECT_DIR/deploy/native/goip-ai-bridge.service" \
  /etc/systemd/system/goip-ai-bridge.service

systemctl daemon-reload
systemctl enable goip-ai-bridge.service asterisk.service
systemctl restart goip-ai-bridge.service
systemctl restart asterisk.service

echo
echo "Native GoIP bridge installed."
echo "Check:"
echo "  systemctl --no-pager --full status goip-ai-bridge asterisk"
echo "  journalctl -u goip-ai-bridge -u asterisk -f"

