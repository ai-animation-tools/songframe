/** Управляемые копии навыков сценария и производства: пользовательские правки и неизвестные ссылки сохраняются. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, readlinkSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { AGENT_PROVIDER_IDS, AGENT_PROVIDERS } from '@shared/agent-providers';
import { writeAtomicText, writeLocalJson } from './local-files';
import { renderProjectDocumentation } from './project-documentation';

// Список файлов явный: в проект попадают только проверенные инструкции, без содержимого checkout.
const SKILLS = {
  'ai-clip-scenario': ['SKILL.md', 'agents/openai.yaml'],
  'ai-clip-scene': [
    'SKILL.md',
    'agents/openai.yaml',
    'workflow.md',
    'evals.md',
    'references/app-proposal.md',
    'references/batch.md',
    'references/kling-cli.md',
    'references/lipsync.md',
    'references/model-selection.md',
    'references/prompt-template.md',
    'references/quality-and-state.md',
    'references/recovery.md',
    'references/state.md'
  ]
};
// Каждый CLI ищет навыки в своём каталоге проекта; копии одинаковы.
const SKILL_DIRS = AGENT_PROVIDER_IDS.map((provider) => AGENT_PROVIDERS[provider].skillsDir);
const DESTINATIONS = Object.keys(SKILLS).flatMap((skill) => SKILL_DIRS.map((dir) => `${dir}/${skill}`));
const MANIFEST = '.songframe/managed-skills.json';
interface ManagedSkillsManifest {
  schemaVersion: 1;
  files: Record<string, string>;
}

function stat(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function sha(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Проверяется каждый родитель, включая скрытые каталоги: lstat видит и оборванные ссылки. */
export function managedSkillPathProblem(project: string, relative: string): string | null {
  const parts = relative.split('/');
  for (let index = 1; index < parts.length; index++) {
    const parent = parts.slice(0, index).join('/');
    const entry = stat(join(project, parent));
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) return `${parent}: ожидалась обычная папка; пользовательский путь сохранён.`;
  }
  return null;
}

function ownedPath(path: string): boolean {
  return DESTINATIONS.some(
    (destination) =>
      path.startsWith(`${destination}/`) &&
      !path.includes('\\') &&
      !path.includes(':') &&
      path.split('/').every((part) => part !== '.' && part !== '..' && part !== '')
  );
}

/** При переносе Git может менять окончания строк, но остальные байты должны совпадать. */
function matchesTextBytes(actual: Buffer, expected: string): boolean {
  return [expected, expected.replace(/\r\n/g, '\n'), expected.replace(/\r?\n/g, '\r\n')].some((text) => actual.equals(Buffer.from(text, 'utf8')));
}

/** После клонирования узнаём целую копию текущей поставки для одной из поддерживаемых ОС. */
function matchesSuppliedSkill(project: string, destination: string, desired: Map<string, string>): boolean {
  const expected = [...desired.keys()].filter((path) => path.startsWith(`${destination}/`));
  let found = 0;
  const inspect = (relative: string): boolean => {
    for (const item of readdirSync(join(project, relative), { withFileTypes: true })) {
      const child = `${relative}/${item.name}`;
      if (item.isDirectory()) {
        if (!inspect(child)) return false;
      } else {
        const content = desired.get(child);
        if (!item.isFile() || content === undefined || !matchesTextBytes(readFileSync(join(project, child)), content)) return false;
        found++;
      }
    }
    return true;
  };
  return inspect(destination) && found === expected.length;
}

