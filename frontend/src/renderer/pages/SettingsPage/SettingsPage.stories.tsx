/** Настройки Go-версии: переход к компонентам доступен, пока методы агентов и обновлений не перенесены. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { componentTexts } from '@shared/texts/component-manager';
import { migrationTexts } from '@shared/texts/migration';
import { updatesTexts } from '@shared/texts/updates';
import { SettingsPage } from './SettingsPage';

const meta = {
  title: 'Страницы/Настройки',
  component: SettingsPage,
  tags: ['ci'],
  parameters: { songframe: { shell: 'page', route: '/settings', unavailable: ['agents.getSettings', 'updates.view'] } }
} satisfies Meta<typeof SettingsPage>;
export default meta;
type Story = StoryObj<typeof meta>;

export const NotMigrated: Story = {
  name: 'Агент и обновления не перенесены · переход к компонентам',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(migrationTexts.agentSection)).toBeVisible();
    await expect(canvas.getByText(updatesTexts.title)).toBeVisible();
    await expect(canvas.getAllByText(migrationTexts.notMigratedTitle)).toHaveLength(2);
    await userEvent.click(canvas.getByRole('link', { name: componentTexts.open }));
    await expect(canvas.getByTestId('story-route')).toHaveTextContent('/components');
  }
};
