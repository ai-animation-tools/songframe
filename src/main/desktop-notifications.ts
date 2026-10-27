/** Нативная доставка итогов: сбой системного уведомления не меняет результат задания. */
import { Notification } from 'electron';
import type { NotificationTarget } from '@shared/notifications';
import type { TaskNotice } from './task-notifications';

export class DesktopNotifications {
  private readonly active = new Set<Notification>();

  constructor(private readonly open: (target: NotificationTarget) => void) {}

  show(notice: TaskNotice): void {
    try {
      if (!Notification.isSupported()) return;
      const notification = new Notification({ title: notice.title, body: notice.body });
      // Сохраняем объект до закрытия: сборка мусора не должна отозвать уведомление и его click.
      this.active.add(notification);
      notification.once('close', () => this.active.delete(notification));
      notification.once('failed', (_event, error) => {
        this.active.delete(notification);
        console.warn('Не удалось показать системное уведомление:', error);
      });
      notification.once('click', () => {
        this.active.delete(notification);
        try {
          this.open(notice.target);
        } catch (error) {
          console.warn('Не удалось открыть результат из уведомления:', error);
        }
      });
      try {
        notification.show();
      } catch (error) {
        this.active.delete(notification);
        throw error;
      }
    } catch (error) {
      console.warn('Не удалось показать системное уведомление:', error);
    }
  }
}
