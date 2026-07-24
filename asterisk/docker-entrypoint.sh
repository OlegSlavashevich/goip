#!/bin/sh
set -eu

: "${PUBLIC_IP:?PUBLIC_IP must be set to the VM public IPv4 address}"
: "${GOIP_PUBLIC_IP:?GOIP_PUBLIC_IP must be set to the GoIP public IPv4 address}"
: "${SIP_USERNAME:?SIP_USERNAME must be set}"
: "${SIP_PASSWORD:?SIP_PASSWORD must be set}"
: "${LOCAL_NETWORK:=172.16.0.0/12}"
: "${RECORD_CALLS:=true}"

export PUBLIC_IP GOIP_PUBLIC_IP SIP_USERNAME SIP_PASSWORD LOCAL_NETWORK RECORD_CALLS
envsubst '${PUBLIC_IP} ${GOIP_PUBLIC_IP} ${SIP_USERNAME} ${SIP_PASSWORD} ${LOCAL_NETWORK}' \
  < /opt/goip-config/pjsip.conf.template \
  > /etc/asterisk/pjsip.conf
envsubst '${RECORD_CALLS}' \
  < /opt/goip-config/extensions.conf.template \
  > /etc/asterisk/extensions.conf

mkdir -p /var/spool/asterisk/monitor/goip-ai-bridge
chown -R asterisk:asterisk /var/spool/asterisk/monitor/goip-ai-bridge
chown asterisk:asterisk /etc/asterisk/pjsip.conf /etc/asterisk/extensions.conf
chmod 0640 /etc/asterisk/pjsip.conf /etc/asterisk/extensions.conf

exec asterisk -f -U asterisk -G asterisk -vvv
