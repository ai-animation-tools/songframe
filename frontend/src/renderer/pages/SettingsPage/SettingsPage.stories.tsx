/**
 * Настройки: блок агента работает на локальной модели agents (этап 44), обновление приложения —
 * на локальной модели updates (этап 47), переход к компонентам доступен всегда.
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { AGENT_PROVIDERS } from '@shared/agent-providers';
import { commonTexts } from '@shared/texts/common';
import { componentTexts } from '@shared/texts/component-manager';
import { migrationTexts } from '@shared/texts/migration';
import { settingsTexts } from '@shared/texts/settings';
import { technicalTexts } from '@shared/texts/technical';
import { updatesTexts } from '@shared/texts/updates';
import { SETTINGS_STORY_EMAIL, settingsStoryApi, type SettingsStoryModel } from '../../testing/settingsStories';
import { updatesStoryApi, type UpdatesStoryModel, type UpdatesStorySession } from '../../testing/updatesStories';
import { SettingsPage } from './SettingsPage';

const meta = {
  title: 'Страницы/Настройки',
  component: SettingsPage,
  tags: ['ci'],
  parameters: { songframe: { shell: 'page', route: '/settings', createApi: () => updatesStoryApi().api } }
} satisfies Meta<typeof SettingsPage>;
export default meta;
type Story = StoryObj<typeof meta>;

const codex = AGENT_PROVIDERS.codex.title;
const CONFIGURED: SettingsStoryModel = { agent: { provider: 'codex', model: 'gpt-5.5' } };

/** Сессия модели обновлений текущей истории: play читает число вызовов установки. */
let updates: UpdatesStorySession = updatesStoryApi();

function withUpdates(settings: SettingsStoryModel, model: UpdatesStoryModel = {}) {
  return () => {
    updates = updatesStoryApi(model);
    return { ...settingsStoryApi(settings), ...updates.api };
  };
}
const claude = AGENT_PROVIDERS.claude.title;

/** Радиокнопка агента по подписи из реестра, без жёсткого имени в истории. */
function agentRadio(canvasElement: HTMLElement, title: string): Promise<HTMLElement> {
  return within(canvasElement).findByRole('radio', { name: new RegExp(title) });
}

export const Configured: Story = {
  name: 'Агент выбран · проверка, аккаунт, смена профиля и сохранение',
  parameters: {
    songframe: {
      shell: 'page',
      route: '/settings',
      createApi: withUpdates({
        agent: { provider: 'codex', model: 'gpt-5.5' },
        profiles: { codex: { provider: 'codex', model: 'gpt-5.5' }, claude: { provider: 'claude', model: 'opus' } }
      })
    }
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    await waitFor(() => expect(canvas.getByRole('radio', { name: new RegExp(codex) })).toBeChecked());
    await expect(canvas.getByRole('combobox', { name: commonTexts.model })).toHaveValue('gpt-5.5');
    // Аккаунт читается сразу после загрузки профиля: email и предупреждение о почти исчерпанном лимите.
    await expect(await canvas.findByText(SETTINGS_STORY_EMAIL)).toBeVisible();
    await expect(canvas.getByText(settingsTexts.limitAlmostExhausted(technicalTexts.percent('9')))).toBeVisible();
    // Все блоки страницы перенесены, обновление показывает установленную версию.
    await expect(canvas.queryByText(migrationTexts.notMigratedTitle)).not.toBeInTheDocument();
    await expect(await canvas.findByText(updatesTexts.currentVersion({ version: '1.0.0' }))).toBeVisible();

    await userEvent.click(canvas.getByRole('button', { name: new RegExp(`^${commonTexts.check}$`) }));
    await expect(await canvas.findByText(settingsTexts.diagnosticsTitle)).toBeVisible();
    await expect(canvas.getByText(settingsTexts.version('codex-cli 0.160.0'))).toBeVisible();
    await expect(canvas.getByText(settingsTexts.authorization(settingsTexts.authenticated))).toBeVisible();

    // Смена агента читает его собственный профиль, итог прежней проверки сбрасывается.
    await userEvent.click(await agentRadio(canvasElement, claude));
    await waitFor(() => expect(canvas.getByRole('combobox', { name: commonTexts.model })).toHaveValue('opus'));
    await expect(canvas.queryByText(settingsTexts.diagnosticsTitle)).not.toBeInTheDocument();

    await userEvent.click(canvas.getByRole('button', { name: settingsTexts.saveAgent }));
    await expect(await screen.findByText(settingsTexts.saved)).toBeVisible();
    await expect(canvas.getByRole('radio', { name: new RegExp(claude) })).toBeChecked();

    await userEvent.click(canvas.getByRole('link', { name: componentTexts.open }));
    await expect(canvas.getByTestId('story-route')).toHaveTextContent('/components');
  }
};

