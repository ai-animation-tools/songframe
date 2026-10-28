/** Обложку Codex рисует встроенным image_gen во временном проекте: его история и все разрешённые записи остаются рядом с кандидатом. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentJob } from '@shared/agents';
import { AgentManager } from '../../agent-manager';
import type { CoverCandidateRunner } from '../../cover-generation';
import { SettingsStore } from '../../settings';
import type { AgentCoverDeps } from '../types';

const IMAGE_PROMPT =
  'Создай одну квадратную обложку по пользовательскому описанию из дополнительного контекста. ' +
  'Обязательно используй встроенный инструмент image_gen, создай настоящее изображение и сохрани один результат в текущей рабочей папке. ' +
  'Разрешены PNG, JPEG и WebP; расширение обязано соответствовать реальному формату. ' +
  'Не используй внешние сервисы генерации, API-ключи, программную отрисовку, SVG, заглушки, имитацию или сторонние генераторы. ' +
  'Если встроенный image_gen недоступен, заверши задачу с объяснением ошибки. ' +
  'Не изменяй исходный проект и не выполняй commit/push. Финальный ответ — ровно один JSON без Markdown: {"path":"cover.png"}. ' +
  'Для JPEG или WebP укажи соответствующее имя созданного файла.';

export function createCodexCoverRunner({ config, createManager = (value) => new AgentManager(value) }: AgentCoverDeps): CoverCandidateRunner {
  return async ({ workDir, prompt, signal }) => {
    if (signal.aborted) throw new Error('Генерация обложки остановлена.');
    const root = dirname(dirname(workDir));
    const temporarySettings = new SettingsStore(root);
    mkdirSync(join(root, 'plan'), { recursive: true });
    writeFileSync(join(root, 'plan/project.json'), '{}');
    const manager = createManager(temporarySettings);
    const stop = (): void => {
      void manager.shutdownAndWait();
    };
    signal.addEventListener('abort', stop, { once: true });
    let unsubscribe: (() => void) | undefined;
    try {
      const job = manager.startImages(
        { project: root, task: 'Обложка проекта', prompt: IMAGE_PROMPT, context: JSON.stringify({ userPrompt: prompt }) },
        workDir,
        config
      );
      const completed = await new Promise<AgentJob>((finish) => {
        const check = (): void => {
          const current = manager.get(job.id);
          if (current && current.status !== 'running') finish(current);
        };
        unsubscribe = manager.onEvent(check);
        check();
      });
      if (signal.aborted) throw new Error('Генерация обложки остановлена.');
      if (completed.status !== 'completed' || completed.exitCode !== 0)
        throw new Error(completed.message || 'Агент не смог создать обложку. Проверьте доступность встроенного image_gen.');
      let response: unknown;
      try {
        response = JSON.parse(completed.result);
      } catch {
        throw new Error('Агент не вернул путь к созданной обложке.');
      }
      if (
        !response ||
        typeof response !== 'object' ||
        Array.isArray(response) ||
        Object.keys(response).length !== 1 ||
        typeof (response as { path?: unknown }).path !== 'string'
      )
        throw new Error('Агент вернул неверный результат обложки. Ожидается JSON с одним полем path.');
      return { path: (response as { path: string }).path };
    } finally {
      unsubscribe?.();
      signal.removeEventListener('abort', stop);
      await manager.shutdownAndWait();
    }
  };
}