/** Сначала проверяется весь набор; конфликт не оставляет наполовину обновлённые копии навыка. */
export function syncManagedSkills(root: string, project: string, platform: NodeJS.Platform = process.platform): string[] {
  const problems: string[] = [];
  const conflict = (message: string): void => {
    problems.push(`Навыки сценария и производства: ${message}`);
  };
  try {
    const manifestProblem = managedSkillPathProblem(project, MANIFEST);
    if (manifestProblem) return [`Навыки сценария и производства: ${manifestProblem}`];
    const manifestPath = join(project, MANIFEST);
    const manifestStat = stat(manifestPath);
    if (manifestStat && !manifestStat.isFile()) return [`Навыки сценария и производства: ${MANIFEST}: ожидался обычный JSON-файл; путь сохранён.`];
    let previous: ManagedSkillsManifest = { schemaVersion: 1, files: {} };
    if (manifestStat) {
      const value: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        !('schemaVersion' in value) ||
        value.schemaVersion !== 1 ||
        !('files' in value) ||
        !value.files ||
        typeof value.files !== 'object' ||
        Array.isArray(value.files) ||
        Object.entries(value.files).some(([path, digest]) => !ownedPath(path) || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest))
      ) {
        return [`Навыки сценария и производства: ${MANIFEST}: неизвестный формат; файл сохранён. Исправьте manifest перед обновлением навыка.`];
      }
      previous = value as ManagedSkillsManifest;
    }
    const desired = new Map<string, string>();
    const otherPlatform = new Map<string, string>();
    for (const [skill, files] of Object.entries(SKILLS)) {
      for (const destination of SKILL_DIRS.map((dir) => `${dir}/${skill}`)) {
        for (const file of files) {
          const source = `skills/${skill}/${file}`;
          const target = `${destination}/${file}`;
          const content = readFileSync(join(root, source), 'utf8');
          // Manifest хранит хеш доставленной копии: прежняя неизменённая версия обновляется без потери пользовательских правок.
          desired.set(target, file.endsWith('.md') ? renderProjectDocumentation(content, source, target, platform) : content);
          otherPlatform.set(
            target,
            file.endsWith('.md') ? renderProjectDocumentation(content, source, target, platform === 'win32' ? 'linux' : 'win32') : content
          );
        }
      }
    }
    const legacyLinks = new Set<string>();
    for (const destination of DESTINATIONS) {
      const parentProblem = managedSkillPathProblem(project, destination);
      if (parentProblem) {
        conflict(parentProblem);
        continue;
      }
      const entry = stat(join(project, destination));
      if (entry?.isSymbolicLink()) {
        // Мигрируем только ссылку прямо на навык текущего комплекcа; старые checkout не разыскиваем.
        const target = resolve(dirname(join(project, destination)), readlinkSync(join(project, destination)));
        if (target === resolve(root, 'skills', destination.split('/').at(-1)!)) legacyLinks.add(destination);
        else conflict(`${destination}: неизвестная символическая ссылка сохранена. Уберите конфликт вручную, чтобы подключить навык.`);
        continue;
      }
      if (entry && !entry.isDirectory()) {
        conflict(`${destination}: пользовательский файл сохранён.`);
        continue;
      }
      // Служебная папка исключена из Git, а неизменённые навыки могут быть закоммичены.
      // Восстанавливаем владение лишь при отсутствии реестра; чужие и неполные копии остаются конфликтами.
      if (entry && !manifestStat && (matchesSuppliedSkill(project, destination, desired) || matchesSuppliedSkill(project, destination, otherPlatform))) {
        for (const path of desired.keys()) if (path.startsWith(`${destination}/`)) previous.files[path] = sha(readFileSync(join(project, path), 'utf8'));
      }
      const managed = Object.keys(previous.files).some((path) => path.startsWith(`${destination}/`));
      if (entry && !managed) {
        conflict(`${destination}: одноимённый пользовательский навык сохранён.`);
        continue;
      }
      const inspect = (relative: string): void => {
        for (const item of readdirSync(join(project, relative), { withFileTypes: true })) {
          const child = `${relative}/${item.name}`;
          if (item.isDirectory()) inspect(child);
          else if (!previous.files[child]) conflict(`${child}: неуправляемый файл или ссылка сохранены.`);
        }
      };
      if (entry) inspect(destination);
    }
    for (const relative of new Set([...Object.keys(previous.files), ...desired.keys()])) {
      if ([...legacyLinks].some((path) => relative.startsWith(`${path}/`))) continue;
      const parentProblem = managedSkillPathProblem(project, relative);
      if (parentProblem) {
        conflict(parentProblem);
        continue;
      }
      const entry = stat(join(project, relative));
      if (!entry) continue;
      if (!entry.isFile()) {
        conflict(`${relative}: пользовательская ссылка или папка сохранена.`);
        continue;
      }
      const bytes = readFileSync(join(project, relative));
      const content = bytes.toString('utf8');
      // Сверяем также исходные окончания строк: Git может преобразовать LF и CRLF вместе с manifest.
      const unchanged =
        bytes.equals(Buffer.from(content, 'utf8')) &&
        [content, content.replace(/\r\n/g, '\n'), content.replace(/\r?\n/g, '\r\n')].some((text) => sha(text) === previous.files[relative]);
      if (!previous.files[relative] || !unchanged) {
        conflict(`${relative}: пользовательское содержимое изменено или не принадлежит приложению. Файл сохранён; устраните конфликт вручную.`);
      }
    }
    if (problems.length) return [...new Set(problems)];
    for (const destination of legacyLinks) rmSync(join(project, destination));
    for (const [relative, content] of desired) {
      const path = join(project, relative);
      if (!stat(path) || readFileSync(path, 'utf8') !== content) writeAtomicText(path, content);
    }
    for (const relative of Object.keys(previous.files)) {
      if (!desired.has(relative)) rmSync(join(project, relative), { force: true });
    }
    const next: ManagedSkillsManifest = { schemaVersion: 1, files: Object.fromEntries([...desired].map(([path, content]) => [path, sha(content)])) };
    if (JSON.stringify(previous) !== JSON.stringify(next) || !manifestStat) writeLocalJson(manifestPath, next);
    return [];
  } catch (error) {
    return [`Навыки сценария и производства: не удалось обновить управляемые копии: ${(error as Error).message}. Ручной просмотр проекта доступен.`];
  }
}
