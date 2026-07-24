#!/bin/sh
set -eu

: "${PUBLIC_IP:?PUBLIC_IP must be set to the VM public IPv4 address}"
: "${SIP_USERNAME:?SIP_USERNAME must be set}"
: "${SIP_PASSWORD:?SIP_PASSWORD must be set}"
: "${LOCAL_NETWORK:=172.16.0.0/12}"

export PUBLIC_IP SIP_USERNAME SIP_PASSWORD LOCAL_NETWORK
envsubst '${PUBLIC_IP} ${SIP_USERNAME} ${SIP_PASSWORD} ${LOCAL_NETWORK}' \
  < /opt/goip-config/pjsip.conf.template \
  > /etc/asterisk/pjsip.conf

chown asterisk:asterisk /etc/asterisk/pjsip.conf
chmod 0640 /etc/asterisk/pjsip.conf

exec asterisk -f -U asterisk -G asterisk -vvv

