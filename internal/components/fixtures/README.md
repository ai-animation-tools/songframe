# Встроенные синтетические входы медиапроверки

Эти несколько килобайт входят в Go-приложение через `embed`: рабочая проверка не зависит от внешних интерпретаторов, shell, текущего каталога или checkout. Здесь нет пользовательских клипов, моделей и сторонних материалов; изображение — красная заливка, звук — синтетический тон 440 Гц.

`tiny.flac`, `vp8-vorbis.webm`, `vp9-opus.webm` — точные копии [фикстур разработчика](../../../testdata/components/README.md), где записаны команды и контрольные суммы. Дополнительные `tiny.mp3`, `tiny.m4a`, `tiny.mp4` созданы тем же полным FFmpeg BtbN `n8.1.3-9-g29e619e767-20260930` из тех же WAV/PNG-исходников по следующим командам (переменные указывают на явно выбранный полный FFmpeg и временный каталог исходников из той инструкции):

```sh
"$MEDIA_FFMPEG" -hide_banner -v error -nostdin -n \
  -i "$fixture_sources/Тон.wav" -c:a libmp3lame -b:a 64k internal/components/fixtures/tiny.mp3
"$MEDIA_FFMPEG" -hide_banner -v error -nostdin -n \
  -i "$fixture_sources/Тон.wav" -c:a aac -b:a 48k internal/components/fixtures/tiny.m4a
"$MEDIA_FFMPEG" -hide_banner -v error -nostdin -n \
  -loop 1 -framerate 30 -i "$fixture_sources/Опора.png" -frames:v 6 -an \
  -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p internal/components/fixtures/tiny.mp4
```

Звуковые исходники имеют длительность 0,2 секунды, H.264 — шесть кадров 64×36 при 30 FPS. Кодировщики нужны только при намеренной регенерации входов полным FFmpeg; проверяемый комплект только декодирует их. Независимая операция `audio-pcm` поэтому продолжает работать без исправного libx264.
