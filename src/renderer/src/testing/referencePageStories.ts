/** Минимальные модели настоящих страниц: исходники и состав читаются локально, генерация использует общий цикл imageStories. */
import type { AppState, CastFile, CastView, SourceManifest, SourcesView } from '@shared/types';
import { registerMediaProviderForTests } from '@shared/media-providers';
import { TEST_PROVIDER, testProviderInfo } from '@shared/testing/media-provider';
import { createStoryApi, type StoryOptions } from './storybook';
import { createImageModel, imageStoryAccess, IMAGE_STORY_PROJECT, IMAGE_STORY_IDEA, IMAGE_STORY_LYRICS, type ImageModelInspection } from './imageStories';

export const REFERENCE_PAGE_NAME = 'Механик';
export const REFERENCE_PAGE_NOTE = 'Сохранить лицо';
export const REFERENCE_PAGE_PROFILE_NOTE = 'Сохранить силуэт в профиль';
export const REFERENCE_PAGE_DRAFT_NOTE = 'Сохранить выражение лица из черновика';
export const REFERENCE_PAGE_SAVED = 'characters/hero/story-image.png';
export const REFERENCE_PAGE_UPLOAD = '/mock/uploads/profile/story-image.png';
export const REFERENCE_PAGE_ORIGINAL_PROMPT_PATH = 'characters/hero/story-image.png.prompt.txt';
export const REFERENCE_PAGE_ORIGINAL_PROMPT =
  'Исторический запрос: прежний вариант внешности и студийный свет.\n' + 'Сохранённая подробность старой генерации.\n'.repeat(16);
export const REFERENCE_PAGE_PROFILE = 'characters/profile/story-image.png';
export const REFERENCE_PAGE_BACK = 'characters/back/story-image.png';
export const REFERENCE_PAGE_SHARED_DESCRIPTION = 'Светлая куртка, короткие волосы; сохранять лицо и пропорции.';
export const REFERENCE_PAGE_SAVE_ERROR = 'Не удалось сохранить общее описание. Повторите сохранение.';
export const REFERENCE_PAGE_FOREIGN = 'locations/garden/story-image.png';
export const REFERENCE_PAGE_DRAFT_IDEA = 'Несохранённая идея: герой ремонтирует старые ворота.';
export const REFERENCE_PAGE_DRAFT_LYRICS = '[Куплет 1]\nУ ворот проснулся ветер';
const FILE = { sha256: 'b'.repeat(64), bytes: 1024 };
const manifest: SourceManifest = {
  schema_version: 1,
  updated_at: '2026-11-01',
  track: { ...FILE, path: 'story-track.mp3', original_name: 'Песня.mp3', duration_seconds: 10 },
  lyrics: { ...FILE, path: 'text.md', lines: 1, sections: ['Куплет 1'] },
  idea: { ...FILE, path: 'description.md' },
  cover: null,
  references: [
    {
      id: 'hero',
      kind: 'character',
      name: REFERENCE_PAGE_NAME,
      short_name: 'Герой',
      description: 'Красная куртка, тёмные волосы.',
      prompt: null,
      files: [{ ...FILE, path: REFERENCE_PAGE_SAVED, view: 'front', note: REFERENCE_PAGE_NOTE }]
    },
    {
      id: 'garden',
      kind: 'location',
      name: 'Чужая локация',
      short_name: 'Сад',
      description: 'Соседний объект.',
      prompt: null,
      files: [{ ...FILE, path: REFERENCE_PAGE_FOREIGN, view: 'full', note: '' }]
    }
  ]
};
const cast: CastFile = {
  schema_version: 1,
  properties: {},
  entities: [
    {
      id: 'hero',
      kind: 'character',
      name: REFERENCE_PAGE_NAME,
      short_name: 'Герой',
      role: 'Ремонтирует ворота',
      appearance: 'Красная куртка, тёмные волосы.',
      images: [REFERENCE_PAGE_SAVED],
      initial_state: {}
    },
    {
      id: 'world',
      kind: 'world',
      name: 'Мир сцены',
      short_name: 'Мир',
      role: 'Общие условия',
      appearance: 'Осенний сад.',
      images: [REFERENCE_PAGE_FOREIGN],
      initial_state: {}
    }
  ]
};
let inspection: (() => ImageModelInspection) | null = null;
export function referencePageInspection(): ImageModelInspection {
  if (!inspection) throw new Error('Модель страницы не открыта.');
  return inspection();
}

export interface ReferencePageModelOptions {
  originalPrompt?: boolean;
  missingReferenceImageInspection?: boolean;
  multipleImages?: boolean;
  emptySelection?: boolean;
  failSourceSaveOnce?: boolean;
  failCastSaveOnce?: boolean;
}
interface ReferencePageSnapshot {
  manifest: SourceManifest;
  cast: CastFile;
  sourceSaves: number;
  castSaves: number;
  supplements: number;
}
let activeSnapshot: (() => ReferencePageSnapshot) | null = null;
export function referencePageSnapshot(): ReferencePageSnapshot {
  if (!activeSnapshot) throw new Error('Модель общего описания не открыта.');
  return activeSnapshot();
}

