#!/usr/bin/env bash
# Готовит мультимедиа для CI; медленная загрузка заменяется обычным пакетом Ubuntu. @link README.md
set -euo pipefail

media_dir="${RUNNER_TEMP:?}/songframe-ci-ffmpeg"
if timeout 180s python -B tools/run_tests/prepare_ci_ffmpeg.py --directory "$media_dir"; then
  export PATH="$media_dir/bin:$PATH"
  echo "$media_dir/bin" >> "${GITHUB_PATH:?}"
else
  echo 'Не удалось быстро подготовить закреплённый FFmpeg; устанавливаем пакет Ubuntu.'
  apt_dir="$RUNNER_TEMP/songframe-ci-apt"
  mkdir -p "$apt_dir/archives/partial" "$apt_dir/lists/partial"
  sudo apt-get -o "Dir::Cache::archives=$apt_dir/archives" -o "Dir::State::lists=$apt_dir/lists" update
  sudo apt-get -o "Dir::Cache::archives=$apt_dir/archives" -o "Dir::State::lists=$apt_dir/lists" install -y --no-install-recommends ffmpeg
fi
command -v ffmpeg
command -v ffprobe
ffmpeg -version > /dev/null
ffprobe -version > /dev/null
