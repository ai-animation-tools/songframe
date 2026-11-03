#!/bin/sh
# Проверяет рецепты обработки SongFrame на явно выбранном медиакомплекте, без проекта и моделей.
# Python stdlib создаёт только синтетические WAV/PNG и проверяет результаты ffprobe; это инструмент разработчика.
set -eu

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  printf '%s\n' 'Использование: sh scripts/check-media-capabilities.sh КАТАЛОГ_С_FFMPEG_И_FFPROBE' >&2
  exit 2
fi
media_bin=$(CDPATH= cd -- "$1" && pwd -P)
repository=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
for program in ffmpeg ffprobe; do
  if [ ! -x "$media_bin/$program" ]; then
    printf 'Не найден исполняемый файл: %s/%s\n' "$media_bin" "$program" >&2
    exit 1
  fi
done
command -v python3 >/dev/null 2>&1 || { printf '%s\n' 'Для проверки разработчика нужен Python 3.' >&2; exit 1; }
work=$(mktemp -d "${TMPDIR:-/tmp}/SongFrame медиа.XXXXXXXX")
trap 'rm -rf -- "$work"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Один процесс владеет фикстурами и ограничивает длительность каждой команды. Ошибка сохраняет
# понятное имя операции и диагностику бинарника; shell удаляет временные данные и при прерывании.
python3 - "$media_bin" "$work" "$repository/internal/components/manifest.json" <<'PY'
import json
import hashlib
import math
from pathlib import Path
import re
import struct
import subprocess
import sys
import wave
import zlib

bin_dir, root, manifest_path = map(Path, sys.argv[1:])
ffmpeg, ffprobe = (str(bin_dir / name) for name in ('ffmpeg', 'ffprobe'))


def run(label, command):
    """Каждая короткая операция ограничена минутой и не читает stdin пользователя."""
    try:
        result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RuntimeError(f'{label}: не удалось выполнить команду: {error}') from error
    if result.returncode:
        raise RuntimeError(f'{label}: код {result.returncode}\n' + result.stderr.decode(errors='replace')[-4000:])
    return result.stdout


def encode(label, *args):
    """Файлы появляются только в новом временном каталоге; замена существующих запрещена."""
    return run(label, [ffmpeg, '-hide_banner', '-v', 'error', '-nostdin', '-n', *map(str, args)])


def probe(path):
    """JSON проверяет смысл результата, а не одно успешное завершение FFmpeg."""
    return json.loads(run('Чтение метаданных', [ffprobe, '-v', 'error', '-protocol_whitelist', 'file',
        '-show_streams', '-show_format', '-show_chapters', '-of', 'json', str(path)]))


def require(condition, message):
    """Ошибка смысловой проверки должна завершать весь прогон ненулевым кодом."""
    if not condition:
        raise RuntimeError(message)


def listed_features(command, option):
    """Разбирает таблицу FFmpeg/ffprobe, включая алиасы контейнеров и списки протоколов."""
    output = run('Список возможностей ' + option, [command, '-hide_banner', option]).decode(errors='replace')
    present = set()
    for line in output.splitlines():
        match = re.match(r'^\s*[A-Z.]{1,8}\s+(\S+)', line)
        if match:
            present.update(match.group(1).split(','))
        elif option == '-protocols' and re.fullmatch(r'\s+[a-z0-9_]+\s*', line):
            present.add(line.strip())
    return present


