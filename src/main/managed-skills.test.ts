/** Файловые проверки копий навыка: переносимость, обновление и сохранение пользовательских путей. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { syncManagedSkills } from './managed-skills';
import { Projects } from './projects';
import { LocalState } from './state';

let work: string;
let root: string;
let project: string;
const paths = ['.agents/skills/ai-clip-scenario', '.claude/skills/ai-clip-scenario'];
const scenePaths = ['.agents/skills/ai-clip-scene', '.claude/skills/ai-clip-scene'];
const references = ['app-proposal', 'batch', 'kling-cli', 'lipsync', 'model-selection', 'prompt-template', 'quality-and-state', 'recovery', 'state'];
function write(relative: string, content: string, base = project): void {
  const path = join(base, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
function read(relative: string): string {
  return readFileSync(join(project, relative), 'utf8');
}
function manifest(): { schemaVersion: number; files: Record<string, string> } {
  return JSON.parse(read('.songframe/managed-skills.json'));
}

/** Снимок включает байты, папки и ссылки: любой конфликт должен отменять запись во всём наборе. */
function skillsSnapshot(): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (relative: string): void => {
    const path = join(project, relative);
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) result[relative] = `ссылка:${readlinkSync(path)}`;
    else if (entry.isDirectory()) {
      result[relative] = 'папка';
      for (const child of readdirSync(path).sort()) visit(`${relative}/${child}`);
    } else result[relative] = readFileSync(path).toString('base64');
  };
  for (const relative of ['.agents', '.claude', '.songframe']) if (existsSync(join(project, relative))) visit(relative);
  return result;
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'songframe-skills-'));
  root = join(work, 'resources');
  project = join(work, 'clip');
  mkdirSync(project);
  write('skills/ai-clip-scenario/SKILL.md', 'Инструкции v1\n', root);
  write('skills/ai-clip-scenario/agents/openai.yaml', 'interface:\n  display_name: Сценарий\n', root);
  write('skills/ai-clip-scene/SKILL.md', 'Производство v1\n', root);
  write('skills/ai-clip-scene/agents/openai.yaml', 'interface:\n  display_name: Производство\n', root);
  for (const file of ['workflow.md', 'evals.md', ...references.map((name) => `references/${name}.md`)]) {
    write(`skills/ai-clip-scene/${file}`, `Справка ${file}\n`, root);
  }
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

