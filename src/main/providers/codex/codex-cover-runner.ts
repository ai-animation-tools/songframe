/** Изображения Codex рисует встроенным image_gen в отдельном рабочем проекте: его история и все разрешённые записи остаются рядом с кандидатом. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { referenceGenerationMessages } from '@shared/texts/reference-images';
import { sourcesTexts } from '@shared/texts/sources';
import type { AgentJob } from '@shared/agents';
import { AgentManager } from '../../agent-manager';
import type { CoverCandidateRunner } from '../../cover-generation';
import { SettingsStore } from '../../settings';
import type { AgentCoverDeps } from '../types';

/* eslint-disable no-restricted-syntax -- Инструкция встроенному image_gen относится к протоколу конкретного адаптера, а не к UI. */
const REFERENCE_PROMPT = 'Создай одно изображение референса по пользовательскому описанию из дополнительного контекста. ';
const COVER_PROMPT = 'Создай одну квадратную обложку по пользовательскому описанию из дополнительного контекста. ';
const IMAGE_PROMPT =
  'Обязательно используй встроенный инструмент image_gen, создай настоящее изображение и сохрани один результат в текущей рабочей папке. ' +
  'Разрешены PNG, JPEG и WebP; расширение обязано соответствовать реальному формату. ' +
  'Не используй внешние сервисы генерации, API-ключи, программную отрисовку, SVG, заглушки, имитацию или сторонние генераторы. ' +
  'Если встроенный image_gen недоступен, заверши задачу с объяснением ошибки. ' +
  'Не изменяй исходный проект и не выполняй commit/push. Финальный ответ — ровно один JSON без Markdown: {"path":"cover.png"}. ' +
  'Для JPEG или WebP укажи соответствующее имя созданного файла.';
/* eslint-enable no-restricted-syntax */

export function createCodexCoverRunner({ config, createManager = (value) => new AgentManager(value) }: AgentCoverDeps): CoverCandidateRunner {
  return async ({ workDir, prompt, signal, purpose }) => {
    const texts = purpose === 'reference' ? { ...sourcesTexts.main, ...referenceGenerationMessages } : sourcesTexts.main;
    if (signal.aborted) throw new Error(texts.coverGenerationStopped);
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
        {
          project: root,
          task: texts.coverTaskTitle,
          prompt: (purpose === 'reference' ? REFERENCE_PROMPT : COVER_PROMPT) + IMAGE_PROMPT,
          context: JSON.stringify({ userPrompt: prompt })
        },
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
      if (signal.aborted) throw new Error(texts.coverGenerationStopped);
      if (completed.status !== 'completed' || completed.exitCode !== 0)
        // eslint-disable-next-line no-restricted-syntax -- Подсказка о встроенном инструменте image_gen принадлежит адаптеру Codex.
        throw new Error(completed.message || 'Агент не смог создать обложку. Проверьте доступность встроенного image_gen.');
      let response: unknown;
      try {
        response = JSON.parse(completed.result);
      } catch {
        throw new Error(texts.coverPathMissing);
      }
      if (
        !response ||
        typeof response !== 'object' ||
        Array.isArray(response) ||
        Object.keys(response).length !== 1 ||
        typeof (response as { path?: unknown }).path !== 'string'
      )
        throw new Error(texts.coverResultInvalid);
      return { path: (response as { path: string }).path };
    } finally {
      unsubscribe?.();
      signal.removeEventListener('abort', stop);
      await manager.shutdownAndWait();
    }
  };
}