def check_lists():
    """Читает требования из manifest, сохраняя один источник для будущего обнаружения.

    Списки не заменяют функциональные прогоны ниже. Для MP3 допускаются обе штатные
    реализации декодера; lavfi находится в устройствах ввода, хотя в manifest он
    указан вместе с demuxers. Кодировщики WebM не добавляются самой проверкой.
    """
    versions = []
    for command, program in [(ffmpeg, 'ffmpeg'), (ffprobe, 'ffprobe')]:
        output = run('Версия ' + program, [command, '-version']).decode(errors='replace')
        match = re.search(r'^' + program + r' version (\S+)', output, re.MULTILINE)
        require(match is not None, 'Не удалось определить версию ' + program + '.')
        versions.append(match.group(1))
    require(versions[0] == versions[1], 'Версии пары FFmpeg/ffprobe не совпадают: ' + ', '.join(versions))
    print('Проверена версия пары FFmpeg/ffprobe: ' + versions[0], flush=True)
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    categories = {
        'decoders': '-decoders', 'decoder_families': '-decoders', 'encoders': '-encoders',
        'demuxers': '-demuxers', 'muxers': '-muxers', 'filters': '-filters', 'protocols': '-protocols',
    }
    required = {}
    for capability in manifest['capabilities']:
        if 'ffmpeg-recipes' not in capability.get('probes', []):
            continue
        for category, names in capability['features'].items():
            if category == 'xfade_transitions':
                continue  # Варианты переходов проверяются реальными графами ниже.
            require(category in categories, 'Неизвестная категория медиавозможностей: ' + category)
            for name in names:
                option = '-devices' if category == 'demuxers' and name == 'lavfi' else categories[category]
                alternatives = ('mp3', 'mp3float') if category == 'decoder_families' and name == 'mp3' else (name,)
                required.setdefault(option, set()).add(alternatives)
    require(bool(required), 'В manifest отсутствуют требования проверки ffmpeg-recipes.')
    for command, program in [(ffmpeg, 'ffmpeg'), (ffprobe, 'ffprobe')]:
        for option, groups in required.items():
            # ffprobe читает входы, декодирует реальные кадры и использует те же локальные протоколы.
            if program == 'ffprobe' and option not in {'-decoders', '-demuxers', '-protocols'}:
                continue
            present = listed_features(command, option)
            missing = sorted(' либо '.join(group) for group in groups if not present.intersection(group))
            require(not missing, f'В {program} не хватает возможностей {option}: ' + ', '.join(missing))


def create_sources():
    """Стандартная библиотека создаёт исходники без testsrc/sine и дополнительных кодеков.

    WAV содержит 0,8 секунды стереотона 44,1 кГц. Два PNG различаются цветом,
    чтобы проверить начальное и конечное состояние перехода без настоящих клипов.
    """
    with wave.open(str(root / 'Тон с пробелом.wav'), 'wb') as stream:
        stream.setparams((2, 2, 44100, 0, 'NONE', ''))
        stream.writeframes(b''.join(struct.pack('<hh', value, value)
            for value in (round(8000 * math.sin(2 * math.pi * 440 * n / 44100)) for n in range(35280))))
    def chunk(kind, data):
        """Формирует блок PNG с CRC, не требуя Pillow или отдельного конвертера."""
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    for name, color in [('Первая опора.png', (255, 0, 0)), ('Последняя опора.png', (0, 0, 255))]:
        pixels = (b'\0' + bytes(color) * 160) * 90
        (root / name).write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 160, 90, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(pixels)) + chunk(b'IEND', b''))


