# Чистая проверочная ОС: только системные библиотеки Electron, виртуальный экран и генератор тестовой речи.
FROM ubuntu:22.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    xvfb xauth espeak-ng libgtk-3-0 libnss3 libgbm1 libasound2 libxss1 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