/** Настоящие формы разделяют одно описание; ошибка записи не меняет сохранённые документы. */
export function referencePageOptions(page: 'sources' | 'cast', options: ReferencePageModelOptions = {}): StoryOptions {
  const state: AppState = {
    packaged: false,
    problems: [],
    toolsRoot: '/mock/songframe',
    localDir: '/mock/state',
    current: IMAGE_STORY_PROJECT,
    history: [],
    platform: 'linux'
  };
  return {
    shell: 'page',
    route: page === 'cast' ? '/project/cast?entity=hero' : '/project/sources',
    app: { state, online: true, aiAccess: imageStoryAccess(), agentProvider: 'codex' },
    createApi: () => {
      const images = createImageModel();
      inspection = images.inspect;
      let savedManifest = structuredClone(manifest);
      let savedCast = structuredClone(cast);
      let lyricsText = IMAGE_STORY_LYRICS;
      let ideaText = IMAGE_STORY_IDEA;
      let sourceSaves = 0;
      let castSaves = 0;
      let supplements = 0;
      if (options.originalPrompt) savedManifest.references[0].files[0].prompt = REFERENCE_PAGE_ORIGINAL_PROMPT_PATH;
      if (options.multipleImages) {
        savedManifest.references[0].files.push(
          { ...FILE, sha256: 'c'.repeat(64), path: REFERENCE_PAGE_PROFILE, view: 'side', note: REFERENCE_PAGE_PROFILE_NOTE },
          { ...FILE, sha256: 'd'.repeat(64), path: REFERENCE_PAGE_BACK, view: 'back', note: 'Не выбирать автоматически' }
        );
        savedCast.entities[0].images = [REFERENCE_PAGE_PROFILE, REFERENCE_PAGE_SAVED];
      }
      if (options.emptySelection) savedCast.entities[0].images = [];
      const snapshot = (): ReferencePageSnapshot => structuredClone({ manifest: savedManifest, cast: savedCast, sourceSaves, castSaves, supplements });
      activeSnapshot = snapshot;
      const paths = (): Record<string, string> =>
        Object.fromEntries(savedManifest.references.flatMap((ref) => ref.files.map((file) => [file.path, `${IMAGE_STORY_PROJECT}/source/${file.path}`])));
      const projectDescriptions = (): CastFile => ({
        ...structuredClone(savedCast),
        entities: savedCast.entities.map((entity) => ({
          ...structuredClone(entity),
          appearance: savedManifest.references.find((ref) => ref.id === entity.id)?.description ?? entity.appearance
        }))
      });
      const session = createStoryApi(
        {
          ...images.api,
          sources: {
            view: async (): Promise<SourcesView> => ({
              manifest: structuredClone(savedManifest),
              lyricsText,
              ideaText,
              coverPath: null,
              referenceFilePaths: paths(),
              problems: []
            }),
            validate: async () => [],
            save: async (_project, input) => {
              sourceSaves++;
              if (options.failSourceSaveOnce && sourceSaves === 1) throw new Error(REFERENCE_PAGE_SAVE_ERROR);
              const next = structuredClone(savedManifest);
              next.kinds = input.kinds ?? next.kinds;
              next.references = input.references.map((ref) => ({
                id: ref.id,
                kind: ref.kind,
                name: ref.name.trim(),
                short_name: ref.short_name.trim(),
                description: ref.description.trim(),
                prompt: null,
                files: ref.files.map((file, index) => ({
                  ...FILE,
                  path: file.existingPath ?? `${ref.id}/upload-${index}/story-image.png`,
                  view: file.view,
                  note: file.note,
                  prompt: null
                }))
              }));
              // Картинки и их порядок остаются выбором кастинга; новое описание обновляет его проекцию.
              const nextCast = structuredClone(savedCast);
              for (const entity of nextCast.entities) {
                const ref = next.references.find((ref) => ref.id === entity.id);
                if (ref) entity.appearance = ref.description;
              }
              savedManifest = next;
              savedCast = nextCast;
              if (input.lyrics && 'text' in input.lyrics) lyricsText = input.lyrics.text;
              if (input.idea && 'text' in input.idea) ideaText = input.idea.text;
              return structuredClone(savedManifest);
            }
          },
          cast: {
            view: async (): Promise<CastView> => ({ cast: projectDescriptions(), manifest: structuredClone(savedManifest), imagePaths: paths(), problems: [] }),
            save: async (_project, input) => {
              castSaves++;
              if (options.failCastSaveOnce && castSaves === 1) throw new Error(REFERENCE_PAGE_SAVE_ERROR);
              const nextCast = structuredClone(input);
              const nextManifest = structuredClone(savedManifest);
              for (const entity of nextCast.entities) {
                entity.appearance = entity.appearance.trim();
                const ref = nextManifest.references.find((ref) => ref.id === entity.id);
                if (ref) ref.description = entity.appearance;
              }
              savedManifest = nextManifest;
              savedCast = nextCast;
              return structuredClone(savedCast);
            },
            init: async () => {
              supplements++;
              const next = projectDescriptions();
              for (const ref of savedManifest.references)
                if (!next.entities.some((entity) => entity.id === ref.id))
                  next.entities.push({
                    id: ref.id,
                    kind: ref.kind,
                    name: ref.name,
                    short_name: ref.short_name,
                    role: '',
                    appearance: ref.description,
                    images: ref.files.map((file) => file.path),
                    initial_state: {}
                  });
              savedCast = next;
              return structuredClone(savedCast);
            }
          },
          shell: {
            readText: async (path) => {
              if (options.originalPrompt && path.endsWith(REFERENCE_PAGE_ORIGINAL_PROMPT_PATH)) return REFERENCE_PAGE_ORIGINAL_PROMPT;
              throw new Error('Текстовый файл не предусмотрен этой историей.');
            }
          },
          dialog: { pickFiles: async () => [REFERENCE_PAGE_UPLOAD] }
        },
        { missingReferenceImageInspection: options.missingReferenceImageInspection }
      );
      session.onCleanup(registerMediaProviderForTests(TEST_PROVIDER, testProviderInfo));
      session.onCleanup(images.dispose);
      session.onCleanup(() => {
        if (inspection === images.inspect) inspection = null;
        if (activeSnapshot === snapshot) activeSnapshot = null;
      });
      return session;
    }
  };
}
