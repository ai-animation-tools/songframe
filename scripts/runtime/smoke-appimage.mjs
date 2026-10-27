/** Приёмка конечного файла; AppImage не копируется за пределы build/release даже для проверки переноса. */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, copyFile, writeFile, stat, rm } from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import mediaFiles from './media-files.cjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const option = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const docker = process.argv.includes('--docker');
const release = join(repo, 'build/release');
const names = (await readdir(release)).filter((name) => name.endsWith('.AppImage'));
if (!option('appimage') && names.length !== 1) throw new Error('Укажите --appimage=<файл>, в build/release должен быть один конечный AppImage.');
let image = resolve(option('appimage') ?? join(release, names[0]));
const original = image;
const model = option('model') ? resolve(option('model')) : null;
if (!model) throw new Error('Задайте внешнюю модель: --model=<папка>. Для CI: yarn prepare:smoke-model.');
const work = option('output') ? resolve(option('output')) : await mkdtemp(join(tmpdir(), 'songframe-appimage-'));
await mkdir(work, { recursive: true });
await mkdir(join(work, 'home'), { recursive: true });
const log = [];
const imageHash = await mediaFiles.sha256(image);
// Ошибка нового прогона не должна оставлять старую отметку об успешной приёмке.
await rm(`${image}.sha256`, { force: true });
await rm(join(release, 'linux-smoke-result.json'), { force: true });
const started = Date.now();
const command = async (file, args, env = {}) => {
  await new Promise((resolveResult, reject) => {
    const child = spawn(file, args, { cwd: work, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const write = (data) => {
      log.push(data.toString());
      process.stdout.write(data);
    };
    child.stdout.on('data', write);
    child.stderr.on('data', write);
    const timer = setTimeout(() => child.kill('SIGKILL'), 20 * 60 * 1000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolveResult();
      else reject(new Error(`${file}: код ${code}; журнал ${join(work, 'smoke.log')}`));
    });
  });
};
const container = (args, env = {}) =>
  command('docker', [
    'run',
    '--rm',
    '--init',
    '--network=none',
    '--user',
    `${process.getuid()}:${process.getgid()}`,
    '--mount',
    `type=bind,source=${work},target=${work}`,
    '--mount',
    `type=bind,source=${image},target=${image},readonly`,
    '--mount',
    `type=bind,source=${model},target=${model},readonly`,
    ...Object.entries({ HOME: join(work, 'home'), ...env }).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    'songframe-smoke:ubuntu22',
    ...args
  ]);
let moved = false;
try {
  console.log('[Проверка] Подготовка тестовой речи');
  const wav = join(work, 'voice.wav');
  if (docker) {
    await command('docker', [
      'build',
      '-q',
      '-t',
      'songframe-smoke:ubuntu22',
      '-f',
      join(repo, 'scripts/runtime/linux-smoke.Dockerfile'),
      join(repo, 'scripts/runtime')
    ]);
    await container(['espeak-ng', '-v', 'ru', '-s', '125', '-w', wav, 'Утром солнце светит ярко. Мы гуляем у реки.']);
  } else if (option('audio')) await copyFile(resolve(option('audio')), wav);
  else await command('espeak-ng', ['-v', 'ru', '-s', '125', '-w', wav, 'Утром солнце светит ярко. Мы гуляем у реки.']);
  for (const phase of ['exercise', 'reopen']) {
    if (phase === 'reopen') {
      const folder = join(dirname(original), 'Перенос AppImage с пробелами');
      await mkdir(folder, { recursive: true });
      image = join(folder, basename(original));
      await rename(original, image);
      moved = true;
    }
    console.log(`[Проверка] AppImage: ${phase}`);
    const output = join(work, `${phase}.json`);
    const env = {
      SONGFRAME_LINUX_SMOKE: output,
      SONGFRAME_LOCAL_DIR: join(work, 'state'),
      SONGFRAME_MODEL_DIR: model,
      SONGFRAME_ASR_PROJECT: '',
      SONGFRAME_PROJECT: '',
      SONGFRAME_SMOKE_WAV: wav,
      SONGFRAME_SMOKE_PHASE: phase,
      HF_HUB_OFFLINE: '1',
      HF_HUB_DISABLE_TELEMETRY: '1',
      XDG_CONFIG_HOME: join(work, 'config'),
      XDG_CACHE_HOME: join(work, 'cache')
    };
    const args = ['--disable-gpu', `--user-data-dir=${join(work, 'userdata')}`];
    if (docker)
      await container(['xvfb-run', '-a', '-e', '/dev/stderr', image, '--no-sandbox', ...args], {
        ...env,
        SONGFRAME_SMOKE_CLEAN: '1',
        APPIMAGE_EXTRACT_AND_RUN: '1',
        NO_CLEANUP: '1'
      });
    else await command(image, args, { ...env, ...(process.argv.includes('--extract') ? { APPIMAGE_EXTRACT_AND_RUN: '1', NO_CLEANUP: '1' } : {}) });
    const report = JSON.parse(await readFile(output, 'utf8'));
    if (report.ok !== true) throw new Error(`Smoke ${phase} завершился ошибкой: ${report.error}`);
  }
  if (moved) {
    await rename(image, original);
    image = original;
    moved = false;
  }
  if ((await mediaFiles.sha256(original)) !== imageHash) throw new Error('AppImage изменился при проверке.');
  const summary = {
    ok: true,
    appimage: basename(original),
    bytes: (await stat(original)).size,
    sha256: imageHash,
    model: basename(model),
    docker,
    elapsedMs: Date.now() - started
  };
  await writeFile(join(work, 'result.json'), JSON.stringify(summary, null, 2) + '\n');
  await writeFile(`${original}.sha256`, `${imageHash}  ${basename(original)}\n`);
  await writeFile(join(release, 'linux-smoke-result.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(`Готовый AppImage проверен. Отчёт: ${join(work, 'result.json')}`);
} catch (error) {
  await writeFile(join(work, 'result.json'), JSON.stringify({ ok: false, error: error.message }, null, 2) + '\n');
  throw error;
} finally {
  if (moved) await rename(image, original);
  await writeFile(join(work, 'smoke.log'), log.join(''));
}
