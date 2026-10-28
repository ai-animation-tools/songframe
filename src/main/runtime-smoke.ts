/** Поэтапная проверка packaged-приложения: лог сохраняет место остановки даже при медленном импорте DLL. */
import { FPS } from '@shared/video';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { mediaPaths } from './media-runtime';
import { Jobs } from './jobs';
import { PythonLauncher } from './python-launcher';
import { paidAdapters } from './providers';

export const IMPORT_TIMEOUT = 120000;

export async function runtimeSmoke(launcher: PythonLauncher, output: string): Promise<boolean> {
  const work = mkdtempSync(join(tmpdir(), 'songframe-packaged-'));
  const checks: { stage: string; elapsedMs: number; result: unknown }[] = [];
  let stage = 'Подготовка Python';
  const save = (data: Record<string, unknown>): void => writeFileSync(output, JSON.stringify({ stage, checks, ...data }, null, 2) + '\n');
  try {
    const project = join(work, 'Клип с пробелами');
    const plan = join(project, 'plan');
    mkdirSync(plan, { recursive: true });
    writeFileSync(
      join(plan, 'scenes.json'),
      JSON.stringify({
        schema_version: 1,
        fps: FPS,
        audio: { end_seconds: '1' },
        references: {},
        sequences: [{ id: 'S01' }],
        scenes: [{ id: 'M01', sequence: 'S01', start_frame: 0, end_frame_exclusive: FPS, references: [], state_from: null, state_changes: {} }]
      })
    );
    mkdirSync(join(project, 'assets/shots/M01'), { recursive: true });
    writeFileSync(join(project, 'assets/shots/M01/manifest.json'), '{}');
    const isolated = new PythonLauncher({ ...launcher.options, env: { ...process.env, PATH: '' }, localDir: join(work, 'local') });
    const runtime = isolated.runtime();
    const run = async (name: string, code: string, timeoutMs = IMPORT_TIMEOUT): Promise<unknown> => {
      stage = name;
      save({ ok: false, status: 'running' });
      console.log(`[Проверка] ${name}`);
      const started = Date.now();
      const result = await isolated.execute(['-c', code], { timeoutMs, onOutput: (text) => process.stdout.write(text) });
      if (result.code !== 0) throw new Error(`${name}: ${result.stderr || result.stdout || `код ${result.code}`}`);
      const data: unknown = JSON.parse(result.stdout);
      checks.push({ stage, elapsedMs: Date.now() - started, result: data });
      console.log(`[Готово] ${name}, ${Date.now() - started} мс`);
      return data;
    };
    const modules = await run(
      'Запуск Python',
      `import sys,json,os
expected = os.environ.get('SONGFRAME_BIN_DIR', '')
assert os.environ.get('PATH', '') == expected, 'PATH должен содержать только встроенные медиабинарники'
print(json.dumps({'executable': sys.executable, 'version': sys.version.split()[0]}))`,
      30000
    );
    // Холодный импорт в Windows VM может занять больше 30 секунд; каждый модуль имеет свой лимит и запись в логе.
    for (const name of ['PIL', 'numpy', 'av', 'tokenizers', 'ctranslate2', 'onnxruntime', 'faster_whisper']) {
      await run(
        `Импорт ${name}`,
        `import importlib,json
module = importlib.import_module('${name}')
print(json.dumps({'module': '${name}', 'version': getattr(module, '__version__', '')}))`
      );
    }
    const operations = await run(
      'Pillow и CPU CTranslate2',
      `import json
from io import BytesIO
from PIL import Image
import ctranslate2
image = BytesIO()
Image.new('RGB', (4, 4)).save(image, format='PNG')
print(json.dumps({'cpu_types': sorted(ctranslate2.get_supported_compute_types('cpu'))}))`
    );
    const nested = await run(
      'Вложенный Python',
      `import sys,json,subprocess
child = subprocess.check_output([sys.executable, '-B', '-X', 'utf8', '-c', 'import sys; print(sys.executable)'], stdin=subprocess.DEVNULL, text=True, timeout=30).strip()
assert child == sys.executable
print(json.dumps({'nested_executable': child}))`,
      45000
    );
    stage = 'check_workspace';
    save({ ok: false, status: 'running' });
    console.log(`[Проверка] ${stage}`);
    const result = await isolated.run(project, 'check_workspace', ['--json'], { timeoutMs: 30000, onOutput: (text) => process.stdout.write(text) });
    if (result.code !== 0) throw new Error(result.stderr || result.stdout);
    stage = 'Jobs';
    save({ ok: false, status: 'running' });
    console.log(`[Проверка] ${stage}`);
    const jobs = new Jobs(isolated.options.toolsRoot, join(work, 'local'), isolated);
    const job = jobs.start('check', 'Проверка поставки', project, [{ tool: 'check_workspace', args: ['--json'], timeoutMs: 30000 }]);
    const deadline = Date.now() + 45000;
    while (job.status === 'running' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    if (job.status !== 'done') throw new Error(`Jobs: ${job.status}\n${job.log}`);
    const media = mediaPaths(isolated.options);
    if (media) {
      await run(
        'Встроенные FFmpeg',
        `import json,shutil,subprocess,os,tempfile
from pathlib import Path
result = {}
for name in ('ffmpeg','ffprobe'):
    filename = name + ('.exe' if os.name == 'nt' else '')
    command = str(Path(os.environ['SONGFRAME_BIN_DIR']) / filename)
    assert os.path.normcase(shutil.which(filename) or '') == os.path.normcase(command)
    result[name] = {'command': command, 'version': subprocess.check_output([command, '-version'], text=True, timeout=30).splitlines()[0]}
with tempfile.TemporaryDirectory(prefix='songframe-media-') as folder:
    audio = str(Path(folder) / 'probe.wav')
    subprocess.run([result['ffmpeg']['command'], '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '0.1', '-c:a', 'pcm_s16le', audio], check=True, timeout=30)
    probe = subprocess.check_output([result['ffprobe']['command'], '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', audio], text=True, timeout=30)
    duration = float(json.loads(probe)['format']['duration'])
    assert 0.09 <= duration <= 0.11, duration
    result['audioRoundtrip'] = {'durationSeconds': duration}
print(json.dumps(result))`
      );
    }
    // Встроенные программы провайдеров проверяются их адаптерами без внешнего окружения.
    for (const check of paidAdapters().flatMap((adapter) => adapter.smokeChecks(isolated.options))) await run(check.name, check.code);
    await run(
      'Загрузчик модели без системного Python и hf',
      `import inspect,json,shutil,subprocess,sys
from importlib.metadata import version
from huggingface_hub import snapshot_download
from tools.download_whisper_model import download_whisper_model
assert shutil.which('python') is None and shutil.which('python3') is None
assert shutil.which('hf') is None
assert {'repo_id', 'local_dir'} <= set(inspect.signature(snapshot_download).parameters)
result = subprocess.run([sys.executable, '-B', '-X', 'utf8', download_whisper_model.__file__, '--help'], capture_output=True, timeout=30)
assert result.returncode == 0, result.stderr.decode('utf-8', errors='replace')
assert b'--repository' in result.stdout and b'--output' in result.stdout
print(json.dumps({'huggingfaceHub': version('huggingface_hub'), 'downloadCLI': True, 'externalPython': False, 'externalHf': False, 'networkUsed': False}))`
    );
    let asr: unknown = null;
    // Только явно заданная тестовая копия проекта: этот режим никогда не выбирает пользовательский проект автоматически.
    if (process.env.SONGFRAME_ASR_PROJECT) {
      const asrProject = process.env.SONGFRAME_ASR_PROJECT;
      const timingPath = join(asrProject, 'plan/audio/timing.json');
      const before = existsSync(timingPath) ? JSON.parse(readFileSync(timingPath, 'utf8')) : null;
      const verified = (before?.lines ?? []).filter((line: { verified?: boolean }) => line.verified);
      stage = 'Автоматическая разметка трека';
      save({ ok: false, status: 'running' });
      const started = Date.now();
      const recognitionPath = join(dirname(output), 'recognition.json');
      const result = await isolated.run(asrProject, 'align_lyrics', ['--json', '--keep-recognition', recognitionPath], {
        timeoutMs: 30 * 60 * 1000,
        onOutput: (text) => process.stdout.write(text)
      });
      if (result.code !== 0) throw new Error(result.stderr || result.stdout);
      const timing = JSON.parse(readFileSync(timingPath, 'utf8'));
      const recognition = JSON.parse(readFileSync(recognitionPath, 'utf8'));
      if (!timing.lines.length || !recognition.segments.length) throw new Error('Разметка или распознавание пусты.');
      for (const previous of verified) {
        const line = timing.lines.find((item: { source_line: number }) => item.source_line === previous.source_line);
        if (JSON.stringify(line) !== JSON.stringify(previous)) throw new Error('Подтверждённая строка изменилась при повторной разметке.');
      }
      asr = {
        result,
        elapsedMs: Date.now() - started,
        project: asrProject,
        modelDir: media?.modelDir,
        verifiedPreserved: verified.length,
        timingPath,
        recognitionPath,
        lines: timing.lines.length,
        segments: recognition.segments.length
      };
    }
    stage = 'Завершено';
    save({ ok: true, status: 'done', source: runtime.source, command: runtime.command, modules, operations, nested, tool: result, job, asr });
    console.log('[Готово] Все проверки пройдены.');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Ошибка] ${stage}: ${message}`);
    save({ ok: false, status: 'failed', error: message });
    return false;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
