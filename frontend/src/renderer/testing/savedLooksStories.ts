/**
 * Модель сохранённых образов для историй: библиотека аккаунта и привязки в памяти, тот же расчёт статусов, что у
 * Go (нет привязки — none, нет образа в аккаунте — missing, отмечено устаревшим — stale). Журнал вызовов виден
 * через savedLooksStoryCalls().
 */
import type { Api } from '@shared/api';
import type { SavedLook, SavedLookInput, SavedLookRules, SavedLookStatus, SavedLooksView, ShotLooksView } from '@shared/saved-looks';

export const SAVED_LOOKS_STORY_RULES: SavedLookRules = {
  nameMaxChars: 20,
  extraMin: 1,
  extraMax: 3,
  kinds: ['character', 'vehicle', 'location', 'prop', 'costume'],
  coverFixed: true
};

export interface SavedLooksStoryOptions {
  /** false — провайдер видео образов не хранит. */
  supported?: boolean;
  provider?: string;
  /** Сбой списка аккаунта (например, нет входа). */
  listError?: string;
  looks?: SavedLook[];
  /** Код референса → образ и признак «снимки изменились». */
  bindings?: Record<string, { look: string; stale?: boolean }>;
  /** Ошибка одного создания. */
  failCreateOnce?: string;
  /** Герои «В кадре» плана для savedLooks.shot: код и имя; по умолчанию — референсы описи под своими кодами. */
  heroes?: { code: string; name: string; kind?: string }[];
  /** Ожидаемая модель плана для savedLooks.shot и её предел образов (0 — модель образов не принимает); по умолчанию test-video и 3. */
  model?: string;
  limit?: number;
}

export type SavedLooksStoryCall = [string, ...unknown[]];

let calls: SavedLooksStoryCall[] = [];
/** Вызовы действий образов в открытой истории. */
export function savedLooksStoryCalls(): SavedLooksStoryCall[] {
  return structuredClone(calls);
}

/** Группа window.api.savedLooks над состоянием в памяти; references — коды референсов описи в её порядке. */
export function createSavedLooksModel(options: SavedLooksStoryOptions, references: () => string[]): Api['savedLooks'] {
  calls = [];
  const looks: SavedLook[] = structuredClone(options.looks ?? []);
  const bindings = new Map(Object.entries(structuredClone(options.bindings ?? {})));
  let failCreate = options.failCreateOnce;
  let next = 100;
  const view = (): SavedLooksView => {
    if (options.supported === false) return { supported: false, provider: options.provider ?? 'test', rules: null, report: null, error: '' };
    if (options.listError)
      return { supported: true, provider: options.provider ?? 'test', rules: SAVED_LOOKS_STORY_RULES, report: null, error: options.listError };
    const states = references().map((reference) => {
      const binding = bindings.get(reference);
      if (!binding) return { reference, status: 'none' as SavedLookStatus };
      const look = looks.find((item) => item.id === binding.look);
      const status: SavedLookStatus = !look ? 'missing' : binding.stale ? 'stale' : 'ready';
      return { reference, status, look: binding.look, name: look?.name ?? binding.look };
    });
    return {
      supported: true,
      provider: options.provider ?? 'test',
      rules: SAVED_LOOKS_STORY_RULES,
      report: { account: 'story-account', count: looks.length, states, looks: structuredClone(looks) },
      error: ''
    };
  };
  const shot = (byReferences = false): ShotLooksView => {
    const current = view();
    const heroes = (options.heroes ?? references().map((code): { code: string; name: string; kind?: string } => ({ code, name: code }))).map((hero) => {
      const state = current.report?.states.find((item) => item.reference === hero.code);
      return { ...hero, kind: hero.kind ?? 'character', status: state?.status ?? ('none' as SavedLookStatus), look: state?.look, lookName: state?.name };
    });
    return {
      supported: current.supported,
      references: byReferences,
      model: options.model ?? 'test-video',
      limit: current.supported ? (options.limit ?? 3) : 0,
      kinds: current.supported ? [...SAVED_LOOKS_STORY_RULES.kinds] : [],
      heroes: current.supported ? heroes : [],
      error: current.error
    };
  };
  return {
    view: async () => view(),
    shot: async (_project: string, _shot: string, references?: boolean) => shot(references),
    create: async (_project: string, reference: string, input: SavedLookInput) => {
      calls.push(['create', reference, structuredClone(input)]);
      if (failCreate) {
        const message = failCreate;
        failCreate = undefined;
        throw new Error(message);
      }
      const id = String(next++);
      looks.push({ id, name: input.name });
      bindings.set(reference, { look: id });
      return view();
    },
    bind: async (_project: string, reference: string, look: string) => {
      calls.push(['bind', reference, look]);
      bindings.set(reference, { look });
      return view();
    },
    unbind: async (_project: string, reference: string) => {
      calls.push(['unbind', reference]);
      bindings.delete(reference);
      return view();
    },
    remove: async (_project: string, look: string) => {
      calls.push(['remove', look]);
      looks.splice(
        looks.findIndex((item) => item.id === look),
        1
      );
      for (const [reference, binding] of bindings) if (binding.look === look) bindings.delete(reference);
      return view();
    }
  };
}
