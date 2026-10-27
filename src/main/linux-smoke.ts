/** Приёмка Linux-поставки без окна, на собственном временном проекте и внешней модели. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { appCommand } from './project-integration';
import { Projects } from './projects';
import { LocalState } from './state';
import { Jobs } from './jobs';
import { SettingsStore } from './settings';
import { mediaPaths, missingModelFiles } from './media-runtime';
import { PythonLauncher } from './python-launcher';
import { runtimeSmoke } from './runtime-smoke';
import { saveSources, sha256File } from './sources';
import type { TimingFile } from '@shared/types';

const TEXT = '[Куплет]\nУтром солнце светит ярко.\nМы гуляем у реки.\n';

/** Вложенный launcher действительно вызывает AppImage; потоки разделены, код ошибки не теряется. */
async function command(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(file, args, { cwd: '/', env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Проектный launcher: код ${code}; ${stderr}`));
      else resolveResult(stdout);
    });
  });
}

export async function linuxSmoke(
  launcher: PythonLauncher,
  output: string,
  executable: { appImage?: string; execPath: string; appPath: string }
): Promise<boolean> {
  const root = dirname(output);
  mkdirSync(root, { recursive: true });
  const checks: { name: string; result: unknown }[] = [];
  const save = (ok: boolean, extra: Record<string, unknown> = {}): void => writeFileSync(output, JSON.stringify({ ok, checks, ...extra }, null, 2) + '\n');
  const record = (name: string, result: unknown): void => {
    checks.push({ name, result });
    save(false, { status: 'running' });
    console.log(`[Готово] ${name}`);
  };
  try {
    assert.equal(process.platform, 'linux');
    assert(launcher.options.packaged, 'Проверять нужно упакованное приложение.');
    const resources = launcher.options.toolsRoot!;
    const media = mediaPaths(launcher.options)!;
    const model = process.env.SONGFRAME_MODEL_DIR;
    assert(model && missingModelFiles(model).length === 0, 'Задайте полную внешнюю модель через SONGFRAME_MODEL_DIR.');
    assert(!resolve(model).startsWith(resolve(resources) + '/'), 'Модель должна находиться вне приложения.');
    assert(!existsSync(join(resources, 'runtime/models')), 'Веса не должны попадать в AppImage.');
    assert(!existsSync(join(resources, 'tools/testdata')), 'Тестовые проекты не должны попадать в AppImage.');
    assert.equal(await runtimeSmoke(launcher, join(root, `runtime-${process.env.SONGFRAME_SMOKE_PHASE ?? 'exercise'}.json`)), true);
    const isolated = new PythonLauncher({ ...launcher.options, env: { ...process.env, PATH: media.binDir }, localDir: launcher.options.localDir });
    const tool = async (name: string, args: string[], project: string): Promise<string> => {
      const result = await isolated.run(project, name, args, { timeoutMs: 10 * 60 * 1000, onOutput: (text) => process.stdout.write(text) });
      assert.equal(result.code, 0, `${name}: ${result.stderr}`);
      return result.stdout;
    };
    if (process.env.SONGFRAME_SMOKE_CLEAN === '1') {
      const probe = await launcher.execute([
        '-c',
        "import shutil,json; print(json.dumps({name: shutil.which(name) for name in ('python','python3','node','npm','yarn','git')}))"
      ]);
      assert.equal(probe.code, 0, probe.stderr);
      const programs = JSON.parse(probe.stdout) as Record<string, string | null>;
      assert(
        Object.values(programs).every((value) => value === null),
        `В проверочной ОС найдены внешние программы: ${probe.stdout}`
      );
      record('В ОС нет Python/Node/Yarn/Git', programs);
    }
    const state = new LocalState(launcher.options.localDir!);
    const integration = appCommand({ packaged: true, ...executable, localDir: state.localDir });
    // Флаг относится только к тестовому контейнеру; обычный launcher приложения не меняется.
    if (process.argv.includes('--no-sandbox')) integration.args.push('--no-sandbox');
    const projects = (): Projects => new Projects(state, resources, 'linux', { packaged: true, appCommand: integration });
    let project = join(root, 'Клип с пробелами');
    if (process.env.SONGFRAME_SMOKE_PHASE === 'reopen') {
      const previous = JSON.parse(readFileSync(join(root, 'expected.json'), 'utf8')) as { project: string; timingHash: string; sourceHash: string };
      project = previous.project;
      assert.equal(state.readCurrent(), project);
      assert.equal(new SettingsStore(state.localDir).read().toolsRootOverride, null);
      assert(existsSync(join(state.localDir, 'jobs')));
      const restored = projects();
      restored.restoreCurrent();
      assert.deepEqual(restored.appState().problems, []);
      assert.equal(sha256File(join(project, 'source/track.mp3')), previous.sourceHash);
      assert.equal(sha256File(join(project, 'plan/audio/timing.json')), previous.timingHash);
      const result = await command(join(project, '.songframe/run-tool'), ['current_project', '--json', 'show'], {
        ...process.env,
        SONGFRAME_SMOKE_PHASE: '',
        SONGFRAME_LINUX_SMOKE: ''
      });
      // Extract-and-run может печатать служебный список файлов AppImage в stdout до JSON инструмента.
      const printedPath = /^\s*"path":\s*("(?:[^"\\]|\\.)*")/m.exec(result);
      assert(printedPath, 'Launcher должен вернуть JSON текущего проекта.');
      assert.equal(JSON.parse(printedPath[1]), project);
      record('Перезапуск AppImage сохраняет проект, настройки и журналы', { project });
      save(true, { status: 'done', phase: 'reopen' });
      return true;
    }
    assert(!existsSync(project), 'Для нового прогона выберите пустой каталог отчёта.');
    projects().create({ name: 'Тест поставки', path: project });
    record('Создание проекта из поставляемого шаблона', { project });
    const audio = join(root, 'track.mp3');
    const reference = join(root, 'reference.png');
    const fixture = await isolated.execute([
      '-c',
      `import sys,subprocess
from PIL import Image
subprocess.run(['ffmpeg','-v','error','-y','-i',sys.argv[1],'-af','apad=pad_dur=1','-codec:a','libmp3lame',sys.argv[2]],check=True)
Image.new('RGB',(64,64),(30,90,160)).save(sys.argv[3])`,
      process.env.SONGFRAME_SMOKE_WAV!,
      audio,
      reference
    ]);
    assert.equal(fixture.code, 0, fixture.stderr);
    const source = saveSources(
      project,
      {
        track: { path: audio },
        lyrics: { text: TEXT },
        idea: { text: 'Технический проект проверки поставки.' },
        cover: null,
        references: [
          {
            id: 'hero',
            kind: 'character',
            name: 'Герой',
            short_name: 'Герой',
            description: '',
            prompt: '',
            files: [{ sourcePath: reference, view: 'full', note: '' }]
          }
        ]
      },
      join(media.binDir, 'ffprobe')
    );
    assert(source.track?.duration_seconds && source.track.duration_seconds > 0, 'Встроенный ffprobe должен определять длительность при загрузке.');
    const sourceHash = sha256File(join(project, 'source/track.mp3'));
    const recognition = join(root, 'recognition.json');
    await tool('align_lyrics', ['--json', '--model', model, '--device', 'cpu', '--keep-recognition', recognition], project);
    const timingPath = join(project, 'plan/audio/timing.json');
    const timing = JSON.parse(readFileSync(timingPath, 'utf8')) as TimingFile;
    const recognized = JSON.parse(readFileSync(recognition, 'utf8'));
    assert.equal(timing.lines.length, 2);
    assert(recognized.segments.length > 0, 'Распознавание не должно быть пустым.');
    assert.equal(resolve(recognized.model_path), resolve(model));
    assert(recognized.network.includes('local_files_only') && recognized.network.includes('HF_HUB_OFFLINE'));
    record('MP3 → timing.json внешней моделью на CPU', { model: recognized.model, lines: timing.lines.length, segments: recognized.segments.length });
    timing.lines[0].verified = true;
    writeFileSync(timingPath, JSON.stringify(timing));
    await tool('align_lyrics', ['--json', '--recognition', recognition], project);
    const updated = JSON.parse(readFileSync(timingPath, 'utf8')) as TimingFile;
    assert.deepEqual(updated.lines[0], timing.lines[0], 'Подтверждённая строка должна сохраниться.');
    await tool('cast_registry', ['init'], project);
    writeFileSync(
      join(project, 'plan/treatment.json'),
      JSON.stringify({
        schema_version: 1,
        logline: 'Проверка',
        sequences: [{ id: 'verse', title: 'Куплет', direction: 'Прогулка', start: 0, end: updated.duration_decoded, entities: ['hero'] }]
      })
    );
    await tool('scene_scaffold', ['--json'], project);
    const scenes = JSON.parse(readFileSync(join(project, 'plan/scenes.json'), 'utf8'));
    assert(scenes.scenes.length > 0);
    for (const scene of scenes.scenes) {
      scene.camera = 'Средний план';
      scene.action = 'Герой идёт вдоль реки.';
    }
    writeFileSync(join(project, 'plan/scenes.json'), JSON.stringify(scenes));
    record('Каркас сцен из разметки и кастинга', { scenes: scenes.scenes.length });
    const rules = join(project, 'AGENTS.md');
    writeFileSync(rules, readFileSync(rules, 'utf8') + '\nМоё дополнительное правило.\n');
    const config = join(project, '.vscode/settings.json');
    const settings = JSON.parse(readFileSync(config, 'utf8'));
    settings['editor.tabSize'] = 3;
    writeFileSync(config, '// Мой комментарий\n' + JSON.stringify(settings, null, 2));
    const moved = join(root, 'Перенесённый клип');
    renameSync(project, moved);
    project = moved;
    projects().open(project);
    assert(readFileSync(join(project, 'AGENTS.md'), 'utf8').endsWith('Моё дополнительное правило.\n'));
    assert(readFileSync(join(project, '.vscode/settings.json'), 'utf8').startsWith('// Мой комментарий'));
    assert.equal(sha256File(join(project, 'source/track.mp3')), sourceHash);
    new SettingsStore(state.localDir).write({ toolsRootOverride: null });
    const jobs = new Jobs(resources, state.localDir, isolated);
    const job = jobs.start('check', 'Проверка поставки', project, [
      { tool: 'update_scene_views', args: [] },
      { tool: 'check_workspace', args: ['--json'] }
    ]);
    const deadline = Date.now() + 30000;
    while (job.status === 'running' && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25));
    assert.equal(job.status, 'done', job.log);
    assert(existsSync(join(state.localDir, 'jobs', `${job.id}.log`)));
    record('Задание и журнал сохраняются в каталоге состояния', { job: job.id });
    writeFileSync(join(root, 'expected.json'), JSON.stringify({ project, sourceHash, timingHash: sha256File(join(project, 'plan/audio/timing.json')) }));
    record('Перенос проекта сохраняет данные и ручные правила', { project });
    assert(!existsSync(join(resources, '.local')));
    save(true, { status: 'done', phase: 'exercise', model: recognized.model });
    return true;
  } catch (error) {
    console.error(error);
    save(false, { status: 'failed', error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}