export const WithoutAgent: Story = {
  name: 'Без агента · ненайденный агент недоступен для выбора',
  parameters: {
    songframe: {
      shell: 'page',
      route: '/settings',
      createApi: withUpdates({ agent: null, missing: ['claude'], unauthenticated: ['codex'] })
    }
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByRole('radio', { name: settingsTexts.withoutAgent })).toBeChecked());
    await waitFor(async () => expect(await agentRadio(canvasElement, claude)).toBeDisabled());
    await expect(canvas.getByText(settingsTexts.missingAgent)).toBeVisible();
    // Без выбранного агента проверку запустить нельзя, а модель не показывается.
    await expect(canvas.getByRole('button', { name: new RegExp(`^${commonTexts.check}$`) })).toBeDisabled();
    await expect(canvas.queryByRole('combobox', { name: commonTexts.model })).not.toBeInTheDocument();

    // Найденный агент без входа: проверка и панель аккаунта показывают отсутствие входа.
    await userEvent.click(await agentRadio(canvasElement, codex));
    await userEvent.click(canvas.getByRole('button', { name: new RegExp(`^${commonTexts.check}$`) }));
    await expect(await canvas.findByText(settingsTexts.authorization(settingsTexts.unauthenticated))).toBeVisible();
  }
};

export const AgentNotMigrated: Story = {
  name: 'Методы агентов недоступны · блок агента показывает причину',
  parameters: { songframe: { shell: 'page', route: '/settings', unavailable: ['agents.getSettings'], createApi: () => updatesStoryApi().api } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(migrationTexts.agentSection)).toBeVisible();
    await expect(canvas.getAllByText(migrationTexts.notMigratedTitle)).toHaveLength(1);
  }
};

export const UpdateInstall: Story = {
  name: 'Обновление · найдена версия, скачивание с прогрессом и установка после подтверждения',
  parameters: { songframe: { shell: 'page', route: '/settings', createApi: withUpdates(CONFIGURED) } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(await canvas.findByRole('button', { name: updatesTexts.check }));
    await expect(await canvas.findByText(updatesTexts.available({ version: '1.1.0' }))).toBeVisible();
    await expect(canvas.getByRole('link', { name: updatesTexts.releaseNotes })).toHaveAttribute(
      'href',
      'https://github.com/ai-animation-tools/songframe/releases/tag/v1.1.0'
    );
    await userEvent.click(canvas.getByRole('button', { name: updatesTexts.download }));
    // Во время скачивания проверка и повторное скачивание недоступны, прогресс виден.
    await expect(await canvas.findByRole('progressbar', { name: updatesTexts.downloading })).toBeVisible();
    await expect(canvas.getByRole('button', { name: updatesTexts.check })).toBeDisabled();
    await expect(await canvas.findByText(updatesTexts.ready({ version: '1.1.0' }), {}, { timeout: 3000 })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: updatesTexts.install }));
    const dialog = within(await screen.findByRole('dialog', { name: updatesTexts.confirmTitle }));
    await expect(dialog.getByText(updatesTexts.confirmText({ version: '1.1.0' }))).toBeVisible();
    await userEvent.click(dialog.getByRole('button', { name: updatesTexts.install }));
    await waitFor(() => expect(updates.installs()).toBe(1));
  }
};

export const UpdateCurrent: Story = {
  name: 'Обновление · установлена последняя версия',
  parameters: { songframe: { shell: 'page', route: '/settings', createApi: withUpdates(CONFIGURED, { latest: '1.0.0' }) } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: updatesTexts.check }));
    await expect(await canvas.findByText(updatesTexts.current)).toBeVisible();
    await expect(canvas.queryByRole('button', { name: updatesTexts.download })).not.toBeInTheDocument();
    await expect(canvas.queryByRole('link', { name: updatesTexts.releaseNotes })).not.toBeInTheDocument();
  }
};

export const UpdatePackage: Story = {
  name: 'Обновление · deb-пакет ставится вручную, кнопка показывает скачанный файл',
  parameters: { songframe: { shell: 'page', route: '/settings', createApi: withUpdates(CONFIGURED, { installable: false, steps: 1 }) } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: updatesTexts.check }));
    await userEvent.click(await canvas.findByRole('button', { name: updatesTexts.download }));
    await expect(await canvas.findByText(`${updatesTexts.ready({ version: '1.1.0' })} ${updatesTexts.readyPackage}`, {}, { timeout: 3000 })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: updatesTexts.install })).not.toBeInTheDocument();
    // Показ файла не закрывает приложение, поэтому подтверждение не нужно.
    await userEvent.click(canvas.getByRole('button', { name: updatesTexts.reveal }));
    await waitFor(() => expect(updates.installs()).toBe(1));
  }
};

export const UpdateCorrupted: Story = {
  name: 'Обновление · пакет не совпал с контрольной суммой, скачивание можно повторить',
  parameters: { songframe: { shell: 'page', route: '/settings', createApi: withUpdates(CONFIGURED, { corrupted: true, steps: 1 }) } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: updatesTexts.check }));
    await userEvent.click(await canvas.findByRole('button', { name: updatesTexts.download }));
    await expect(await canvas.findByText(updatesTexts.hashMismatch, {}, { timeout: 3000 })).toBeVisible();
    await expect(canvas.getByRole('button', { name: updatesTexts.download })).toBeEnabled();
    await expect(canvas.queryByRole('button', { name: updatesTexts.install })).not.toBeInTheDocument();
  }
};
