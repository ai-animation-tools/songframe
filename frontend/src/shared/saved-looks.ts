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

/** Герой «В кадре» плана и его образ: по ним окно своего видеопромпта предлагает метки героев. */
export interface ShotLook {
  code: string;
  name: string;
  /** Вид сущности кастинга (character, prop, …). */
  kind: string;
  status: SavedLookStatus;
  look?: string;
  lookName?: string;
}

export interface ShotLooksView {
  /** Провайдер видео проекта хранит образы; false — меток героев не предлагается. */
  supported: boolean;
  /** Модель, которую сборка запроса плана пробует первой, и сколько образов она примет (0 — не принимает). */
  model: string;
  limit: number;
  /** Виды сущностей, чей образ принимает модель. */
  kinds: string[];
  heroes: ShotLook[];
  /** Почему статусы неизвестны; статусы героев тогда none. */
  error: string;
}

/**
 * Образ замороженного запроса, требующий внимания перед отправкой: missing — образа нет в аккаунте (отправка
 * невозможна), changed — у референса теперь другой образ или привязки нет, stale — снимки референса изменились.
 */
export interface SavedLookCheck {
  code: string;
  entity: string;
  name: string;
  status: 'missing' | 'changed' | 'stale';
}

/** Образ сущности в замороженном запросе видео: код сущности кастинга, её имя, ID и имя образа аккаунта. */
export interface SavedLookUse {
  code: string;
  entity: string;
  look: string;
  name: string;
}

/** Метка сущности в видеопромпте: до заморозки запроса приложение заменяет её разметкой провайдера или убирает. */
export function savedLookMark(code: string): string {
  return `[@${code}]`;
}

/**
 * Вставляет метку героя за курсором или за выделением (выделенное упоминание остаётся: метка ставится после него).
 * Слева от метки — пробел, если там не пробел и не начало текста; справа — пробел, если дальше буква или цифра.
 * Возвращает новый текст и позицию курсора сразу после метки.
 */
export function insertSavedLookMark(text: string, start: number, end: number, code: string): { text: string; caret: number } {
  const position = Math.max(start, end);
  const before = text.slice(0, position);
  const after = text.slice(position);
  const mark = (before === '' || /\s$/.test(before) ? '' : ' ') + savedLookMark(code);
  const gap = /^[\p{L}\p{N}]/u.test(after) ? ' ' : '';
  return { text: before + mark + gap + after, caret: before.length + mark.length };
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

/** Вопрос перед описанием плана: сущности «В кадре» без действующего образа и сколько образов сверх предела модели. */
export interface DescriptionLooksQuestion {
  model: string;
  limit: number;
  /** Сущности видов, которые принимает модель, без образа или с образом, которого нет в аккаунте. */
  without: ShotLook[];
  /** Сколько сущностей принимаемых видов в кадре с образом, если их больше предела модели; 0 — не больше. */
  over: number;
}

/**
 * Нужен ли вопрос перед описанием плана: модель плана принимает сохранённые образы, а у части сущностей в кадре
 * образа нет или образов больше, чем модель примет. null — спрашивать не о чем: модель образы не принимает,
 * статусы неизвестны (сбой списка — сборка запроса проверит сама) или всё в порядке.
 */
export function descriptionLooksQuestion(view: ShotLooksView): DescriptionLooksQuestion | null {
  if (!view.supported || view.limit <= 0 || view.error) return null;
  const eligible = view.heroes.filter((hero) => view.kinds.includes(hero.kind));
  const without = eligible.filter((hero) => hero.status === 'none' || hero.status === 'missing');
  const withLook = eligible.filter((hero) => hero.status === 'ready' || hero.status === 'stale').length;
  const over = withLook > view.limit ? withLook : 0;
  return without.length || over ? { model: view.model, limit: view.limit, without, over } : null;
}
