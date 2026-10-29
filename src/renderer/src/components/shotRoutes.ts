/** Адреса страниц, открывающих тот же план: параметр ?shot= выбирает его при открытии страницы. */

export const SHOT_PARAM = 'shot';

export type ShotPage = 'production' | 'scenario';

const SHOT_PAGE_PATHS: Record<ShotPage, string> = {
  production: '/project/production',
  scenario: '/project/scenario'
};

/** Маршрут страницы с выбранным планом; код плана кодируется как значение параметра. */
export function shotPageRoute(page: ShotPage, shot: string): string {
  return `${SHOT_PAGE_PATHS[page]}?${new URLSearchParams({ [SHOT_PARAM]: shot })}`;
}
