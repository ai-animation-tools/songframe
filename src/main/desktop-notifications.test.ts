import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskNotice } from './task-notifications';

const native = vi.hoisted(() => ({ supported: true, failShow: false, instances: [] as EventEmitter[] }));
vi.mock('electron', () => ({
  Notification: class extends EventEmitter {
    static isSupported(): boolean {
      return native.supported;
    }
    constructor(readonly options: { title: string; body: string }) {
      super();
      native.instances.push(this);
    }
    show(): void {
      if (native.failShow) throw new Error('Нет службы уведомлений');
    }
  }
}));

import { DesktopNotifications } from './desktop-notifications';

const notice: TaskNotice = {
  title: 'Аниматик готов',
  body: 'Сборка аниматика',
  target: { project: '/test/clip', route: '/project/animatic' }
};

describe('DesktopNotifications', () => {
  beforeEach(() => {
    native.supported = true;
    native.failShow = false;
    native.instances = [];
    vi.restoreAllMocks();
  });

  it('открывает проект завершённого задания только по нажатию', () => {
    const open = vi.fn();
    new DesktopNotifications(open).show(notice);
    expect(open).not.toHaveBeenCalled();
    native.instances[0].emit('click');
    native.instances[0].emit('click');
    expect(open).toHaveBeenCalledExactlyOnceWith(notice.target);
  });

  it('не создаёт уведомление при отсутствии поддержки ОС', () => {
    native.supported = false;
    new DesktopNotifications(vi.fn()).show(notice);
    expect(native.instances).toHaveLength(0);
  });

  it('ошибка ОС не прерывает завершение задания', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const notifications = new DesktopNotifications(vi.fn());
    expect(() => notifications.show(notice)).not.toThrow();
    native.instances[0].emit('failed', {}, 'Отключено системой');
    native.failShow = true;
    expect(() => notifications.show(notice)).not.toThrow();
    expect(warning).toHaveBeenCalledTimes(2);
  });

  it('ошибка перехода обрабатывается отдельно от готового результата', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    new DesktopNotifications(() => {
      throw new Error('Проект перемещён');
    }).show(notice);
    expect(() => native.instances[0].emit('click')).not.toThrow();
    expect(warning).toHaveBeenCalledOnce();
  });
});
