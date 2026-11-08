# Проверочная система содержит WebView prerequisites, но не GTK/WebKit, FFmpeg, ORT, Node или Go.
# Сама проверка выполняется без сети и с непривилегированным пользователем.
FROM ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates bubblewrap xdg-dbus-proxy dbus-x11 xvfb xauth \
    libgl1 libegl1 libgles2 libgl1-mesa-dri libgbm1 libasound2t64 fonts-dejavu-core \
    libgstreamer-gl1.0-0 gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-libav \
    && rm -rf /var/lib/apt/lists/*
USER 1000:1000
ENV HOME=/tmp/home XDG_RUNTIME_DIR=/tmp/runtime
CMD ["/bin/false"]
