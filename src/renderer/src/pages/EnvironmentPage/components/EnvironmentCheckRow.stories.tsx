/** Строка показывает проверки и управляемый вход без открытия браузера или вызова провайдера. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { List } from '@mui/material';
import { EnvironmentCheckRow } from './EnvironmentCheckRow';
import { ENVIRONMENT_STORY_LOGIN_URL, ENVIRONMENT_STORY_LONG_PATH, EnvironmentProviderStory, environmentCheck } from '../../../testing/environmentStories';

const meta: Meta<typeof EnvironmentCheckRow> = {
  title: 'Среда/Строка проверки',
  component: EnvironmentCheckRow,
  tags: ['!autodocs'],
  args: { category: 'core', check: environmentCheck() },
  render: (args) => (
    <List disablePadding>
      <EnvironmentCheckRow {...args} />
    </List>
  )
};
export default meta;
type Story = StoryObj<typeof meta>;

export const Pending: Story = { name: 'Ожидает проверки', args: { check: environmentCheck({ ok: false, status: 'pending' }) } };
export const Running: Story = {
  name: 'Проверка выполняется',
  args: { check: environmentCheck({ ok: false, status: 'running' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('progressbar', { name: 'Встроенный Python: выполняется проверка' })).toBeVisible();
    await expect(canvas.getByText('Проверка выполняется')).toBeVisible();
    await expect(canvas.queryByText('Python 3.11.9 · resources/runtime/python')).not.toBeInTheDocument();
  }
};
export const Success: Story = { name: 'Доступен · время проверки' };
export const MissingCore: Story = {
  name: 'Не найден обязательный ресурс',
  args: { check: environmentCheck({ ok: false, detail: 'Встроенный Python недоступен: исполняемый файл отсутствует.' }) }
};
export const MissingProduction: Story = {
  name: 'Не найдена зависимость производства',
  args: { check: environmentCheck({ id: 'ffmpeg', label: 'Встроенный FFmpeg', ok: false, productionOnly: true, detail: 'FFmpeg не найден в поставке.' }) }
};
export const OptionalNeutral: Story = {
  name: 'Необязательная программа · нейтральное состояние',
  args: {
    category: 'external',
    check: environmentCheck({
      id: 'git',
      label: 'Git',
      ok: false,
      bundled: false,
      external: true,
      productionOnly: true,
      detail: 'Git не установлен.',
      hint: 'Установите Git, если хотите вести историю версий клипа.'
    })
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('—')).toBeVisible();
    await expect(canvas.getByText('Git не установлен.')).toBeVisible();
    await expect(canvas.queryByRole('progressbar')).not.toBeInTheDocument();
  }
};
export const LongPath: Story = {
  name: 'Длинный путь Windows · кириллица и пробелы',
  args: {
    category: 'model',
    check: environmentCheck({
      id: 'whisper-model',
      label: 'Локальная модель faster-whisper large-v3 для точной разметки русской песни',
      bundled: false,
      productionOnly: true,
      detail: ENVIRONMENT_STORY_LONG_PATH
    })
  }
};
export const CheckingAuth: Story = {
  name: 'Проверяется вход · действие недоступно',
  render: () => <EnvironmentProviderStory initialStatus="checking" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const button = canvas.getByRole('button', { name: 'Проверка входа' });
    await expect(button).toBeDisabled();
    await userEvent.hover(button.parentElement!);
    const tooltip = await within(canvasElement.ownerDocument.body).findByRole('tooltip');
    await expect(tooltip).toHaveTextContent('Дождитесь окончания проверки входа.');
  }
};
export const WaitingLogin: Story = {
  name: 'Ожидание входа · ссылка и отмена',
  render: () => <EnvironmentProviderStory initialWaiting />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const link = canvas.getByRole('link', { name: 'откройте страницу входа' });
    await expect(link).toHaveAttribute('href', ENVIRONMENT_STORY_LOGIN_URL);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noreferrer');
    await userEvent.click(canvas.getByRole('button', { name: 'Отменить вход' }));
    await expect(canvas.queryByRole('link')).not.toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: 'Войти' })).toBeEnabled();
    await expect(canvas.getByText('Вход отменён. Демонстрационный аккаунт не подключён.')).toBeVisible();
  }
};
export const LoginAndCancel: Story = {
  name: 'Начать вход → отменить → повторить → подтвердить',
  render: () => <EnvironmentProviderStory allowCompletion />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Войти' }));
    await expect(canvas.getByRole('link', { name: 'откройте страницу входа' })).toHaveAttribute('href', ENVIRONMENT_STORY_LOGIN_URL);
    await userEvent.click(canvas.getByRole('button', { name: 'Отменить вход' }));
    await expect(canvas.queryByRole('link')).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Войти' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Подтвердить вход в модели' }));
    await expect(canvas.getByText('Вход выполнен.')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Сменить аккаунт' })).toBeEnabled();
    await expect(canvas.queryByRole('link')).not.toBeInTheDocument();
    await expect(canvas.queryByRole('button', { name: 'Отменить вход' })).not.toBeInTheDocument();
  }
};
export const CheckRetry: Story = {
  name: 'Проверить вход → ошибка → повтор → аккаунт доступен',
  render: () => <EnvironmentProviderStory initialStatus="unknown" failCheckOnce />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Проверить вход' }));
    await expect(canvas.getByRole('button', { name: 'Проверка входа' })).toBeDisabled();
    await canvas.findByText('Не удалось проверить вход: демонстрационный ответ недоступен. Повторите проверку.');
    await userEvent.click(canvas.getByRole('button', { name: 'Проверить вход' }));
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Сменить аккаунт' })).toBeEnabled());
    await expect(canvas.getByText('Вход выполнен.')).toBeVisible();
  }
};
export const Offline: Story = {
  name: 'Нет сети · вход недоступен с объяснением',
  render: () => <EnvironmentProviderStory offline />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const button = canvas.getByRole('button', { name: 'Войти' });
    await expect(button).toBeDisabled();
    const wrapper = button.parentElement!;
    wrapper.focus();
    await expect(wrapper).toHaveFocus();
    const tooltip = await within(canvasElement.ownerDocument.body).findByRole('tooltip');
    await expect(tooltip).toHaveTextContent('Нет подключения к сети');
    await expect(canvas.queryByRole('link')).not.toBeInTheDocument();
  }
};
export const CheckPendingLoginBlocked: Story = {
  name: 'Среда ещё не проверена · вход недоступен',
  render: () => <EnvironmentProviderStory checkStatus="pending" />,
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: 'Войти' });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('title', 'Дождитесь окончания проверки среды.');
  }
};
export const ClientUnavailable: Story = {
  name: 'Клиент недоступен · вход требует исправления среды',
  render: () => <EnvironmentProviderStory checkOk={false} />,
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: 'Войти' });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('title', 'Сначала устраните проблему, указанную в этой строке, и повторите проверку.');
  }
};