describe('управляемые копии навыков сценария и производства', () => {
  it('создаёт обычные файлы с относительным manifest и идемпотентно обновляет обе копии', () => {
    expect(syncManagedSkills(root, project)).toEqual([]);
    for (const destination of paths) {
      expect(lstatSync(join(project, destination)).isSymbolicLink()).toBe(false);
      expect(read(`${destination}/SKILL.md`)).toBe('Инструкции v1\n');
      expect(read(`${destination}/agents/openai.yaml`)).toContain('Сценарий');
    }
    const before = read('.songframe/managed-skills.json');
    expect(before).not.toContain(work);
    expect(manifest().schemaVersion).toBe(1);
    expect(Object.keys(manifest().files)).toHaveLength(30);
    expect(syncManagedSkills(root, project)).toEqual([]);
    expect(read('.songframe/managed-skills.json')).toBe(before);
    write('skills/ai-clip-scenario/SKILL.md', 'Инструкции v2\n', root);
    expect(syncManagedSkills(root, project)).toEqual([]);
    for (const destination of paths) expect(read(`${destination}/SKILL.md`)).toBe('Инструкции v2\n');
  });

  it.each(['linux', 'win32'] as const)('восстанавливает потерянный manifest по целым доставленным копиям на %s и затем штатно обновляет навык', (platform) => {
    const source = '# Сценарий\n\n[Правила](../../AGENTS.md) [Инструменты](../../tools/README.md)\n\n```sh\n./.songframe/run-tool project_info\n```\n';
    write('skills/ai-clip-scenario/SKILL.md', source, root);
    expect(syncManagedSkills(root, project, platform)).toEqual([]);
    const previous = read('.songframe/managed-skills.json');
    const delivered = skillsSnapshot();
    expect(read(`${paths[0]}/SKILL.md`)).toContain('[Правила](../../../AGENTS.md)');
    expect(read(`${paths[0]}/SKILL.md`)).toContain(platform === 'win32' ? '.\\.songframe\\run-tool.cmd project_info' : './.songframe/run-tool project_info');
    rmSync(join(project, '.songframe/managed-skills.json'));

    expect(syncManagedSkills(root, project, platform)).toEqual([]);
    expect(read('.songframe/managed-skills.json')).toBe(previous);
    expect(skillsSnapshot()).toEqual(delivered);
    expect(syncManagedSkills(root, project, platform)).toEqual([]);
    expect(skillsSnapshot()).toEqual(delivered);

    write('skills/ai-clip-scenario/SKILL.md', `${source}\nОбновление поставки\n`, root);
    expect(syncManagedSkills(root, project, platform)).toEqual([]);
    for (const destination of paths) {
      expect(read(`${destination}/SKILL.md`)).toContain('Обновление поставки');
      expect(manifest().files[`${destination}/SKILL.md`]).toBe(
        createHash('sha256')
          .update(read(`${destination}/SKILL.md`))
          .digest('hex')
      );
    }
  });

  it('после настоящего git clone восстанавливает игнорируемый manifest и создаёт отсутствующую целиком копию', () => {
    expect(syncManagedSkills(root, project)).toEqual([]);
    const previous = read('.songframe/managed-skills.json');
    write('.gitignore', '.songframe/managed-skills.json\n');
    // Git переносит доставленные навыки, но локальный registry намеренно остаётся в исходной папке.
    const git = (args: string[]): void => {
      execFileSync('git', args, { cwd: project, stdio: 'pipe' });
    };
    git(['init', '--quiet']);
    git(['add', '.']);
    git([
      '-c',
      'user.name=Тест',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgSign=false',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--quiet',
      '-m',
      'test: копии навыков проекта'
    ]);
    const cloned = join(work, 'cloned-clip');
    git(['clone', '--quiet', '--no-hardlinks', project, cloned]);
    project = cloned;
    expect(existsSync(join(project, '.songframe/managed-skills.json'))).toBe(false);
    expect(read(`${scenePaths[1]}/references/state.md`)).toContain('Справка');
    rmSync(join(project, paths[1]), { recursive: true });

    expect(syncManagedSkills(root, project)).toEqual([]);
    expect(read('.songframe/managed-skills.json')).toBe(previous);
    expect(read(`${paths[1]}/SKILL.md`)).toBe('Инструкции v1\n');
    expect(syncManagedSkills(root, project)).toEqual([]);
    expect(read('.songframe/managed-skills.json')).toBe(previous);
  });

  it.each(['правка', 'неполный набор', 'лишний файл', 'ссылка'] as const)('без manifest сохраняет конфликт «%s» и не записывает остальные копии', (variant) => {
    expect(syncManagedSkills(root, project)).toEqual([]);
    rmSync(join(project, '.songframe/managed-skills.json'));
    const relative = `${scenePaths[1]}/references/state.md`;
    if (variant === 'правка') write(relative, 'Правила пользователя');
    else if (variant === 'неполный набор') rmSync(join(project, relative));
    else if (variant === 'лишний файл') write(`${scenePaths[1]}/notes.md`, 'Мои заметки');
    else {
      rmSync(join(project, relative));
      symlinkSync(join(root, 'skills/ai-clip-scene/references/state.md'), join(project, relative));
    }
    // Даже полностью отсутствующая ранняя копия не создаётся, пока поздний навык конфликтует.
    rmSync(join(project, paths[0]), { recursive: true });
    const before = skillsSnapshot();
    expect(syncManagedSkills(root, project).join(' ')).toContain(scenePaths[1]);
    expect(skillsSnapshot()).toEqual(before);
    expect(existsSync(join(project, '.songframe/managed-skills.json'))).toBe(false);
  });

  it('без manifest не принимает исходные ссылки checkout за точную доставленную копию', () => {
    const source = '# Сценарий\n\n[Правила](../../AGENTS.md)\n';
    write('skills/ai-clip-scenario/SKILL.md', source, root);
    expect(syncManagedSkills(root, project)).toEqual([]);
    rmSync(join(project, '.songframe/managed-skills.json'));
    write(`${paths[1]}/SKILL.md`, source);
    const before = skillsSnapshot();
    expect(syncManagedSkills(root, project).join(' ')).toContain(paths[1]);
    expect(skillsSnapshot()).toEqual(before);
  });

  it('без manifest сравнивает исходные байты, даже если декодированный UTF-8 совпадает', () => {
    write('skills/ai-clip-scene/references/state.md', '\ufffd', root);
    expect(syncManagedSkills(root, project)).toEqual([]);
    rmSync(join(project, '.songframe/managed-skills.json'));
    const relative = `${scenePaths[1]}/references/state.md`;
    // Некорректный байт и настоящий символ замены дают одинаковую строку при чтении как UTF-8.
    writeFileSync(join(project, relative), Buffer.from([0xff]));
    expect(read(relative)).toBe('\ufffd');
    const before = skillsSnapshot();
    expect(syncManagedSkills(root, project).join(' ')).toContain(scenePaths[1]);
    expect(skillsSnapshot()).toEqual(before);
  });

  it.each([
    ['win32', 'linux'],
    ['linux', 'win32']
  ] as const)('без manifest переносит команды с %s на %s с окончаниями строк Git', (from, to) => {
    write('skills/ai-clip-scenario/SKILL.md', '# Сценарий\n\n./.songframe/run-tool project_info\n', root);
    expect(syncManagedSkills(root, project, from)).toEqual([]);
    rmSync(join(project, '.songframe/managed-skills.json'));
    for (const destination of paths) write(`${destination}/SKILL.md`, read(`${destination}/SKILL.md`).replace(/\n/g, '\r\n'));
    expect(syncManagedSkills(root, project, to)).toEqual([]);
    for (const destination of paths)
      expect(read(`${destination}/SKILL.md`)).toContain(to === 'win32' ? '.\\.songframe\\run-tool.cmd' : './.songframe/run-tool');
    expect(syncManagedSkills(root, project, to)).toEqual([]);
  });

  it('с manifest принимает изменение только окончаний строк при переносе', () => {
    expect(syncManagedSkills(root, project, 'linux')).toEqual([]);
    const relative = `${paths[0]}/SKILL.md`;
    write(relative, read(relative).replace(/\n/g, '\r\n'));
    expect(syncManagedSkills(root, project, 'win32')).toEqual([]);
    expect(read(relative)).toBe('Инструкции v1\n');
  });

  it('не восстанавливает владение совпадающим файлом, пропущенным в существующем manifest', () => {
    expect(syncManagedSkills(root, project)).toEqual([]);
    const previous = manifest();
    delete previous.files[`${scenePaths[1]}/references/state.md`];
    write('.songframe/managed-skills.json', JSON.stringify(previous));
    write('skills/ai-clip-scenario/SKILL.md', 'Обновление поставки\n', root);
    const before = skillsSnapshot();
    expect(syncManagedSkills(root, project).join(' ')).toContain(`${scenePaths[1]}/references/state.md`);
    expect(skillsSnapshot()).toEqual(before);
  });

  it('добавляет производственный навык к прежнему manifest и обновляет все его справочники', () => {
    // Manifest прошлого выпуска содержит только сценарий; новые файлы должны добавиться без миграции формата.
    for (const destination of paths) {
      write(`${destination}/SKILL.md`, 'Инструкции v1\n');
      write(`${destination}/agents/openai.yaml`, 'interface:\n  display_name: Сценарий\n');
    }
    const files = Object.fromEntries(
      paths.flatMap((destination) =>
        ['SKILL.md', 'agents/openai.yaml'].map((file) => {
          const relative = `${destination}/${file}`;
          return [relative, createHash('sha256').update(read(relative)).digest('hex')];
        })
      )
    );
    write('.songframe/managed-skills.json', JSON.stringify({ schemaVersion: 1, files }));
    expect(syncManagedSkills(root, project)).toEqual([]);
    for (const destination of scenePaths) {
      expect(lstatSync(join(project, destination)).isSymbolicLink()).toBe(false);
      expect(read(`${destination}/SKILL.md`)).toBe('Производство v1\n');
      expect(read(`${destination}/agents/openai.yaml`)).toContain('Производство');
      for (const reference of references) expect(read(`${destination}/references/${reference}.md`)).toContain('Справка');
    }
    write('skills/ai-clip-scene/references/app-proposal.md', 'Новый контракт', root);
    expect(syncManagedSkills(root, project)).toEqual([]);
    for (const destination of scenePaths) expect(read(`${destination}/references/app-proposal.md`)).toBe('Новый контракт');
    const before = read('.songframe/managed-skills.json');
    expect(syncManagedSkills(root, project)).toEqual([]);
    expect(read('.songframe/managed-skills.json')).toBe(before);
  });

  it('мигрирует прежние относительные ссылки по хешу старой копии и сохраняет пользовательскую правку', () => {
    const source = '# Сценарий\n\n[Правила](../../AGENTS.md) [Инструменты](../../tools/README.md)\n';
    write('skills/ai-clip-scenario/SKILL.md', source, root);
    expect(syncManagedSkills(root, project)).toEqual([]);
    const previous = manifest();
    // Прошлый выпуск записывал байты исходного навыка; manifest подтверждает владение именно этой версией.
    for (const destination of paths) {
      const file = `${destination}/SKILL.md`;
      write(file, source);
      previous.files[file] = createHash('sha256').update(source).digest('hex');
    }
    write('.songframe/managed-skills.json', JSON.stringify(previous));
    expect(syncManagedSkills(root, project)).toEqual([]);
    for (const destination of paths) {
      expect(read(`${destination}/SKILL.md`)).toContain('[Правила](../../../AGENTS.md)');
      expect(read(`${destination}/SKILL.md`)).toContain('[Инструменты](../../../.songframe/tools/README.md)');
      expect(manifest().files[`${destination}/SKILL.md`]).toBe(
        createHash('sha256')
          .update(read(`${destination}/SKILL.md`))
          .digest('hex')
      );
    }
    write(`${paths[1]}/SKILL.md`, `${read(`${paths[1]}/SKILL.md`)}\nПравка пользователя\n`);
    const before = read(`${paths[0]}/SKILL.md`);
    write('skills/ai-clip-scenario/SKILL.md', `${source}\nОбновление поставки\n`, root);
    expect(syncManagedSkills(root, project).join(' ')).toContain('пользовательское содержимое');
    expect(read(`${paths[0]}/SKILL.md`)).toBe(before);
    expect(read(`${paths[1]}/SKILL.md`)).toContain('Правка пользователя');
  });

  it('сохраняет правки производственного справочника и неизвестную ссылку без частичного обновления', () => {
    syncManagedSkills(root, project);
    write(`${scenePaths[0]}/references/state.md`, 'Мои правила непрерывности');
    write('skills/ai-clip-scene/SKILL.md', 'Новая поставка', root);
    expect(syncManagedSkills(root, project).join(' ')).toContain('references/state.md');
    expect(read(`${scenePaths[1]}/SKILL.md`)).toBe('Производство v1\n');
    expect(read(`${scenePaths[0]}/references/state.md`)).toBe('Мои правила непрерывности');
    rmSync(join(project, scenePaths[1]), { recursive: true });
    symlinkSync(join(work, 'missing-production'), join(project, scenePaths[1]));
    expect(syncManagedSkills(root, project).join(' ')).toContain('неизвестная символическая ссылка');
    expect(lstatSync(join(project, scenePaths[1])).isSymbolicLink()).toBe(true);
  });

  it('проверяет весь набор перед обновлением и сохраняет изменённый пользователем файл', () => {
    syncManagedSkills(root, project);
    const before = read('.songframe/managed-skills.json');
    write(`${paths[1]}/SKILL.md`, 'Правила пользователя');
    write('skills/ai-clip-scenario/SKILL.md', 'Новая поставка', root);
    expect(syncManagedSkills(root, project).join(' ')).toContain(`${paths[1]}/SKILL.md`);
    expect(read(`${paths[0]}/SKILL.md`)).toBe('Инструкции v1\n');
    expect(read(`${paths[1]}/SKILL.md`)).toBe('Правила пользователя');
    expect(read('.songframe/managed-skills.json')).toBe(before);
  });

  it('удаляет прежний управляемый файл только при совпадении последнего хеша', () => {
    syncManagedSkills(root, project);
    const relative = `${paths[0]}/old.md`;
    write(relative, 'Старый файл');
    const previous = manifest();
    previous.files[relative] = createHash('sha256').update('Старый файл').digest('hex');
    write('.songframe/managed-skills.json', JSON.stringify(previous));
    expect(syncManagedSkills(root, project)).toEqual([]);
    expect(() => read(relative)).toThrow();
    write(relative, 'Старый файл');
    write('.songframe/managed-skills.json', JSON.stringify(previous));
    write(relative, 'Моя правка');
    expect(syncManagedSkills(root, project).join(' ')).toContain(relative);
    expect(read(relative)).toBe('Моя правка');
  });

  it('сохраняет одноимённый пользовательский навык даже с совпадающим содержимым', () => {
    write(`${paths[0]}/SKILL.md`, 'Инструкции v1\n');
    expect(syncManagedSkills(root, project).join(' ')).toContain('пользовательский навык');
    expect(read(`${paths[0]}/SKILL.md`)).toBe('Инструкции v1\n');
    expect(() => read(`${paths[1]}/SKILL.md`)).toThrow();
  });

  it('сохраняет повреждённый manifest и неизвестные файлы без частичного обновления', () => {
    syncManagedSkills(root, project);
    const before = read('.songframe/managed-skills.json');
    write('.songframe/managed-skills.json', '{ошибка');
    write('skills/ai-clip-scenario/SKILL.md', 'Обновление', root);
    expect(syncManagedSkills(root, project).join(' ')).toContain('не удалось обновить');
    expect(read('.songframe/managed-skills.json')).toBe('{ошибка');
    expect(read(`${paths[0]}/SKILL.md`)).toBe('Инструкции v1\n');
    write('.songframe/managed-skills.json', before);
    write(`${paths[1]}/notes.md`, 'Мои заметки');
    expect(syncManagedSkills(root, project).join(' ')).toContain('notes.md');
    expect(read(`${paths[0]}/SKILL.md`)).toBe('Инструкции v1\n');
    expect(read(`${paths[1]}/notes.md`)).toBe('Мои заметки');
  });

  it('мигрирует только ссылки на навык текущего комплекса', () => {
    for (const destination of paths) {
      mkdirSync(dirname(join(project, destination)), { recursive: true });
      symlinkSync(join(root, 'skills/ai-clip-scenario'), join(project, destination));
    }
    expect(syncManagedSkills(root, project)).toEqual([]);
    for (const destination of paths) expect(lstatSync(join(project, destination)).isDirectory()).toBe(true);
    rmSync(join(project, paths[1]), { recursive: true });
    symlinkSync(join(work, 'missing-checkout'), join(project, paths[1]));
    write('skills/ai-clip-scenario/SKILL.md', 'Обновление', root);
    expect(syncManagedSkills(root, project).join(' ')).toContain('неизвестная символическая ссылка');
    expect(lstatSync(join(project, paths[1])).isSymbolicLink()).toBe(true);
    expect(read(`${paths[0]}/SKILL.md`)).toBe('Инструкции v1\n');
  });

  it('мигрирует ссылки производственного навыка и сохраняет одноимённый пользовательский навык', () => {
    for (const destination of scenePaths) {
      mkdirSync(dirname(join(project, destination)), { recursive: true });
      symlinkSync(join(root, 'skills/ai-clip-scene'), join(project, destination));
    }
    expect(syncManagedSkills(root, project)).toEqual([]);
    for (const destination of scenePaths) {
      expect(lstatSync(join(project, destination)).isSymbolicLink()).toBe(false);
      expect(read(`${destination}/references/app-proposal.md`)).toContain('Справка');
    }
    const previous = manifest();
    for (const destination of scenePaths) {
      for (const relative of Object.keys(previous.files)) if (relative.startsWith(`${destination}/`)) delete previous.files[relative];
    }
    write('.songframe/managed-skills.json', JSON.stringify(previous));
    expect(syncManagedSkills(root, project).join(' ')).toContain('одноимённый пользовательский навык');
    expect(read(`${scenePaths[0]}/SKILL.md`)).toBe('Производство v1\n');
  });

  it.each(['.agents', '.claude/skills', '.songframe'])('не следует скрытой родительской ссылке %s', (relative) => {
    const outside = join(work, 'outside');
    mkdirSync(outside);
    mkdirSync(dirname(join(project, relative)), { recursive: true });
    symlinkSync(outside, join(project, relative));
    expect(syncManagedSkills(root, project).join(' ')).toContain(relative);
    expect(lstatSync(join(project, relative)).isSymbolicLink()).toBe(true);
    expect(() => readFileSync(join(outside, 'managed-skills.json'))).toThrow();
    expect(() => read(`${paths[0]}/SKILL.md`)).toThrow();
  });

  it('сохраняет файл-ссылку внутри управляемой копии и не обновляет другую копию', () => {
    syncManagedSkills(root, project);
    const target = join(project, paths[1], 'agents/openai.yaml');
    rmSync(target);
    symlinkSync(join(work, 'missing.yaml'), target);
    write('skills/ai-clip-scenario/SKILL.md', 'Обновление', root);
    expect(syncManagedSkills(root, project).join(' ')).toContain('agents/openai.yaml');
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(read(`${paths[0]}/SKILL.md`)).toBe('Инструкции v1\n');
  });

  it('показывает конфликт в статусе, сохраняя открытие управляемого проекта', () => {
    const block = '<!-- songframe:begin -->\nУправляемый блок\n<!-- songframe:end -->\n';
    write('templates/project/AGENTS.md', block, root);
    write('AGENTS.md', block);
    write('plan/project.json', JSON.stringify({ schema_version: 1, name: 'Клип' }));
    write(`${paths[0]}/SKILL.md`, 'Мои инструкции');
    const projects = new Projects(new LocalState(join(work, 'state')), root, 'linux');
    const result = projects.open(project);
    expect(result.name).toBe('Клип');
    expect(result.problems.join(' ')).toContain('пользовательский навык');
    expect(projects.status(project).problems).toEqual(result.problems);
    expect(projects.appState().current).toBe(project);
    expect(read(`${paths[0]}/SKILL.md`)).toBe('Мои инструкции');
  });
});
