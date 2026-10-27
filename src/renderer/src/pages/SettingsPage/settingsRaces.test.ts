/** SSR проверяет доступность сохранения до загрузки профилей; настоящие API и эффекты не запускаются. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexCliSettings } from './components/CodexCliSettings';
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
    check: vi.fn(),
    pick: vi.fn()
  });
});

describe('сохранение профиля до загрузки', () => {
  it('блокирует путь и Save до загрузки профиля Codex, не показывая глобальную модель изображений', () => {
    const html = renderToStaticMarkup(createElement(CodexCliSettings));
    expect(html).toContain('Загрузка пути Codex CLI');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>)[\s\S])*Сохранить путь Codex CLI<\/button>/);
    expect(html).toMatch(/<input[^>]*disabled/);
    expect(html).toContain('Путь к Codex CLI для изображений');
    expect(html).toContain('Пусто — автоматический поиск. Модель выбирается в настройках проекта.');
    expect(html).not.toContain('Модель Codex для опор');
    expect(html).not.toContain('Codex для опорных изображений');
    expect(html).not.toContain('MuiPaper-root');
  });

  it('блокирует Save текстового провайдера до ответа getProviderSettings', () => {
    vi.mocked(useAgentSettings).mockReturnValue({ ...vi.mocked(useAgentSettings)(), profileLoading: true });
    const html = renderToStaticMarkup(createElement(SettingsPage));
    expect(html).toContain('Загрузка профиля CLI');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>)[\s\S])*Сохранить настройки агента<\/button>/);
  });

  it('не разрешает затереть профиль после ошибки его загрузки', () => {
    vi.mocked(useAgentSettings).mockReturnValue({ ...vi.mocked(useAgentSettings)(), profileError: 'Профиль не прочитан' });
    const html = renderToStaticMarkup(createElement(SettingsPage));
    expect(html).toContain('Профиль не прочитан');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>)[\s\S])*Сохранить настройки агента<\/button>/);
  });
});

describe('Путь Codex показывается только выбранному Codex', () => {
  it.each([null, { provider: 'claude' as const }])('не монтирует настройки изображений при выборе %s', (settings) => {
    vi.mocked(useAgentSettings).mockReturnValue({ ...vi.mocked(useAgentSettings)(), settings });
    const html = renderToStaticMarkup(createElement(SettingsPage));
    expect(html).not.toContain('Путь к Codex CLI для изображений');
    expect(html).not.toContain('Загрузка пути Codex CLI');
    expect(html).not.toContain('Сохранить путь Codex CLI');
  });

  it('показывает отдельный путь изображений после явного выбора Codex и загрузки профиля', () => {
    const html = renderToStaticMarkup(createElement(SettingsPage));
    expect(html).toContain('Путь к Codex CLI для изображений');
  });

  it.each([{ profileLoading: true }, { profileError: 'Ошибка профиля' }])('не монтирует профиль изображений пока текстовый профиль не готов: %s', (state) => {
    vi.mocked(useAgentSettings).mockReturnValue({ ...vi.mocked(useAgentSettings)(), ...state });
    expect(renderToStaticMarkup(createElement(SettingsPage))).not.toContain('Путь к Codex CLI для изображений');
  });
});
