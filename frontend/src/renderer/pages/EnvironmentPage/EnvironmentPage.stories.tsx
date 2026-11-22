/** Страница «Окружение» целиком: остаток кредитов провайдера приходит отдельным асинхронным запросом локальной модели API. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { ProviderBalance } from '@shared/types';
import { ENVIRONMENT_STORY_PROVIDER, environmentProviderCheck } from '../../testing/environmentStories';
import type { StoryOptions } from '../../testing/storybook';
import { EnvironmentPage } from './EnvironmentPage';

const meta = { title: 'Страницы/Окружение', component: EnvironmentPage, tags: ['!autodocs'] } satisfies Meta<typeof EnvironmentPage>;
export default meta;
type Story = StoryObj<typeof meta>;

const calls = { balance: 0 };

/**
 * Модель API: вход выполнен сразу (loggedIn) либо после loginProvider; остаток отдаёт balances по очереди
 * вызовов, последнее значение повторяется. Сеть и сервис провайдера не используются.
 */
function environmentPageOptions({ loggedIn, balances }: { loggedIn: boolean; balances: (ProviderBalance | null)[] }): StoryOptions {
  return {
    shell: 'page',
    createApi: () => {
      let authenticated = loggedIn;
      calls.balance = 0;
      return {
        environment: {
          check: async () => [environmentProviderCheck()],
          providerAuth: async () => ({ status: authenticated ? ('authenticated' as const) : ('unauthenticated' as const) }),
          providerBalance: async (provider: string) => {
            if (provider !== ENVIRONMENT_STORY_PROVIDER) return null;
            const value = balances[Math.min(calls.balance, balances.length - 1)] ?? null;
            calls.balance += 1;
            return value;
          },
          loginProvider: async () => {
            authenticated = true;
            return { ok: true, message: 'Вход выполнен.' };
          },
          cancelLogin: async () => undefined
        }
      };
    }
  };
}

const BALANCE_TEXT = /^Остаток: 1\s250 кредитов · запрошен /;

export const BalanceAfterOpen: Story = {
  name: 'Вход выполнен · остаток появляется после открытия',
  tags: ['ci'],
  parameters: { songframe: environmentPageOptions({ loggedIn: true, balances: [{ credits: 1250, checkedAt: '2026-11-22T10:15:30.000Z' }] }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Вход выполнен.')).toBeVisible();
    await expect(await canvas.findByText(BALANCE_TEXT)).toBeVisible();
    await expect(calls.balance).toBe(1);
  }
};

export const BalanceUnavailable: Story = {
  name: 'Вход выполнен · остаток недоступен без ошибки',
  tags: ['ci'],
  parameters: { songframe: environmentPageOptions({ loggedIn: true, balances: [null] }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Вход выполнен.')).toBeVisible();
    await waitFor(() => expect(calls.balance).toBe(1));
    await expect(canvas.queryByText(/Остаток/)).not.toBeInTheDocument();
    // На странице остаётся сводка диагностики; ни одно предупреждение не говорит об остатке.
    await expect(canvas.queryAllByRole('alert').some((alert) => /остат/i.test(alert.textContent ?? ''))).toBe(false);
  }
};

export const NoBalanceWithoutLogin: Story = {
  name: 'Вход не выполнен · остаток не запрашивается',
  tags: ['ci'],
  parameters: { songframe: environmentPageOptions({ loggedIn: false, balances: [{ credits: 10, checkedAt: '2026-11-22T10:15:30.000Z' }] }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Вход не выполнен.')).toBeVisible();
    await expect(calls.balance).toBe(0);
    await expect(canvas.queryByText(/Остаток/)).not.toBeInTheDocument();
  }
};

export const BalanceAfterLogin: Story = {
  name: 'Вход → остаток запрашивается заново',
  tags: ['ci'],
  parameters: { songframe: environmentPageOptions({ loggedIn: false, balances: [{ credits: 1250, checkedAt: '2026-11-22T10:15:30.000Z' }] }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const login = await canvas.findByRole('button', { name: 'Войти' });
    await waitFor(() => expect(login).toBeEnabled());
    await userEvent.click(login);
    await expect(await canvas.findByText(BALANCE_TEXT)).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Сменить аккаунт' })).toBeEnabled();
  }
};
