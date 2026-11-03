/**
 * Цели ссылок в текстах сообщений: «Страница» из навигации, известные блоки страниц и строки страницы «Среда».
 * Новый блок, на который ссылается текст, получает здесь якорь и `data-anchor` у своего элемента.
 */
import { MEDIA_PROVIDERS } from '@shared/media-providers';
import { navigationTexts } from '@shared/texts/navigation';
import { NAV_PAGES } from '../navigation';

/** Параметр маршрута, по которому страница прокручивается к элементу `[data-anchor="<id>"]`. */
export const ANCHOR_PARAM = 'anchor';

export interface LinkTarget {
  path: string;
  anchor?: string;
}

export interface LinkedSegment {
  text: string;
  target?: LinkTarget;
}

/** Якоря блоков: значение ставится в `data-anchor` целевого элемента. */
export const ANCHORS = {
  productionWorkflow: 'production-workflow',
  productionSpeech: 'production-speech',
  productionFilter: 'production-filter',
  checksProject: 'checks-project',
  checksReview: 'checks-review',
  projectVideoGeneration: 'project-video-generation',
  projectImageGeneration: 'project-image-generation',
  projectAnimaticName: 'project-animatic-name'
} as const;

const PRODUCTION = '/project/production';
const CHECKS = '/project/checks';
const ENVIRONMENT = '/environment';
const PROJECT = '/project';

/** Блоки, поля и строки страниц по их названию в кавычках. */
export const BLOCK_TARGETS: Readonly<Record<string, LinkTarget>> = {
  [navigationTexts.blocks.productionWorkflow]: { path: PRODUCTION, anchor: ANCHORS.productionWorkflow },
  [navigationTexts.blocks.productionSpeech]: { path: PRODUCTION, anchor: ANCHORS.productionSpeech },
  [navigationTexts.blocks.productionLipSync]: { path: PRODUCTION, anchor: ANCHORS.productionSpeech },
  // Очередь открывается фильтром «Показать» панели производства.
  [navigationTexts.blocks.productionQueue]: { path: PRODUCTION, anchor: ANCHORS.productionFilter },
  [navigationTexts.blocks.checksProject]: { path: CHECKS, anchor: ANCHORS.checksProject },
  [navigationTexts.blocks.checksReview]: { path: CHECKS, anchor: ANCHORS.checksReview },
  [navigationTexts.blocks.projectVideoGeneration]: { path: PROJECT, anchor: ANCHORS.projectVideoGeneration },
  [navigationTexts.blocks.projectImageGeneration]: { path: PROJECT, anchor: ANCHORS.projectImageGeneration },
  [navigationTexts.blocks.projectAnimaticName]: { path: PROJECT, anchor: ANCHORS.projectAnimaticName }
};

/** Падежные формы названий страниц, встречающиеся в текстах: «в «Исходниках»», «на «Производстве»». */
export const PAGE_ALIASES: Readonly<Record<string, string>> = {
  [navigationTexts.pageForms.sourcesPrepositional]: navigationTexts.pages.sources,
  [navigationTexts.pageForms.timingPrepositional]: navigationTexts.pages.timing,
  [navigationTexts.pageForms.timingGenitive]: navigationTexts.pages.timing,
  [navigationTexts.pageForms.castPrepositional]: navigationTexts.pages.cast,
  [navigationTexts.pageForms.scenarioPrepositional]: navigationTexts.pages.scenario,
  [navigationTexts.pageForms.productionPrepositional]: navigationTexts.pages.production,
  [navigationTexts.pageForms.checksPrepositional]: navigationTexts.pages.checks,
  [navigationTexts.pageForms.animaticPrepositional]: navigationTexts.pages.animatic,
  [navigationTexts.pageForms.jobsPrepositional]: navigationTexts.pages.jobs,
  [navigationTexts.pageForms.environmentPrepositional]: navigationTexts.pages.environment,
  [navigationTexts.pageForms.settingsPrepositional]: navigationTexts.pages.settings,
  [navigationTexts.pageForms.helpPrepositional]: navigationTexts.pages.help
};

