/** Копии справочников должны открываться из проекта без checkout и исполняемого кода рядом. */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderProjectDocumentation } from './project-documentation';
import { appCommand, renderProjectLauncher, syncProjectIntegration } from './project-integration';

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function markdownFiles(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((item) => {
    const file = join(path, item.name);
    return item.isDirectory() ? markdownFiles(file) : item.name.endsWith('.md') ? [file] : [];
  });
}

describe('справочники управляемого проекта', () => {
  it('доставляет реальные справочники со ссылками внутри проекта и необходимыми данными без Python-кода', () => {
    const root = process.cwd();
    const project = mkdtempSync(join(tmpdir(), 'songframe-project-docs-'));
    folders.push(project);
    cpSync(join(root, 'templates/project'), project, { recursive: true });
    const original = readFileSync(join(root, 'skills/ai-clip-scene/SKILL.md'), 'utf8');
    expect(syncProjectIntegration(root, project)).toEqual([]);
    const futureOutputs = new Set(['plan/scenes.json', 'plan/edit-list.md', 'plan/storyboard.md', 'plan/context/characters.md', 'plan/audio/timing.md']);
    const missing: string[] = [];
    for (const area of ['.agents/skills', '.claude/skills', '.songframe']) {
      for (const file of markdownFiles(join(project, area))) {
        const content = readFileSync(file, 'utf8');
        expect(content).not.toContain(root);
        for (const link of content.matchAll(/(?<!!)\[[^\]\n]+\]\(([^)\n]+)\)/g)) {
          if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(link[1])) continue;
          const target = resolve(dirname(file), decodeURIComponent(link[1].split(/[?#]/)[0]));
          const targetRelative = relative(project, target);
          if (!existsSync(target) && !futureOutputs.has(targetRelative)) missing.push(`${relative(project, file)} → ${link[1]}`);
          expect(targetRelative.startsWith('..')).toBe(false);
        }
      }
    }
    expect(missing).toEqual([]);
    expect(existsSync(join(project, '.songframe/tools/cast_registry/default_properties.json'))).toBe(true);
    expect(existsSync(join(project, '.songframe/tools/cost_check/pricing.json'))).toBe(true);
    expect(existsSync(join(project, '.songframe/tools/kling_request/kling_request.py'))).toBe(false);
    expect(readFileSync(join(project, '.agents/skills/ai-clip-scene/SKILL.md'), 'utf8')).toContain('[AGENTS.md проекта](../../../AGENTS.md)');
    expect(readFileSync(join(root, 'skills/ai-clip-scene/SKILL.md'), 'utf8')).toBe(original);
    const manifest = readFileSync(join(project, '.songframe/managed-skills.json'), 'utf8');
    expect(syncProjectIntegration(root, project)).toEqual([]);
    expect(readFileSync(join(project, '.songframe/managed-skills.json'), 'utf8')).toBe(manifest);
  });

  it('сохраняет frontmatter, локальные ссылки, URL и якоря, поясняя примеры запуска из checkout', () => {
    const source = `---\nname: ai-clip-scene\n---\n\n# Производство\n\n[Локально](references/state.md#состояние) [Инструмент](../../tools/shot_workflow/README.md#опоры) [Очередь](../../templates/project/plan/awaiting/README.md) [Сайт](https://example.com/a) [Раздел](#раздел)\n\npython3 -B tools/shot_workflow/shot_workflow.py show\n`;
    const copied = renderProjectDocumentation(source, 'skills/ai-clip-scene/SKILL.md', '.claude/skills/ai-clip-scene/SKILL.md');
    expect(copied.startsWith('---\nname: ai-clip-scene\n---\n')).toBe(true);
    expect(copied).toContain('[Локально](references/state.md#состояние)');
    expect(copied).toContain('[Инструмент](../../../.songframe/tools/shot_workflow/README.md#опоры)');
    expect(copied).toContain('[Очередь](../../../plan/awaiting/README.md)');
    expect(copied).toContain('[Сайт](https://example.com/a) [Раздел](#раздел)');
    expect(copied).toContain('./.songframe/run-tool <имя> [аргументы]');
  });
});

describe.skipIf(process.platform !== 'linux')('проектный launcher Kling', () => {
  it('передаёт буквальные аргументы без --project, сохраняет run-tool и обновляет постоянный AppImage после переноса', () => {
    const work = mkdtempSync(join(tmpdir(), 'songframe-project-kling-'));
    folders.push(work);
    const root = process.cwd();
    const project = join(work, 'Клип с пробелами');
    cpSync(join(root, 'templates/project'), project, { recursive: true });
    const executable = join(work, "AppImage с 'кавычкой'");
    writeFileSync(executable, `#!${process.execPath}\nconsole.log(JSON.stringify({args: process.argv.slice(2), local: process.env.SONGFRAME_LOCAL_DIR}));\n`, {
      mode: 0o755
    });
    const local = join(work, "Состояние с 'кавычкой'");
    const app = appCommand({ packaged: true, appImage: executable, execPath: '/tmp/mount/AppRun', appPath: '/unused', localDir: local });
    expect(syncProjectIntegration(root, project, app)).toEqual([]);
    const kling = join(project, '.songframe/run-kling');
    const tool = join(project, '.songframe/run-tool');
    const args = ['who_am_i', '--quiet', 'аргумент с пробелами', 'a&b;$HOME', "'literal'"];
    const result = spawnSync(kling, args, { cwd: '/', encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ args: ['--songframe-kling', ...args], local });
    expect(readFileSync(kling, 'utf8')).not.toContain('--project');
    expect(readFileSync(kling, 'utf8')).not.toContain('/tmp/mount');
    const toolText = readFileSync(tool, 'utf8');
    const previousTool = spawnSync(tool, ['check_workspace', '--json'], { cwd: '/', encoding: 'utf8' });
    expect(previousTool.status, previousTool.stderr).toBe(0);
    expect(JSON.parse(previousTool.stdout)).toEqual({ args: ['--songframe-tool', 'check_workspace', '--json', '--project', project], local });
    expect(syncProjectIntegration(root, project, app)).toEqual([]);
    expect(readFileSync(tool, 'utf8')).toBe(toolText);

    const movedApp = join(work, 'Перенесённое приложение');
    renameSync(executable, movedApp);
    const stale = spawnSync(kling, ['--version'], { encoding: 'utf8' });
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain('Откройте проект');
    expect(syncProjectIntegration(root, project, { ...app, command: movedApp })).toEqual([]);
    const moved = spawnSync(kling, args, { cwd: '/', encoding: 'utf8' });
    expect(moved.status, moved.stderr).toBe(0);
    expect(JSON.parse(moved.stdout)).toEqual({ args: ['--songframe-kling', ...args], local });
    expect(readFileSync(kling, 'utf8')).toContain(movedApp);
  });

  it('сохраняет prefix аргументов dev-команды и не вычисляет проект для Kling', () => {
    const work = mkdtempSync(join(tmpdir(), 'songframe-project-kling-dev-'));
    folders.push(work);
    mkdirSync(join(work, '.songframe'));
    const executable = join(work, 'fake-electron');
    writeFileSync(executable, `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
    const app = appCommand({ packaged: false, execPath: executable, appPath: join(work, 'Dev приложение'), localDir: join(work, 'state') });
    const launcher = join(work, '.songframe/run-kling');
    writeFileSync(launcher, renderProjectLauncher(app, '--songframe-kling'), { mode: 0o755 });
    const result = spawnSync(launcher, ['--version'], { cwd: '/', encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([app.args[0], '--songframe-kling', '--version']);
    expect(readFileSync(launcher, 'utf8')).not.toContain('project_dir=');
  });
});
