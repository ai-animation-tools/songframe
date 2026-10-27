/** Управляемые ссылки проекта: относительные документы/схемы и launcher текущей ОС. */
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { applyEdits, findNodeAtLocation, parseTree, type Edit, type ParseError } from 'jsonc-parser';
import { writeAtomicText } from './local-files';
import { managedSkillPathProblem, syncManagedSkills } from './managed-skills';
import { PROJECT_DOC_DATA, renderProjectDocumentation } from './project-documentation';
import { projectLauncher } from './project-platform';

export const INTEGRATION_DIR = '.songframe';
export interface AppCommand {
  command: string;
  args: string[];
  localDir: string;
}

/** Внутренний EXE AppImage находится во временном mount; агенту нужен исходный постоянный файл. */
export function appCommand(options: { packaged: boolean; appImage?: string; execPath: string; appPath: string; localDir: string }): AppCommand {
  return {
    command: options.packaged ? options.appImage || options.execPath : options.execPath,
    args: options.packaged ? [] : [options.appPath],
    localDir: options.localDir
  };
}

/** Только известные записи шаблона: чужие схемы и всё форматирование JSONC сохраняются. */
export function migrateSchemaLinks(text: string): string {
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { allowTrailingComma: true });
  if (errors.length || !tree || tree.type !== 'object') throw new Error('Не удалось прочитать .vscode/settings.json: исправьте JSONC. Файл не изменён.');
  const schemas = findNodeAtLocation(tree, ['json.schemas']);
  if (!schemas || schemas.type !== 'array') return text;
  const owned: Record<string, string[]> = {
    'scenes.schema.json': ['/plan/scenes.json'],
    'cast.schema.json': ['/plan/cast.json'],
    'manifest.schema.json': ['/assets/shots/*/manifest.json'],
    'workflow.schema.json': ['/plan/awaiting/*/workflow.json', '/plan/batches/*/workflow.json'],
    'request.schema.json': ['/plan/awaiting/*/request/request.json', '/plan/batches/*/request/request.json']
  };
  const edits: Edit[] = [];
  for (const entry of schemas.children ?? []) {
    const url = findNodeAtLocation(entry, ['url']);
    const matches = findNodeAtLocation(entry, ['fileMatch']);
    if (url?.type !== 'string' || matches?.type !== 'array') continue;
    const normalized = String(url.value).replaceAll('\\', '/');
    for (const [name, expected] of Object.entries(owned)) {
      const actual = matches.children?.map((item) => item.value);
      if (
        !normalized.endsWith(`/tools/lint_registry/schemas/${name}`) ||
        !actual ||
        actual.length !== expected.length ||
        !expected.every((pattern) => actual.includes(pattern))
      )
        continue;
      const next = `./${INTEGRATION_DIR}/tools/lint_registry/schemas/${name}`;
      if (url.value !== next) edits.push({ offset: url.offset, length: url.length, content: JSON.stringify(next) });
    }
  }
  return applyEdits(text, edits);
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function renderProjectLauncher(app: AppCommand, mode: '--songframe-tool' | '--songframe-kling' = '--songframe-tool'): string {
  // APPIMAGE указывает на постоянный бинарник, process.execPath внутри AppImage — на временный mount.
  return `#!/bin/sh
# Этот файл обновляет SongFrame при открытии проекта. Свою автоматизацию храните отдельно.
${mode === '--songframe-tool' ? 'project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd) || exit 1\n' : ''}if [ ! -x ${quoteShell(app.command)} ]; then
  echo 'Приложение перемещено или недоступно. Откройте проект в SongFrame, чтобы обновить launcher.' >&2
  exit 1
fi
export SONGFRAME_LOCAL_DIR=${quoteShell(app.localDir)}
exec ${[app.command, ...app.args, mode].map(quoteShell).join(' ')} "$@"${mode === '--songframe-tool' ? ' --project "$project_dir"' : ''}
`;
}

