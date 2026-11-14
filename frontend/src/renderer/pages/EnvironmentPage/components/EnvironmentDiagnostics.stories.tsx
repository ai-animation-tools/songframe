/** Сводка использует настоящую классификацию ресурсов, ошибок и необязательных зависимостей. */
import { environmentTexts } from '@shared/texts/environment';
import { providerTexts } from '@shared/texts/providers';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { EnvironmentDiagnostics } from './EnvironmentDiagnostics';
import { EnvironmentDiagnosticsStory, environmentCheck, environmentChecks } from '../../../testing/environmentStories';

const meta: Meta<typeof EnvironmentDiagnostics> = {
  title: 'Среда/Диагностика',
  component: EnvironmentDiagnostics,
  tags: ['!autodocs'],
  args: { checks: null, loading: false, error: null }
};
export default meta;
type Story = StoryObj<typeof meta>;

export const NotChecked: Story = { name: 'Проверка ещё не выполнялась' };
export const Loading: Story = { name: 'Первичная проверка · результатов пока нет', args: { loading: true } };
export const Empty: Story = { name: 'Проверка вернула пустой список', args: { checks: [] } };
export const InitialError: Story = { name: 'Ошибка до получения результатов', args: { error: 'Не удалось запустить демонстрационную проверку' } };
export const OptionalMissing: Story = {
  // «—» остаётся только у необязательного Git LFS; Git найден.
  name: 'Ресурсы доступны · Git LFS не установлен',
  args: { checks: environmentChecks() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent('Ресурсы и библиотеки приложения доступны.');
    await expect(canvas.getAllByText('—')).toHaveLength(1);
    await expect(canvas.getByText('Внешние программы — по необходимости')).toBeVisible();
    await expect(canvas.getByText('Git LFS')).toBeVisible();
    await expect(canvas.getByText(environmentTexts.gitLfsMissing)).toBeVisible();
    await expect(canvas.getByText('git version 2.43.0')).toBeVisible();
  }
};
export const GitMissing: Story = {
  // Без Git недоступен и Git LFS: обе необязательные строки нейтральные, итог основных ресурсов прежний.
  name: 'Ресурсы доступны · Git и Git LFS не установлены',
  args: {
    checks: environmentChecks().map((check) =>
      check.id === 'git' || check.id === 'git-lfs' ? { ...check, ok: false, detail: 'Команда не найдена: git' } : check
    )
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent('Ресурсы и библиотеки приложения доступны.');
    await expect(canvas.getAllByText('—')).toHaveLength(2);
    await expect(canvas.getAllByText('Команда не найдена: git')).toHaveLength(2);
  }
};
export const CoreFailure: Story = {
  name: 'Отсутствует обязательный ресурс',
  args: { checks: environmentChecks().map((check) => (check.id === 'story-provider-client' ? { ...check, ok: false, detail: 'Клиент не найден.' } : check)) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent('Без этого приложение работает не полностью: Клиент провайдера изображений.');
    await expect(canvas.queryByText('Ресурсы и библиотеки приложения доступны.')).not.toBeInTheDocument();
  }
};
export const ProductionFailure: Story = {
  name: 'Просмотр работает · производство требует зависимости',
  args: { checks: environmentChecks().map((check) => (check.id === 'ffmpeg' ? { ...check, ok: false, detail: 'FFmpeg не найден.' } : check)) },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('alert')).toHaveTextContent(
      'Просмотр и редактирование работают. Не найдены локальные зависимости: Встроенный FFmpeg.'
    );
  }
};
export const PartialProgress: Story = {
  name: 'Постепенные результаты · общее ожидание продолжается',
  args: {
    loading: true,
    checks: [
      environmentCheck(),
      environmentCheck({ id: 'ffmpeg', label: 'FFmpeg', ok: false, status: 'running' }),
      ...environmentChecks()
        .slice(2)
        .map((check) => ({ ...check, status: 'pending' as const }))
    ]
  }
};
export const Interrupted: Story = {
  name: 'Проверка прервана · готовые результаты сохранены',
  args: { checks: [environmentCheck()], error: 'Демонстрационный worker завершился без ответа' }
};
export const RunAndFinish: Story = {
  name: 'Проверить → ожидание → результат',
  render: () => <EnvironmentDiagnosticsStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Проверка среды ещё не выполнена.')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Проверить' }));
    await expect(canvas.getByRole('button', { name: 'Проверка' })).toBeDisabled();
    await canvas.findByRole('progressbar', { name: 'Клиент провайдера изображений: выполняется проверка' });
    await canvas.findByText('Ресурсы и библиотеки приложения доступны.');
    await expect(canvas.getByRole('button', { name: 'Проверить' })).toBeEnabled();
    await expect(canvas.queryByRole('progressbar')).not.toBeInTheDocument();
  }
};
export const FailureAndRetry: Story = {
  name: 'Обрыв → последние результаты → успешный повтор',
  render: () => <EnvironmentDiagnosticsStory failFirst />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Проверить' }));
    await canvas.findByText('Не удалось завершить проверку: Демонстрационный worker завершился без ответа. Показаны последние доступные результаты.');
    await expect(canvas.getByText(providerTexts.bundledClient)).toBeVisible();
    await expect(canvas.queryByRole('progressbar')).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Проверить' }));
    await canvas.findByText('Ресурсы и библиотеки приложения доступны.');
    await waitFor(() => expect(canvas.getAllByRole('alert')).toHaveLength(1));
    await expect(canvas.getByRole('button', { name: 'Проверить' })).toBeEnabled();
  }
};
