FROM debian:bookworm-slim

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       asterisk \
       ca-certificates \
       gettext-base \
    && rm -rf /var/lib/apt/lists/*

COPY etc/asterisk/pjsip.conf.template /opt/goip-config/pjsip.conf.template
COPY etc/asterisk/extensions.conf /etc/asterisk/extensions.conf
COPY etc/asterisk/rtp.conf /etc/asterisk/rtp.conf
COPY docker-entrypoint.sh /usr/local/bin/goip-asterisk-entrypoint

RUN chmod 0755 /usr/local/bin/goip-asterisk-entrypoint \
    && chown -R asterisk:asterisk /var/lib/asterisk /var/log/asterisk /var/run/asterisk /var/spool/asterisk

EXPOSE 5060/udp 10000-10099/udp

ENTRYPOINT ["/usr/local/bin/goip-asterisk-entrypoint"]

