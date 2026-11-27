/**
 * Сохранённые образы сущностей: облик героя, предмета или локации, который провайдер видео хранит в
 * аккаунте и держит в генерации и там, где опора его не показывает. Владелец образа — референс на
 * «Исходниках»; привязки и статусы ведёт Go (window.api.savedLooks) в каталоге состояния, проект не
 * меняется. Здесь — типы контракта и чистые правила окна образа.
 */

/** Ограничения образа у провайдера видео проекта. */
export interface SavedLookRules {
  /** Предел длины имени в символах; имя уникально в аккаунте. */
  nameMaxChars: number;
  /** Сколько дополнительных снимков нужно образу. */
  extraMin: number;
  extraMax: number;
  /** Общие виды образов, которые провайдер хранит. */
  kinds: string[];
  /** Главный снимок нельзя сменить без удаления и создания образа заново. */
  coverFixed: boolean;
}

/** none — образа нет, ready — создан, stale — снимки референса изменились после создания, missing — образа нет в аккаунте. */
export type SavedLookStatus = 'none' | 'ready' | 'stale' | 'missing';

export interface SavedLookState {
  reference: string;
  status: SavedLookStatus;
  look?: string;
  name?: string;
}

export interface SavedLook {
  id: string;
  name: string;
}

export interface SavedLooksReport {
  account: string;
  /** Образов в аккаунте: место в пределе библиотеки провайдера. */
  count: number;
  states: SavedLookState[];
  looks: SavedLook[];
}

export interface SavedLooksView {
  /** Провайдер видео проекта хранит образы; false — блока образов нет. */
  supported: boolean;
  provider: string;
  rules: SavedLookRules | null;
  /** null — статусы неизвестны, причина в error. */
  report: SavedLooksReport | null;
  error: string;
}

/** Новый образ из сохранённых снимков референса: пути — как в описи (внутри source). */
export interface SavedLookInput {
  name: string;
  description: string;
  kind: string;
  cover: string;
  extra: string[];
}

/** Виды образа, которые общий код знает; костюм — отдельный образ одежды для переодевания героя. */
export const SAVED_LOOK_KINDS = ['character', 'vehicle', 'location', 'prop', 'costume'] as const;

/** Статус образа референса; провайдер без образов или неизвестные статусы — null. */
export function savedLookState(view: SavedLooksView | null, reference: string): SavedLookState | null {
  if (!view?.supported || !view.report) return null;
  return view.report.states.find((state) => state.reference === reference) ?? { reference, status: 'none' };
}

/** Вид нового образа по виду референса: свой вид референса, если провайдер его хранит, иначе первый доступный. */
export function defaultSavedLookKind(referenceKind: string, rules: SavedLookRules): string {
  return rules.kinds.includes(referenceKind) ? referenceKind : (rules.kinds[0] ?? '');
}

/** Имя нового образа по имени референса в пределах длины провайдера (по символам, не по UTF-16). */
export function defaultSavedLookName(referenceName: string, rules: SavedLookRules): string {
  const name = referenceName.trim();
  return rules.nameMaxChars > 0 ? Array.from(name).slice(0, rules.nameMaxChars).join('').trim() : name;
}

/** Длина имени в символах, как её считает провайдер. */
export function savedLookNameLength(name: string): number {
  return Array.from(name.trim()).length;
}
