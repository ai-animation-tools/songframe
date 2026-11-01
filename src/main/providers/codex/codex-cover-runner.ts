/** Изображения Codex рисует встроенным image_gen в отдельном рабочем проекте: его история и все разрешённые записи остаются рядом с кандидатом. */
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative } from 'node:path';
import { referenceGenerationMessages } from '@shared/texts/reference-images';
import { sourcesTexts } from '@shared/texts/sources';
import type { GenerationReferenceImage } from '@shared/cover-generation';
import type { AgentJob } from '@shared/agents';
import { AgentManager, TEXT_LIMIT } from '../../agent-manager';
import type { CoverCandidateRunner } from '../../cover-generation';
import { SettingsStore } from '../../settings';
import { checkedCoverReferences } from '../../cover-reference-inputs';
import type { AgentCoverDeps } from '../types';

/* eslint-disable no-restricted-syntax -- Инструкция встроенному image_gen относится к протоколу конкретного адаптера, а не к UI. */
const REFERENCE_PROMPT = 'Создай одно изображение референса по пользовательскому описанию из дополнительного контекста. ';
const REFERENCE_GUIDANCE =
  'referenceImages — опорные изображения этого же объекта. Сначала просмотри все эти файлы и передай их встроенному image_gen как изображения-референсы. Сохрани внешность, узнаваемые черты, одежду и конструкцию объекта, учитывай обозначенные ракурсы. Следуй общему визуальному стилю клипа из userPrompt; меняй только то, что явно попросил пользователь. Не заменяй опоры посторонними персонажами и не создавай новый дизайн без просьбы. ';
const COVER_PROMPT = 'Создай одну квадратную обложку по пользовательскому описанию из дополнительного контекста. ';
const IMAGE_PROMPT =
  'Обязательно используй встроенный инструмент image_gen, создай настоящее изображение и сохрани один результат в текущей рабочей папке. ' +
  'Разрешены PNG, JPEG и WebP; расширение обязано соответствовать реальному формату. ' +
  'Не используй внешние сервисы генерации, API-ключи, программную отрисовку, SVG, заглушки, имитацию или сторонние генераторы. ' +
  'Если встроенный image_gen недоступен, заверши задачу с объяснением ошибки. ' +
  'Не изменяй исходный проект и не выполняй commit/push. Финальный ответ — ровно один JSON без Markdown: {"path":"cover.png"}. ' +
  'Для JPEG или WebP укажи соответствующее имя созданного файла.';
/* eslint-enable no-restricted-syntax */

/** Проверяется именно JSON для stdin: экранирование и подписи опор тоже занимают бюджет контекста. */
function encodeContext(prompt: string, referenceImages: GenerationReferenceImage[]): string {
  const context = JSON.stringify({ userPrompt: prompt, ...(referenceImages.length ? { referenceImages } : {}) });
  if (Buffer.byteLength(context) > TEXT_LIMIT) throw new Error(referenceGenerationMessages.referenceContextTooLarge);
  return context;
}
function referencePath(workDir: string, image: GenerationReferenceImage, index: number): string {
  const local = relative(workDir, image.path);
  return isAbsolute(local) || local === '..' || local.startsWith('../') || local.startsWith('..\\')
    ? `references/${String(index + 1).padStart(2, '0')}${extname(image.path).toLowerCase()}`
    : local.split('\\').join('/');
}

export function createCodexCoverRunner({ config, createManager = (value) => new AgentManager(value) }: AgentCoverDeps): CoverCandidateRunner {
  const runner: CoverCandidateRunner = async ({ workDir, prompt, signal, purpose, references }) => {
    const texts = purpose === 'reference' ? { ...sourcesTexts.main, ...referenceGenerationMessages } : sourcesTexts.main;
    if (signal.aborted) throw new Error(texts.coverGenerationStopped);
    // Даже при прямом вызове исполнителя агент получает только проверенные копии внутри своей папки.
    const referenceImages = checkedCoverReferences(references).map((image, index) => {
      const path = referencePath(workDir, image, index);
      if (join(workDir, path) !== image.path) {
        mkdirSync(dirname(join(workDir, path)), { recursive: true });
        copyFileSync(image.path, join(workDir, path));
        chmodSync(join(workDir, path), 0o444);
      }
      return { ...image, path };
    });
    checkedCoverReferences(referenceImages.map((image) => ({ ...image, path: join(workDir, image.path) })));
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
          prompt: (purpose === 'reference' ? REFERENCE_PROMPT + (referenceImages.length ? REFERENCE_GUIDANCE : '') : COVER_PROMPT) + IMAGE_PROMPT,
          context: encodeContext(prompt, referenceImages)
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
  runner.validateInput = ({ workDir, prompt, references }) => {
    const images = checkedCoverReferences(references).map((image, index) => ({ ...image, path: referencePath(workDir, image, index) }));
    encodeContext(prompt, images);
  };
  return runner;
}
