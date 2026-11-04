/**
 * Настройки Go-версии: блок агента работает на локальной модели agents (этап 44), обновления ещё не
 * перенесены, переход к компонентам доступен всегда.
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
import { SETTINGS_STORY_EMAIL, settingsStoryApi } from '../../testing/settingsStories';
import { SettingsPage } from './SettingsPage';

const meta = {
  title: 'Страницы/Настройки',
  component: SettingsPage,
  tags: ['ci'],
  parameters: { songframe: { shell: 'page', route: '/settings', unavailable: ['updates.view'] } }
} satisfies Meta<typeof SettingsPage>;
export default meta;
type Story = StoryObj<typeof meta>;

const codex = AGENT_PROVIDERS.codex.title;
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
      unavailable: ['updates.view'],
      createApi: () =>
        settingsStoryApi({
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
    // Только обновления остаются не перенесёнными.
    await expect(canvas.getAllByText(migrationTexts.notMigratedTitle)).toHaveLength(1);
    await expect(canvas.getByText(updatesTexts.title)).toBeVisible();

    await userEvent.click(canvas.getByRole('button', { name: new RegExp(commonTexts.check) }));
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
      unavailable: ['updates.view'],
      createApi: () => settingsStoryApi({ agent: null, missing: ['claude'], unauthenticated: ['codex'] })
    }
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByRole('radio', { name: settingsTexts.withoutAgent })).toBeChecked());
    await waitFor(async () => expect(await agentRadio(canvasElement, claude)).toBeDisabled());
    await expect(canvas.getByText(settingsTexts.missingAgent)).toBeVisible();
    // Без выбранного агента проверку запустить нельзя, а модель не показывается.
    await expect(canvas.getByRole('button', { name: new RegExp(commonTexts.check) })).toBeDisabled();
    await expect(canvas.queryByRole('combobox', { name: commonTexts.model })).not.toBeInTheDocument();

    // Найденный агент без входа: проверка и панель аккаунта показывают отсутствие входа.
    await userEvent.click(await agentRadio(canvasElement, codex));
    await userEvent.click(canvas.getByRole('button', { name: new RegExp(commonTexts.check) }));
    await expect(await canvas.findByText(settingsTexts.authorization(settingsTexts.unauthenticated))).toBeVisible();
  }
};

export const AgentNotMigrated: Story = {
  name: 'Методы агентов недоступны · блок агента показывает причину',
  parameters: { songframe: { shell: 'page', route: '/settings', unavailable: ['agents.getSettings', 'updates.view'] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(migrationTexts.agentSection)).toBeVisible();
    await expect(canvas.getAllByText(migrationTexts.notMigratedTitle)).toHaveLength(2);
  }
};