function cmdLiteral(value: string): string {
  if (/["\r\n\0]/.test(value)) throw new Error('Путь приложения или состояния нельзя представить в Windows-launcher.');
  return value.replaceAll('%', '%%');
}

function quoteCmd(value: string): string {
  return `"${cmdLiteral(value).replace(/\\+$/, '$&$&')}"`;
}

/** CMD получает EXE напрямую, без start/call: ждёт завершения и возвращает код инструмента. */
export function renderWindowsProjectLauncher(app: AppCommand, mode: '--songframe-tool' | '--songframe-kling' = '--songframe-tool'): string {
  const local = cmdLiteral(app.localDir);
  return [
    '@echo off',
    'setlocal EnableExtensions DisableDelayedExpansion',
    '"%SystemRoot%\\System32\\chcp.com" 65001 >nul',
    'rem Этот файл обновляет SongFrame при открытии проекта.',
    `set "SONGFRAME_LOCAL_DIR=${local}"`,
    `if not exist ${quoteCmd(app.command)} goto songframe_missing`,
    `${[app.command, ...app.args].map(quoteCmd).join(' ')} ${mode} %*${mode === '--songframe-tool' ? ' --project "%~dp0.."' : ''}`,
    'exit /b %errorlevel%',
    '',
    ':songframe_missing',
    '>&2 echo Приложение перемещено или недоступно. Откройте проект в SongFrame, чтобы обновить launcher.',
    'exit /b 1',
    ''
  ].join('\r\n');
}

/** Копии справочников небольшие и доступны агенту после закрытия AppImage; Python/код сюда не копируются. */
export function syncProjectIntegration(
  root: string,
  project: string,
  app?: AppCommand,
  platform: NodeJS.Platform = process.platform,
  updateSchemaLinks = true
): string[] {
  // Служебная папка тоже не должна выводить управляемые записи за пределы проекта.
  const problem = managedSkillPathProblem(project, `${INTEGRATION_DIR}/managed-skills.json`);
  if (problem) return [problem];
  const settings = join(project, '.vscode/settings.json');
  // Чужие настройки редактора не меняем, пока проект не содержит управляемых правил SongFrame.
  const previous = updateSchemaLinks && existsSync(settings) ? readFileSync(settings, 'utf8') : null;
  const updated = previous !== null ? migrateSchemaLinks(previous) : null;
  const problems = syncManagedSkills(root, project, platform);
  // Не следуем пользовательским ссылкам внутри служебной папки и не заменяем их управляемыми файлами.
  const safePath = (relative: string): boolean => {
    const pathProblem = managedSkillPathProblem(project, relative);
    if (pathProblem) {
      problems.push(pathProblem);
      return false;
    }
    try {
      if (lstatSync(join(project, relative)).isSymbolicLink()) {
        problems.push(`${relative}: пользовательская символическая ссылка сохранена.`);
        return false;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return true;
  };
  const copyDocs = (relative: string): void => {
    const from = join(root, relative);
    if (!existsSync(from)) return;
    for (const item of readdirSync(from, { withFileTypes: true })) {
      if (['testdata', '__pycache__', 'node_modules'].includes(item.name)) continue;
      const child = `${relative}/${item.name}`;
      if (item.isDirectory()) copyDocs(child);
      else if (item.name.endsWith('.md') || (relative === 'tools/lint_registry/schemas' && item.name.endsWith('.json')) || PROJECT_DOC_DATA.has(child)) {
        const relativePath = `${INTEGRATION_DIR}/${child}`;
        if (!safePath(relativePath)) continue;
        const path = join(project, relativePath);
        const content = readFileSync(join(root, child), 'utf8');
        const copied = item.name.endsWith('.md') ? renderProjectDocumentation(content, child, `${INTEGRATION_DIR}/${child}`, platform) : content;
        if (!existsSync(path) || readFileSync(path, 'utf8') !== copied) writeAtomicText(path, copied);
      }
    }
  };
  for (const folder of ['tools', 'skills', 'scripts/runtime']) copyDocs(folder);
  // Агенту клипа нужна памятка по инструментам, а не инструкция сборки приложения.
  // Заголовки сохраняют ссылки из tools, skills и справочника runtime.
  const destination = join(project, INTEGRATION_DIR, 'README.md');
  const content = `# Инструменты проекта

Эту служебную папку обновляет SongFrame при открытии проекта. Здесь находятся launcher, справочники и JSON-схемы; код инструментов и Python остаются в приложении. Правила и данные клипа описаны в [AGENTS.md](../AGENTS.md) и [README.md](../README.md) проекта.

Выберите инструмент по [карте tools](tools/README.md), затем прочитайте README его папки. Порядок работы агента описан в [карте скиллов](skills/README.md). Читайте только справочники, нужные для текущей задачи.

Из корня клипа запускайте команды через \`${projectLauncher(platform, 'tool')} <имя> [аргументы]\`. Launcher сам передаёт проект и использует Python приложения. В примерах справочников заменяйте \`python3 -B tools/<имя>/<имя>.py\` на \`${projectLauncher(platform, 'tool')} <имя>\`, сохраняя аргументы.

## Kling CLI

В готовом приложении Node.js, npm и Kling CLI устанавливать не нужно. Из папки клипа используйте \`${projectLauncher(platform, 'kling')} <аргументы>\`: например, \`--version\` или \`who_am_i --quiet\`. Отдельный запуск приложения поддерживает \`--songframe-kling <аргументы>\`. Вход выполняется через браузер; на странице «Среда» доступна кнопка «Войти» либо «Сменить аккаунт». Авторизацию сохраняет официальный CLI в \`${platform === 'win32' ? '%USERPROFILE%\\.kling\\.credentials' : '~/.kling/.credentials'}\`; действующий вход повторять не нужно.

## Модель распознавания

Веса faster-whisper устанавливаются отдельно. В приложении откройте «Тайминги → Разметить автоматически»: окно рекомендует модель по ресурсам компьютера, показывает команды загрузки и позволяет выбрать уже скачанную папку. Для CLI путь можно передать через \`--model\` или \`SONGFRAME_MODEL_DIR\`; параметры описаны в [transcribe_local](tools/transcribe_local/README.md). После загрузки распознавание работает локально. Скачивание требует сети и отдельного поручения пользователя.

## Перенос приложения, состояние и проекты

После перемещения приложения или папки клипа откройте проект в SongFrame заново: приложение обновит launcher и ссылки. Настройки, история и журналы хранятся в постоянном каталоге состояния приложения; путь виден на странице «Среда». Вручную менять служебные файлы не нужно: они перезаписываются при открытии проекта и исключены из Git.
`;
  if (safePath(`${INTEGRATION_DIR}/README.md`) && (!existsSync(destination) || readFileSync(destination, 'utf8') !== content))
    writeAtomicText(destination, content);
  const ignore = join(project, INTEGRATION_DIR, '.gitignore');
  if (safePath(`${INTEGRATION_DIR}/.gitignore`) && !existsSync(ignore)) writeAtomicText(ignore, '*\n');
  if (updated !== null && updated !== previous) writeAtomicText(settings, updated);
  if (app) {
    const launchers = [
      ['run-tool', '--songframe-tool'],
      ['run-kling', '--songframe-kling']
    ] as const;
    for (const [name, mode] of launchers) {
      const launcher = join(project, INTEGRATION_DIR, `${name}${platform === 'win32' ? '.cmd' : ''}`);
      const text = platform === 'win32' ? renderWindowsProjectLauncher(app, mode) : renderProjectLauncher(app, mode);
      if (safePath(`${INTEGRATION_DIR}/${name}${platform === 'win32' ? '.cmd' : ''}`) && (!existsSync(launcher) || readFileSync(launcher, 'utf8') !== text))
        writeAtomicText(launcher, text, 0o755);
      // Служебные файлы прежней ОС не должны направлять агента в старую поставку после переноса проекта.
      const other = `${INTEGRATION_DIR}/${name}${platform === 'win32' ? '' : '.cmd'}`;
      if (safePath(other)) rmSync(join(project, other), { force: true });
    }
  }
  return problems;
}
