/** Ссылки справочников разрешаются в checkout, а записываются относительно доставленной копии. */
import { posix } from 'node:path';
import { projectLauncher, renderProjectCommands } from './project-platform';

// Эти небольшие данные читаются по ссылкам из справочников; исполняемый код в проект не переносится.
export const PROJECT_DOC_DATA = new Set(['tools/cost_check/pricing.json', 'tools/cast_registry/default_properties.json']);

function destinationFor(source: string, sourceFile: string, destinationFile: string): string | null {
  if (source === 'AGENTS.md') return 'AGENTS.md';
  if (source === 'README.md') return '.songframe/README.md';
  if (source.startsWith('templates/project/')) return source.slice('templates/project/'.length);
  if (source.startsWith('tools/testdata/')) return null;
  const skill = sourceFile.match(/^skills\/[^/]+\//)?.[0];
  if (skill && source.startsWith(skill)) {
    // Внутренние references остаются внутри своей копии навыка, включая .agents и .claude.
    return destinationFile.slice(0, -sourceFile.slice(skill.length).length) + source.slice(skill.length);
  }
  if (
    ((source.startsWith('tools/') || source.startsWith('skills/') || source.startsWith('scripts/runtime/')) && source.endsWith('.md')) ||
    (source.startsWith('tools/lint_registry/schemas/') && source.endsWith('.json')) ||
    PROJECT_DOC_DATA.has(source)
  )
    return `.songframe/${source}`;
  return null;
}

/** Переписываем только существующий формат inline-ссылок; команды и frontmatter навыка сохраняются. */
export function renderProjectDocumentation(content: string, sourceFile: string, destinationFile: string, platform: NodeJS.Platform = process.platform): string {
  let omittedSource = false;
  const updated = renderProjectCommands(content, platform).replace(/(?<!!)\[([^\]\n]+)\]\(([^)\n]+)\)/g, (original: string, label: string, href: string) => {
    if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(href)) return original;
    const [, path, suffix] = href.match(/^([^?#]*)(.*)$/)!;
    const source = posix.normalize(posix.join(posix.dirname(sourceFile), path));
    const destination = destinationFor(source, sourceFile, destinationFile);
    if (!destination) {
      // Ссылки на Python, тесты и прочие недоставляемые исходники остаются поясняющим текстом.
      omittedSource = true;
      return label;
    }
    const text = source === 'AGENTS.md' ? label.replace('комплекса', 'проекта') : label;
    return `[${text}](${posix.relative(posix.dirname(destinationFile), destination)}${suffix})`;
  });
  if (!omittedSource && !/python3\s+(?:-B\s+)?\S*tools\//.test(updated)) return updated;
  // Подсказка у первого заголовка сохраняет YAML frontmatter и объясняет старые примеры checkout.
  return updated.replace(
    /^(# .+\r?\n)/m,
    `$1\n> В проекте запускайте инструменты из его корня через \`${projectLauncher(platform, 'tool')} <имя> [аргументы]\`. Код и Python находятся в приложении; примеры разработки и тестирования относятся к комплексу.\n`
  );
}
