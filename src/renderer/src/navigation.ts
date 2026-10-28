/** Страницы боковой навигации: подписи и маршруты одни для меню и ссылок в текстах сообщений. */

export interface NavPage {
  to: string;
  label: string;
  needsProject?: boolean;
}

export const NAV_PAGES: readonly NavPage[] = [
  { to: '/projects', label: 'Проекты' },
  { to: '/project', label: 'Проект', needsProject: true },
  { to: '/project/sources', label: 'Исходники', needsProject: true },
  { to: '/project/timing', label: 'Тайминги', needsProject: true },
  { to: '/project/cast', label: 'Кастинг', needsProject: true },
  { to: '/project/scenario', label: 'Сценарий', needsProject: true },
  { to: '/project/production', label: 'Производство', needsProject: true },
  { to: '/project/scenes', label: 'Сцены', needsProject: true },
  { to: '/project/montage', label: 'Монтаж пробы', needsProject: true },
  { to: '/project/checks', label: 'Проверки', needsProject: true },
  { to: '/project/animatic', label: 'Аниматик', needsProject: true },
  { to: '/jobs', label: 'Журнал заданий' },
  { to: '/environment', label: 'Среда' },
  { to: '/settings', label: 'Настройки' },
  { to: '/help', label: 'Справка' }
];
