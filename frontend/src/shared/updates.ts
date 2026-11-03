/** Состояние обновления приложения для renderer: без путей к файлам, адрес только у страницы выпуска. */
export type UpdateStatus = 'idle' | 'current' | 'available' | 'downloading' | 'ready' | 'error';

export interface UpdateView {
  status: UpdateStatus;
  currentVersion: string;
  /** Найденная версия выпуска, если проверка её получила. */
  version?: string;
  /** Страница выпуска на GitHub с описанием изменений. */
  releaseUrl?: string;
  /** Доля скачанного пакета от 0 до 1 во время скачивания. */
  progress?: number;
  /** Установка заменяет приложение и перезапускает его; иначе пакет открывается в папке для ручной замены. */
  installable?: boolean;
  message?: string;
}

export interface UpdatesApi {
  view(): Promise<UpdateView>;
  check(): Promise<UpdateView>;
  download(): Promise<UpdateView>;
  install(): Promise<UpdateView>;
}