/**
 * Строки страницы «Среда» по названию в том же предложении: id строки равен id провайдера из реестра,
 * а для зависимостей поставки — id проверки среды.
 */
function environmentRows(): Array<{ title: string; id: string }> {
  return [
    ...Object.entries(MEDIA_PROVIDERS).map(([id, info]) => ({ title: info.title, id })),
    { title: 'Python', id: 'python' },
    { title: 'FFmpeg', id: 'ffmpeg' },
    { title: 'ffprobe', id: 'ffprobe' }
  ];
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Название упомянуто отдельным словом: название сервиса в «Войдите в …», но не в части другого слова. */
function mentionIndex(sentence: string, title: string): number {
  const match = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(title)}(?![\\p{L}\\p{N}])`, 'u').exec(sentence);
  return match ? match.index + match[1].length : -1;
}

/**
 * Предложение вокруг позиции. Граница — знак конца предложения перед заглавной буквой или перевод строки;
 * отсылка «См. страницу …» продолжает предыдущее предложение, а сокращение «См.» само границей не считается.
 */
function sentenceAround(text: string, start: number, end: number): string {
  let from = 0;
  let to = text.length;
  for (const boundary of text.matchAll(/[.!?]+\s+(?=[\p{Lu}\d«])(?!См\.)|\n+/gu)) {
    const boundaryEnd = boundary.index + boundary[0].length;
    if (boundaryEnd <= start) from = boundaryEnd;
    else if (boundary.index >= end) {
      to = boundary.index;
      break;
    }
  }
  return text.slice(from, to);
}

function environmentAnchor(sentence: string): string | undefined {
  const found = environmentRows()
    .map((row) => ({ id: row.id, index: mentionIndex(sentence, row.title) }))
    .filter((row) => row.index >= 0)
    .sort((a, b) => a.index - b.index);
  return found[0]?.id;
}

/** Цель названия в кавычках или undefined, если это не страница и не известный блок. */
export function resolveLinkTarget(name: string, sentence = ''): LinkTarget | undefined {
  const block = Object.hasOwn(BLOCK_TARGETS, name) ? BLOCK_TARGETS[name] : undefined;
  if (block) return block;
  const label = Object.hasOwn(PAGE_ALIASES, name) ? PAGE_ALIASES[name] : name;
  const page = NAV_PAGES.find((item) => item.label === label);
  if (!page) return undefined;
  const anchor = page.to === ENVIRONMENT ? environmentAnchor(sentence) : undefined;
  return anchor ? { path: page.to, anchor } : { path: page.to };
}

/**
 * Делит текст на обычные части и ссылки. Ссылка включает кавычки «»; ссылка на текущую страницу без якоря
 * ничего не даёт и остаётся текстом.
 */
export function linkSegments(text: string, currentPath?: string): LinkedSegment[] {
  const segments: LinkedSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(/«([^«»]+)»/g)) {
    const start = match.index;
    const end = start + match[0].length;
    const target = resolveLinkTarget(match[1], sentenceAround(text, start, end));
    if (!target || (target.path === currentPath && !target.anchor)) continue;
    if (start > last) segments.push({ text: text.slice(last, start) });
    segments.push({ text: match[0], target });
    last = end;
  }
  if (last < text.length || !segments.length) segments.push({ text: text.slice(last) });
  return segments;
}

/** Адрес ссылки: на текущей странице сохраняются её параметры (например, ?shot=), к ним добавляется якорь. */
export function linkLocation(target: LinkTarget, current: { pathname: string; search: string }): { pathname: string; search: string } {
  const params = new URLSearchParams(target.path === current.pathname ? current.search : '');
  params.delete(ANCHOR_PARAM);
  if (target.anchor) params.set(ANCHOR_PARAM, target.anchor);
  const search = params.toString();
  return { pathname: target.path, search: search ? `?${search}` : '' };
}
