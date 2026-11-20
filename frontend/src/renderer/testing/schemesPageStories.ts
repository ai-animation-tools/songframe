import type { AppState } from '@shared/types';
import type { SchemesFile, SchemesView } from '@shared/schemes';
import type { StoryOptions } from './storybook';
import { draftEnvelope } from '@shared/drafts';

/** Локальная модель страницы «Схемы»: локации кастинга, сохранённый документ и счётчик записей. */
export const SCHEMES_STORY_PROJECT = '/mock/projects/schemes-story';

/** Вид сверху перекрёстка со всеми типами фигур: дорога, дом с высотой, сквер, плавная трасса, клумба, светофор. */
export const SCHEMES_STORY_DOCUMENT: SchemesFile = {
  schema_version: 1,
  schemes: [
    {
      id: 's1',
      location: 'crossing',
      title: 'Перекрёсток сверху',
      view: 'top',
      objects: [
        { id: 'o1', name: 'Проезжая часть', shape: { type: 'rect', center: [5, 20], size: [10, 60], rotation: 0 } },
        { id: 'o2', name: 'Длинный дом', height: 12, shape: { type: 'rect', center: [22, 30], size: [16, 40], rotation: 0 } },
        {
          id: 'o3',
          name: 'Ограждение',
          height: 1,
          shape: {
            type: 'line',
            points: [
              [10.2, 10],
              [10.2, 50]
            ],
            smooth: false,
            closed: false
          }
        },
        { id: 'o4', name: 'Светофор', height: 3.5, shape: { type: 'point', at: [10.5, 9] } },
        {
          id: 'o5',
          name: 'Сквер',
          height: 7,
          color: '#4caf50',
          shape: {
            type: 'polygon',
            points: [
              [14, -10],
              [30, -10],
              [30, 9],
              [14, 9]
            ]
          }
        },
        { id: 'o6', name: 'Клумба', shape: { type: 'ellipse', center: [22, 0], radii: [2, 2], rotation: 0 } },
        {
          id: 'o7',
          name: 'Велодорожка',
          shape: {
            type: 'line',
            points: [
              [-8, -10],
              [-4, 10],
              [-8, 30],
              [-4, 50]
            ],
            smooth: true,
            closed: false,
            width: 2
          }
        }
      ]
    }
  ]
};

/** Что записала модель: сохранённый документ и число записей. */
export interface SchemesStorySnapshot {
  document: SchemesFile;
  saves: number;
  /** Черновик во временном файле каталога состояния; null — файла нет. */
  draft: string | null;
}

let activeSnapshot: (() => SchemesStorySnapshot) | null = null;
export function schemesStorySnapshot(): SchemesStorySnapshot {
  if (!activeSnapshot) throw new Error('Модель страницы «Схемы» не открыта.');
  return activeSnapshot();
}

export interface SchemesStoryOptions {
  /** Документа ещё нет: у всех локаций нет вида сверху. */
  empty?: boolean;
  /** Файл повреждён: страница показывает ошибку и не даёт сохранить. */
  damaged?: boolean;
  /** В кастинге нет локаций. */
  noLocations?: boolean;
  route?: string;
  /** Остался черновик прошлого запуска: схема переименована; changed — файл схем изменился после начала правок. */
  leftDraft?: 'same' | 'changed';
}

/** Страница «Схемы» на локальной модели: запись проверяет только наличие названий, как минимальная проверка Go. */
export function schemesPageOptions(options: SchemesStoryOptions = {}): StoryOptions {
  const state: AppState = { packaged: false, problems: [], localDir: '/mock/state', current: SCHEMES_STORY_PROJECT, history: [], platform: 'linux' };
  return {
    shell: 'page',
    route: options.route ?? '/project/schemes',
    app: { state },
    createApi: () => {
      let saved: SchemesFile = options.empty || options.damaged ? { schema_version: 1, schemes: [] } : structuredClone(SCHEMES_STORY_DOCUMENT);
      let saves = 0;
      let draft: string | null = null;
      if (options.leftDraft) {
        const document = structuredClone(saved);
        document.schemes[0].title = 'Перекрёсток из черновика';
        const base = options.leftDraft === 'changed' ? { ...saved, schemes: [] } : saved;
        draft = draftEnvelope(document, base, new Date('2026-11-20T09:15:00Z'));
      }
      activeSnapshot = () => structuredClone({ document: saved, saves, draft });
      const locations = options.noLocations
        ? []
        : [
            { id: 'crossing', name: 'Перекрёсток' },
            { id: 'street', name: 'Улица у мастерской' }
          ];
      const view = (): SchemesView => ({
        document: structuredClone(saved),
        missing: !saved.schemes.length && !options.damaged,
        damaged: !!options.damaged,
        locations,
        problems: options.damaged ? ['plan/schemes.json повреждён.'] : [],
        withoutTop: locations
          .filter((location) => !saved.schemes.some((scheme) => scheme.location === location.id && scheme.view === 'top'))
          .map((item) => item.id)
      });
      return {
        projects: {
          readDraft: async () => draft ?? '',
          writeDraft: async (_project, _kind, content) => {
            draft = content;
          },
          removeDraft: async () => {
            draft = null;
          }
        },
        schemes: {
          view: async () => view(),
          save: async (_project, document) => {
            const unnamed = document.schemes.flatMap((scheme) => scheme.objects.filter((object) => !object.name.trim()).map((object) => object.id));
            if (unnamed.length) throw new Error(`Схема: у объекта ${unnamed[0]} нет названия.`);
            saves += 1;
            saved = structuredClone(document);
            return structuredClone(saved);
          }
        }
      };
    }
  };
}