def check_reading_fixtures():
    """Проверяет чтение FLAC/WebM на закреплённых синтетических файлах.

    Фикстуры созданы один раз полным FFmpeg и проверяются по SHA/размеру до чтения.
    Проверяемой сборке не нужны FLAC, VP8/VP9, Vorbis/Opus encoders.
    """
    directory = manifest_path.parents[2] / 'testdata' / 'components'
    hashes = json.loads((directory / 'hashes.json').read_text(encoding='utf-8'))
    expected = {'tiny.flac': ('flac', None), 'vp8-vorbis.webm': ('vorbis', 'vp8'),
                'vp9-opus.webm': ('opus', 'vp9')}
    require(set(hashes) == set(expected), 'Неверный состав реестра синтетических медиафикстур.')
    for name, (audio_codec, video_codec) in expected.items():
        path = directory / name
        data = path.read_bytes()
        require(len(data) == hashes[name]['bytes'] and hashlib.sha256(data).hexdigest() == hashes[name]['sha256'],
            'Не совпадает размер или SHA-256 медиафикстуры ' + name)
        info = probe(path)
        audio = next(s for s in info['streams'] if s['codec_type'] == 'audio')
        require(audio['codec_name'] == audio_codec, 'Неверный аудиокодек фикстуры ' + name)
        pcm = encode('Чтение аудио ' + name, '-i', path, '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1')
        require(4800 <= len(pcm) <= 8000 and len(pcm) % 2 == 0 and any(pcm), 'Неверное PCM-аудио фикстуры ' + name)
        if video_codec:
            video = next(s for s in info['streams'] if s['codec_type'] == 'video')
            require(video['codec_name'] == video_codec and (video['width'], video['height']) == (64, 36),
                'Неверный видеопоток фикстуры ' + name)
            frames = json.loads(run('Чтение PTS ' + name, [ffprobe, '-v', 'error', '-protocol_whitelist', 'file',
                '-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time',
                '-of', 'json', str(path)]))['frames']
            pts = [float(frame['best_effort_timestamp_time']) for frame in frames]
            require(len(pts) == 2 and all(math.isfinite(point) for point in pts) and pts[0] < pts[1],
                'Неверные декодированные кадры или PTS фикстуры ' + name)
        encode('Полное декодирование ' + name, '-i', path, '-f', 'null', '-')
    print('Проверены SHA/размеры фикстур и реальное чтение FLAC, VP8/Vorbis, VP9/Opus и WebM.', flush=True)


