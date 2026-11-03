/** Общий отказ переходного периода миграции: страница и блок без перенесённых Go-методов. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { Typography } from '@mui/material';
import { migrationTexts } from '@shared/texts/migration';
import { platformTexts } from '@shared/texts/platform';
import { NotMigratedNotice, RequireMigrated } from './NotMigratedNotice';

const meta = {
  title: 'Общие компоненты/Ещё не перенесено в Go',
  component: NotMigratedNotice,
  tags: ['ci'],
  args: { title: 'Тайминги', reason: platformTexts.unavailable, method: 'timing.view' }
} satisfies Meta<typeof NotMigratedNotice>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Page: Story = {
  name: 'Страница · причина и операция',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'Тайминги' })).toBeVisible();
    await expect(canvas.getByText(migrationTexts.notMigratedTitle)).toBeVisible();
    await expect(canvas.getByText(platformTexts.unavailable)).toBeVisible();
    await expect(canvas.getByText(migrationTexts.method('timing.view'))).toBeVisible();
  }
};
export const Section: Story = { name: 'Блок страницы', args: { title: 'Обновления приложения', level: 'section', method: 'updates.view' } };

/** RequireMigrated не монтирует страницу, пока адаптер отмечает её метод чтения недоступным. */
export const Gate: Story = {
  name: 'Шлюз · недоступный метод скрывает содержимое',
  parameters: { songframe: { unavailable: ['timing.view'] } },
  render: () => (
    <RequireMigrated title="Тайминги" methods={['app.state', 'timing.view']}>
      <Typography>Содержимое страницы</Typography>
    </RequireMigrated>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(migrationTexts.method('timing.view'))).toBeVisible();
    await expect(canvas.queryByText('Содержимое страницы')).not.toBeInTheDocument();
  }
};
export const GateOpen: Story = {
  name: 'Шлюз · перенесённые методы показывают страницу',
  render: () => (
    <RequireMigrated title="Тайминги" methods={['app.state', 'timing.view']}>
      <Typography>Содержимое страницы</Typography>
    </RequireMigrated>
  ),
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText('Содержимое страницы')).toBeVisible();
  }
};
