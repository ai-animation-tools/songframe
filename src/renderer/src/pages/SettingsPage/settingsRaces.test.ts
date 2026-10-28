/** SSR проверяет доступность сохранения до загрузки профилей; настоящие API и эффекты не запускаются. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from './SettingsPage';
import { useAgentSettings } from './useAgentSettings';

vi.mock('../../state', () => ({ useApp: () => ({ notify: vi.fn(), describeError: String, agentProvider: 'codex' }) }));
vi.mock('./useAgentSettings', () => ({ useAgentSettings: vi.fn() }));

beforeEach(() => {
  vi.mocked(useAgentSettings).mockReturnValue({
    settings: { provider: 'codex', model: 'text-model' },
    loading: false,
    profileLoading: false,
    loadError: null,
    profileError: null,
    saving: false,
    checking: false,
    result: null,
    change: vi.fn(),
    save: vi.fn(),
    check: vi.fn()
  });
});

describe('сохранение профиля до загрузки', () => {
  it('блокирует Save текстового провайдера до ответа getProviderSettings', () => {
    vi.mocked(useAgentSettings).mockReturnValue({ ...vi.mocked(useAgentSettings)(), profileLoading: true });
    const html = renderToStaticMarkup(createElement(SettingsPage));
    expect(html).toContain('Загрузка профиля агента');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>)[\s\S])*Сохранить настройки агента<\/button>/);
  });

  it('не разрешает затереть профиль после ошибки его загрузки', () => {
    vi.mocked(useAgentSettings).mockReturnValue({ ...vi.mocked(useAgentSettings)(), profileError: 'Профиль не прочитан' });
    const html = renderToStaticMarkup(createElement(SettingsPage));
    expect(html).toContain('Профиль не прочитан');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>)[\s\S])*Сохранить настройки агента<\/button>/);
  });
});

describe('CLI находится только автоматически', () => {
  it.each([null, { provider: 'claude' as const }, { provider: 'codex' as const, model: 'text-model' }])('не показывает выбор пути к CLI для %s', (settings) => {
    vi.mocked(useAgentSettings).mockReturnValue({ ...vi.mocked(useAgentSettings)(), settings });
    const html = renderToStaticMarkup(createElement(SettingsPage));
    expect(html).not.toContain('Путь к');
    expect(html).not.toContain('Выбрать файл');
    expect(html).not.toContain('Найти автоматически');
  });

  it('показывает сохранённую модель в поле со списком', () => {
    const html = renderToStaticMarkup(createElement(SettingsPage));
    expect(html).toContain('Модель');
    expect(html).toMatch(/<input[^>]*value="text-model"/);
    expect(html).toContain('role="combobox"');
  });
});
