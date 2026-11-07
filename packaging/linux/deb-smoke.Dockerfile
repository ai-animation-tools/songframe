# Чистая Ubuntu 24.04 без GTK/WebKit: apt ставит deb-пакет со всеми его Depends без
# Recommends. Так проверяется, что Depends достаточно для запуска; X-сервер и D-Bus —
# только средства проверки. Сам запуск выполняется без сети обычным пользователем.
FROM ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852
COPY songframe.deb /tmp/songframe.deb
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    dbus-x11 xvfb xauth /tmp/songframe.deb \
    && rm -rf /var/lib/apt/lists/* /tmp/songframe.deb
USER 1000:1000
ENV HOME=/tmp/home XDG_RUNTIME_DIR=/tmp/runtime
CMD ["/bin/false"]
