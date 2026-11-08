# Синтетические медиафикстуры

Три коротких файла проверяют именно чтение форматов: проверяемая сборка не обязана иметь кодировщики FLAC, VP8/VP9, Vorbis/Opus. Это локально созданные тон 440 Гц и красная картинка, без пользовательских клипов и сторонних материалов. `tiny.flac` содержит 0,2 секунды mono16k; каждый WebM — два кадра 64×36 при 10 FPS и тот же тон.

Файлы созданы 3 ноября 2026 года полным BtbN FFmpeg `n8.1.3-9-g29e619e767-20260930`. Размеры и SHA-256 закреплены в [hashes.json](hashes.json); проверка [check-media-capabilities.sh](../../scripts/check-media-capabilities.sh) сверяет их перед декодированием PCM, видео и реальных PTS. Для обработки используются только эти три файла; PNG/WAV-исходники создаются во временном каталоге подкомандой `media-sources` инструмента [packtool](../../scripts/packtool/main.go) и удаляются. Суммарный размер бинарных фикстур — 7267 байт.

Воспроизведение из корня репозитория с **полной** сборкой FFmpeg, только в пустой папке назначения:

```sh
MEDIA_FFMPEG=/путь/к/полному/ffmpeg
fixture_sources=$(mktemp -d '/tmp/SongFrame исходники.XXXXXXXX')
trap 'rm -rf -- "$fixture_sources"' EXIT
go run ./scripts/packtool media-sources "$fixture_sources"
"$MEDIA_FFMPEG" -hide_banner -v error -nostdin -n \
  -i "$fixture_sources/Тон.wav" -c:a flac -metadata_header_padding 0 testdata/components/tiny.flac
"$MEDIA_FFMPEG" -hide_banner -v error -nostdin -n \
  -loop 1 -framerate 10 -i "$fixture_sources/Опора.png" -i "$fixture_sources/Тон.wav" -t 0.2 \
  -c:v libvpx -deadline realtime -cpu-used 8 -b:v 50k -pix_fmt yuv420p \
  -c:a libvorbis -q:a 0 testdata/components/vp8-vorbis.webm
"$MEDIA_FFMPEG" -hide_banner -v error -nostdin -n \
  -loop 1 -framerate 10 -i "$fixture_sources/Опора.png" -i "$fixture_sources/Тон.wav" -t 0.2 \
  -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -b:v 50k -pix_fmt yuv420p \
  -c:a libopus -b:a 16k testdata/components/vp9-opus.webm
```

Контейнеры WebM могут получать новые случайные идентификаторы при повторной генерации; обещания одинаковых байтов нет. При намеренной замене фикстур сначала проверить кодеки/длительность и успешное декодирование, затем обновить реестр:

```sh
go run ./scripts/packtool media-hashes testdata/components
```
