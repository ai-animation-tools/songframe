/** SSR проверяет доступность сохранения до загрузки профилей; настоящие API и эффекты не запускаются. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from './SettingsPage';
import { useAgentSettings } from './useAgentSettings';
import { useInstalledAgents } from './useInstalledAgents';

vi.mock('../../state', () => ({ useApp: () => ({ notify: vi.fn(), describeError: String, agentProvider: 'codex' }) }));
vi.mock('./useAgentSettings', () => ({ useAgentSettings: vi.fn() }));
vi.mock('./useInstalledAgents', () => ({ useInstalledAgents: vi.fn() }));

beforeEach(() => {
  vi.mocked(useInstalledAgents).mockReturnValue({ claude: true, codex: true });
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

  it('без агента не показывает поле модели', () => {
    vi.mocked(useAgentSettings).mockReturnValue({ ...vi.mocked(useAgentSettings)(), settings: null });
    const html = renderToStaticMarkup(createElement(SettingsPage));
    expect(html).not.toContain('role="combobox"');
    expect(html).not.toContain('модель по умолчанию');
  });

  it('показывает сохранённую модель в поле со списком', () => {
    const html = renderToStaticMarkup(createElement(SettingsPage));
    expect(html).toContain('Модель');
    expect(html).toMatch(/<input[^>]*value="text-model"/);
    expect(html).toContain('role="combobox"');
  });
});

describe('Выбор только найденных агентов', () => {
  const radioDisabled = (html: string, provider: string): boolean =>
    new RegExp(`<input[^>]*disabled=""[^>]*value="${provider}"|<input[^>]*value="${provider}"[^>]*disabled=""`).test(html);

  it('блокирует ненайденного агента и подписывает причину', () => {
    vi.mocked(useInstalledAgents).mockReturnValue({ claude: false, codex: true });
    const html = renderToStaticMarkup(createElement(SettingsPage));
    expect(radioDisabled(html, 'claude')).toBe(true);
    expect(radioDisabled(html, 'codex')).toBe(false);
    expect(html).toContain('Claude Code не найден на компьютере');
  });

  it('пока идёт проверка, агентов выбрать нельзя, а «Без агента» доступен', () => {
    vi.mocked(useInstalledAgents).mockReturnValue(null);
    const html = renderToStaticMarkup(createElement(SettingsPage));
    expect(radioDisabled(html, 'claude')).toBe(true);
    expect(radioDisabled(html, 'codex')).toBe(true);
    expect(radioDisabled(html, '')).toBe(false);
  });
});
