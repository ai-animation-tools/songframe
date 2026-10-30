/** Страницы боковой навигации: подписи и маршруты одни для меню и ссылок в текстах сообщений. */
import { navigationTexts } from '@shared/texts/navigation';

export interface NavPage {
  to: string;
  label: string;
  needsProject?: boolean;
}

export const NAV_PAGES: readonly NavPage[] = [
  { to: '/projects', label: navigationTexts.pages.projects },
  { to: '/project', label: navigationTexts.pages.project, needsProject: true },
  { to: '/project/sources', label: navigationTexts.pages.sources, needsProject: true },
  { to: '/project/timing', label: navigationTexts.pages.timing, needsProject: true },
  { to: '/project/cast', label: navigationTexts.pages.cast, needsProject: true },
  { to: '/project/scenario', label: navigationTexts.pages.scenario, needsProject: true },
  { to: '/project/production', label: navigationTexts.pages.production, needsProject: true },
  { to: '/project/scenes', label: navigationTexts.pages.scenes, needsProject: true },
  { to: '/project/montage', label: navigationTexts.pages.montage, needsProject: true },
  { to: '/project/checks', label: navigationTexts.pages.checks, needsProject: true },
  { to: '/project/animatic', label: navigationTexts.pages.animatic, needsProject: true },
  { to: '/jobs', label: navigationTexts.pages.jobs },
  { to: '/environment', label: navigationTexts.pages.environment },
  { to: '/settings', label: navigationTexts.pages.settings },
  { to: '/help', label: navigationTexts.pages.help }
];
