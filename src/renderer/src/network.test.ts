import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { aiActionProblem, type AiAccess } from '@shared/ai-access';
import { OFFLINE_MESSAGE, offlineAccess } from './network';
import { NetworkErrorMessage } from './components/NetworkErrorMessage';

const app = vi.hoisted(() => ({ online: true }));
vi.mock('./state', () => ({ useApp: () => app }));

const ready: AiAccess = {
  agent: { provider: 'claude', selected: true, available: true, message: '' },
  image: { provider: 'codex', selected: true, available: true, message: '' },
  video: { provider: 'kling', selected: true, available: true, message: '' }
};

describe('работа без сети', () => {
  it('блокирует агента и провайдеров медиа одной причиной, сохраняя выбор', () => {
    const access = offlineAccess(ready);
    for (const kind of ['agent', 'image', 'video'] as const) expect(aiActionProblem(access, kind)).toBe(OFFLINE_MESSAGE);
    expect(access.image.provider).toBe('codex');
  });

  it('блокирует и до первой проверки доступности', () => {
    expect(aiActionProblem(offlineAccess(null), 'video')).toBe(OFFLINE_MESSAGE);
  });

  it('показывает сообщение об ошибке с крестиком только без сети', () => {
    app.online = false;
    const html = renderToStaticMarkup(createElement(NetworkErrorMessage));
    expect(html).toContain('Нет подключения к сети');
    expect(html).toContain('MuiAlert-standardError');
    expect(html).toContain('Скрыть сообщение');
    app.online = true;
    expect(renderToStaticMarkup(createElement(NetworkErrorMessage))).toBe('');
  });
});
