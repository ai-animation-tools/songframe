/** Только правки сценария выпуска пропускают проверки приложения; сомнительный diff запускает весь набор. */
import { execFile } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const full = (reason) => ({ release_only: false, browser: true, reason });

/** Руководства провайдеров являются входом приложения и не относятся к сопровождающей документации. */
export function classifyChanges(paths) {
  if (!paths.length) return full('empty-diff');
  const release = (path) => path.startsWith('scripts/release/');
  const companion = (path) =>
    /^[^/]+\.md$/.test(path) ||
    (path.startsWith('docs/') && !path.startsWith('docs/providers/')) ||
    ['dev-skills/', '.agents/', '.claude/'].some((prefix) => path.startsWith(prefix));
  const releaseOnly = paths.some(release) && paths.every((path) => release(path) || companion(path));
  // Перечень прямых входов витрины заменяет граф зависимостей: main/tools сохраняют свои обычные проверки.
  const browser = paths.some(
    (path) =>
      [
        'src/renderer/',
        'src/shared/',
        'src/preload/',
        '.storybook/',
        'tests/storybook/',
        'scripts/storybook/',
        'resources/',
        'tools/testdata/sample-project/'
      ].some((prefix) => path.startsWith(prefix)) ||
      ['package.json', 'yarn.lock', '.yarnrc.yml', '.nvmrc', 'electron.vite.config.ts', 'eslint.config.mjs'].includes(path) ||
      /^(?:tsconfig[^/]*\.json|vitest[^/]*\.ts|\.prettier[^/]*)$/.test(path)
  );
  return { release_only: releaseOnly, browser, reason: releaseOnly ? 'release-only' : 'app-tools' };
}

/** PR проверяет весь diff от общей базы, push — диапазон всех отправленных коммитов, ручной запуск — всё. */
export async function classifyEvent(eventName, event, cwd = process.cwd()) {
  if (eventName === 'workflow_dispatch') return full('manual');
  let base;
  let head;
  if (eventName === 'push') {
    base = event.before;
    head = event.after;
  } else if (eventName === 'pull_request') {
    base = event.pull_request?.base?.sha;
    head = event.pull_request?.head?.sha;
  } else return full('unknown-event');
  const commit = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value) && !/^0+$/.test(value);
  if (!commit(base) || !commit(head)) return full('missing-range');
  try {
    const range = eventName === 'pull_request' ? [`${base}...${head}`] : [base, head];
    // Без распознавания rename Git показывает старый и новый путь: перенос кода в docs не скрывает удаление.
    const { stdout } = await execute('git', ['diff', '--name-only', '--no-renames', '-z', ...range, '--'], { cwd, maxBuffer: 10 * 1024 * 1024 });
    return classifyChanges(stdout.split('\0').filter(Boolean));
  } catch {
    return full('unavailable-diff');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let result;
  try {
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
    result = await classifyEvent(process.env.GITHUB_EVENT_NAME, event);
  } catch {
    result = full('unavailable-event');
  }
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `release_only=${result.release_only}\nbrowser=${result.browser}\n`);
  console.log(JSON.stringify(result));
}
