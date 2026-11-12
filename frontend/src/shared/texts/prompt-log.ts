/** Тексты страницы «Отправки»: журнал промптов проекта агенту и сервисам генерации. */
import type { PromptLogKind, PromptLogStatus } from '../types';
import { navigationTexts } from './navigation';
import { productionTexts } from './production';

/** Проходы сценария в заголовках заданий ai-clip-scenario:<проход>. */
const SCENARIO_PASSES: Record<string, string> = { treatment: 'трактовка', scenes: 'сцены', revise: 'доработка' };
const STAGE_TITLES: Record<string, string> = productionTexts.planPath.titles;

export const promptLogTexts = {
  heading: navigationTexts.pages.prompts,
  /** Заголовок отправки: служебные имена заданий агента — словами страницы. */
  title: (title: string): string => {
    const scene = /^ai-clip-scene:(M\d{2}(?:\.\d+)?):(\w+)$/.exec(title);
    if (scene) return `${scene[1]} · ${STAGE_TITLES[scene[2]] ?? scene[2]}`;
    const scenario = /^ai-clip-scenario:(\w+)$/.exec(title);
    if (scenario) return `${navigationTexts.pages.scenario} · ${SCENARIO_PASSES[scenario[1]] ?? scenario[1]}`;
    return title;
  },
  count: ({ shown, total }: { shown: number; total: number }) => (shown === total ? `записей: ${total}` : `показано ${shown} из ${total}`),
  kindFilter: 'Вид',
  statusFilter: 'Итог',
  all: 'Все',
  kinds: {
    agent: 'Агент',
    agent_images: 'Изображения агентом',
    image: 'Запрос изображения',
    video: 'Запрос видео'
  } satisfies Record<PromptLogKind, string>,
  statuses: {
    running: 'Выполняется',
    completed: 'Успешно',
    failed: 'Ошибка',
    cancelled: 'Остановлено',
    interrupted: 'Прервано'
  } satisfies Record<PromptLogStatus, string>,
  paid: 'Платная',
  empty:
    'Отправок пока нет. Журнал пополняется сам, когда приложение отправляет промпт агенту или запрос сервису генерации, включая ошибки и остановленные задания.',
  emptyFiltered: 'Под выбранные условия отправок нет.',
  resetFilters: 'Сбросить фильтры',
  loading: 'Загрузка записи',
  loadFailed: ({ reason }: { reason: string }) => `Не удалось прочитать журнал отправок: ${reason}`,
  missing: 'Запись не найдена: возможно, её удалили из папки проекта.',
  started: ({ at }: { at: string }) => `Начато ${at}`,
  finished: ({ at }: { at: string }) => `завершено ${at}`,
  model: ({ model }: { model: string }) => `модель ${model}`,
  open: ({ page }: { page: string }) => `Открыть в «${page}»`,
  openShot: ({ page, shot }: { page: string; shot: string }) => `Открыть ${shot} в «${page}»`,
  prompt: 'Промпт',
  context: 'Контекст',
  parameters: 'Параметры запроса',
  attachments: 'Вложения',
  response: 'Ответ',
  noResponse: 'Ответа нет',
  error: 'Причина',
  copy: 'Копировать',
  truncated: 'Часть текста обрезана: журнал хранит не больше 256 КиБ на поле.',
  generation: ({ id }: { id: string }) => `Генерация ${id}`,
  amount: ({ text }: { text: string }) => `Списано: ${text}`,
  noRead: 'Сведения ниже только для чтения: повторной отправки отсюда нет.'
} as const;
