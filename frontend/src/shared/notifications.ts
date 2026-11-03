/** Переход из системного уведомления к проекту, которому принадлежит завершённое задание. */
export interface NotificationTarget {
  project: string;
  route: '/project/timing' | '/project/checks' | '/project/animatic' | '/project/scenario' | '/project/production';
}