def main():
    """Покрывает реальные группы рецептов; ASR, сеть и пользовательские проекты не запускаются."""
    check_lists()
    print('Проверены списки кодеков, контейнеров, фильтров и протоколов.', flush=True)
    check_reading_fixtures()
    create_sources()
    wav, mp3 = root / 'Тон с пробелом.wav', root / 'Тон с пробелом.mp3'
    first, last = root / 'Первая опора.png', root / 'Последняя опора.png'
    encode('Кодирование MP3 и дополнение хвоста', '-i', wav, '-af', 'apad=pad_dur=0.1', '-c:a', 'libmp3lame', mp3)
    require(float(probe(mp3)['format']['duration']) > .8, 'Неверная длительность MP3.')
    for fmt, channels, rate, width in [('s16le', 1, 16000, 2), ('s16le', 2, 44100, 2),
                                       ('f32le', 1, 16000, 4), ('f32le', 2, 44100, 4)]:
        data = encode('Декодирование и ресэмплинг аудио', '-i', mp3, '-map', '0:a:0', '-ac', channels,
            '-ar', rate, '-f', fmt, 'pipe:1')
        require(len(data) > int(.8 * channels * rate * width) and len(data) % (channels * width) == 0,
            'Некорректный размер декодированного аудио.')
        if fmt == 'f32le':
            require(all(math.isfinite(value[0]) for value in struct.iter_unpack('<f', data)), 'Некорректные float-сэмплы.')
    encode('Штатная проверка тишины', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '0.1',
        '-c:a', 'pcm_s16le', root / 'Тишина.wav')
    require(abs(float(probe(root / 'Тишина.wav')['format']['duration']) - .1) < .001, 'Неверная длительность тишины.')
    print('Проверены MP3, WAV, PCM s16le/f32le, mono/stereo и ресэмплинг.', flush=True)

    common = ['-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-threads', '2',
              '-pix_fmt', 'yuv420p', '-r', '30', '-video_track_timescale', '15360', '-map_metadata', '-1']
    clip = root / 'Монтажный клип.mp4'
    # Нормализация, обрезка, скорость и удержания совпадают с группой build_review/accept_shot.
    graph = ('fps=30,trim=start_frame=0:end_frame=12,setpts=(PTS-STARTPTS)/2,fps=30,'
        'tpad=stop_mode=clone:stop=1,trim=end_frame=6,setpts=N/(30*TB),'
        'scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos,'
        'pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p,'
        'tpad=start_mode=clone:start=3:stop_mode=clone:stop=3,settb=1/30')
    encode('Монтаж с масштабом и удержаниями', '-loop', '1', '-framerate', '30', '-i', first,
        '-vf', graph, *common, '-frames:v', '12', clip)
    video = next(s for s in probe(clip)['streams'] if s['codec_type'] == 'video')
    require((video['width'], video['height'], video['r_frame_rate'], int(video['nb_frames'])) == (1920, 1080, '30/1', 12),
        'Неверные параметры монтажного клипа.')
    require(int(video['time_base'].split('/')[1]) == 15360, 'Неверная временная шкала MP4.')
    # Все четыре режима derive_shot используют подмножество этих преобразований.
    for name, filters in [('Срез', 'fps=30,trim=start_frame=2:end_frame=8,setpts=PTS-STARTPTS'),
            ('Ускорение', 'fps=30,trim=end_frame=12,setpts=PTS*6/12,fps=30:round=near'),
            ('Замедление', 'fps=30,trim=end_frame=6,setpts=PTS*12/6,fps=30:round=near'),
            ('Стоп-кадр', 'fps=30,trim=start_frame=2:end_frame=3,setpts=PTS-STARTPTS,loop=loop=-1:size=1:start=0,trim=end_frame=6,setpts=N/(30*TB)'),
            ('Повтор', 'fps=30,trim=start_frame=2:end_frame=5,setpts=PTS-STARTPTS,loop=loop=-1:size=3:start=0,trim=end_frame=8,setpts=N/(30*TB)')]:
        raw = encode(name, '-i', clip, '-vf', filters + ',scale=160:90,setsar=1', '-an', '-pix_fmt', 'yuv420p', '-f', 'rawvideo', 'pipe:1')
        expected = {'Срез': 6, 'Ускорение': 6, 'Замедление': 12, 'Стоп-кадр': 6, 'Повтор': 8}[name]
        require(len(raw) == expected * 160 * 90 * 3 // 2, name + ': неверное число кадров.')

    for transition in ['fade', 'fadeblack', 'fadewhite', 'dissolve', 'wipeleft', 'wiperight', 'cut']:
        join = ('concat=n=2:v=1:a=0,settb=1/30' if transition == 'cut' else
                f'xfade=transition={transition}:duration=0.1:offset=0.3')
        count = 24 if transition == 'cut' else 21
        out = root / (transition + '.mp4')
        encode('Переход ' + transition, '-loop', '1', '-framerate', '30', '-t', '0.4', '-i', first,
            '-loop', '1', '-framerate', '30', '-t', '0.4', '-i', last, '-filter_complex_threads', '1',
            '-filter_complex', '[0:v]setsar=1,format=yuv420p,settb=1/30[a];'
            '[1:v]setsar=1,format=yuv420p,settb=1/30[b];[a][b]' + join + ',setpts=PTS-STARTPTS[v]',
            '-map', '[v]', *common, '-frames:v', count, out)
        require(int(probe(out)['streams'][0]['nb_frames']) == count, 'Неверная длина перехода ' + transition)
        pixels = encode('Проверка крайних кадров перехода', '-i', out, '-vf',
            f'select=eq(n\\,0)+eq(n\\,{count - 1}),scale=1:1', '-fps_mode', 'vfr', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1')
        require(len(pixels) == 6 and pixels[0] > 200 and pixels[5] > 200, 'Неверные крайние цвета перехода ' + transition)
    print('Проверены монтаж, производные режимы, concat filter и шесть переходов xfade.', flush=True)

    # Кавычки concat/FFmetadata проверяются на тех же путях с кириллицей и пробелами.
    listing = root / 'Список клипов.txt'
    quoted = str(clip).replace("'", "'\\''")
    listing.write_text(f"file '{quoted}'\nfile '{quoted}'\n", encoding='utf-8')
    metadata = root / 'Главы.ffmeta'
    metadata.write_text(';FFMETADATA1\ntitle=Проверка медиа\n[CHAPTER]\nTIMEBASE=1/30\nSTART=0\nEND=12\ntitle=M01\n'
        '[CHAPTER]\nTIMEBASE=1/30\nSTART=12\nEND=24\ntitle=M02\n', encoding='utf-8')
    assembled = root / 'Полная сборка.mp4'
    encode('Сборка concat с песней и главами', '-f', 'concat', '-safe', '0', '-i', listing, '-i', mp3,
        '-i', metadata, '-map', '0:v:0', '-map', '1:a:0', '-map_metadata', '2', '-map_chapters', '2',
        '-c:v', 'copy', '-c:a', 'aac', '-ac', '2', '-ar', '44100', '-b:a', '192k', '-threads', '1',
        '-af', 'aresample=44100,atrim=start_sample=0:end_sample=35280,asetpts=PTS-STARTPTS,apad=whole_len=35280,atrim=end_sample=35280',
        '-movflags', '+faststart', assembled)
    info = probe(assembled)
    video = next(s for s in info['streams'] if s['codec_type'] == 'video')
    audio = next(s for s in info['streams'] if s['codec_type'] == 'audio')
    require(int(video['nb_frames']) == 24 and len(info['chapters']) == 2, 'Потеряны кадры или главы сборки.')
    require(info['format']['tags']['title'] == 'Проверка медиа', 'Потеряно название сборки.')
    require(audio['codec_name'] == 'aac' and audio['channels'] == 2 and audio['sample_rate'] == '44100'
        and abs(float(audio['duration']) - .8) < .003, 'Неверный формат или длительность AAC.')
    data = assembled.read_bytes()
    require(data.find(b'moov') < data.find(b'mdat'), 'Не применён MP4 faststart.')
    encode('Полное декодирование результата в null', '-i', assembled, '-f', 'null', '-')
    preview = root / 'Превью.mp4'
    encode('Превью с копированием видео и музыкой', '-i', clip, '-ss', '0.1', '-i', mp3,
        '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-t', '0.4', preview)
    require(len(probe(preview)['streams']) == 2, 'Превью потеряло поток.')
    encode('Превью 2×', '-i', clip, '-vf', 'setpts=PTS/2,scale=960:-2', '-an', '-c:v', 'libx264',
        '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', root / 'Превью 2x.mp4')
    # Декодирование реальных PTS проверяется отдельно от метаданных контейнера, как у video_review.
    pts_info = json.loads(run('Чтение видеометок', [ffprobe, '-v', 'error', '-protocol_whitelist', 'file',
        '-select_streams', 'v:0', '-read_intervals', '%+1', '-show_frames', '-show_entries',
        'frame=best_effort_timestamp_time', '-of', 'json', str(assembled)]))
    pts = [float(f['best_effort_timestamp_time']) for f in pts_info['frames']]
    require(len(pts) == 24 and all(a < b for a, b in zip(pts, pts[1:])), 'Неверные видеометки сборки.')
    encode('Выбор PNG-кадров', '-protocol_whitelist', 'file', '-i', assembled, '-map', '0:v:0', '-an',
        '-vf', "select=eq(n\\,0)+eq(n\\,23),scale=w='min(960,iw)':h='min(960,ih)':force_original_aspect_ratio=decrease",
        '-fps_mode', 'vfr', '-frames:v', '2', '-start_number', '1', '-f', 'image2', root / 'Кадр %03d.png')
    require(len(list(root.glob('Кадр *.png'))) == 2, 'Не извлечены выбранные PNG-кадры.')
    print('Проверены concat demuxer, FFmetadata, MP4 faststart, AAC, главы, PTS, PNG, rawvideo и null.', flush=True)
    print('Готово: функциональные рецепты и чтение FLAC/VP8/VP9/Vorbis/Opus/WebM пройдены.', flush=True)
    print('Whisper, модели, сеть, пользовательские клипы и установка медиакомплекта не использовались.', flush=True)


try:
    main()
except Exception as error:
    print('Проверка медиакомплекта завершилась ошибкой: ' + str(error), file=sys.stderr)
    sys.exit(1)
PY
