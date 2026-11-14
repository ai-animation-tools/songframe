/** Блок истории проекта: статус несохранённого, сохранение точки, сравнение и возврат раздела. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { navigationTexts } from '@shared/texts/navigation';
import { projectTexts } from '@shared/texts/project';
import type { StoryOptions } from '../../../testing/storybook';
import { historyApi, type HistoryModelOptions } from '../../../testing/projectHistoryStories';
import { ProjectHistoryCard } from './ProjectHistoryCard';

const texts = projectTexts.history;
const PROJECT = '/mock/history-project';

const historyOptions = (options: HistoryModelOptions = {}): StoryOptions => ({ createApi: () => ({ projectHistory: historyApi(options) }) });

const meta = {
  title: 'Проект/История проекта',
  component: ProjectHistoryCard,
  tags: ['!autodocs'],
  args: { project: PROJECT, version: 1 },
  parameters: { controls: { disable: true }, songframe: historyOptions() }
} satisfies Meta<typeof ProjectHistoryCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SavePoint: Story = {
  name: 'Несохранённые изменения · сохранить точку',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    await expect(
      await canvas.findByText(
        texts.unsaved({ sections: `${navigationTexts.pages.timing}, ${navigationTexts.pages.scenario}, ${texts.sections.views}`, files: 5 })
      )
    ).toBeVisible();
    // Разделы — ссылки на свои страницы.
    await expect(canvas.getAllByRole('link', { name: navigationTexts.pages.scenario })[0]).toHaveAttribute('href', '/project/scenario');
    await userEvent.click(canvas.getByRole('button', { name: texts.save }));
    const field = await page.findByRole('textbox', { name: texts.messageLabel });
    // Подпись предложена по изменённым разделам без производных файлов.
    await expect(field).toHaveValue(`${navigationTexts.pages.timing}, ${navigationTexts.pages.scenario}`);
    await userEvent.click(within(page.getByRole('dialog')).getByRole('button', { name: texts.save }));
    await expect(await canvas.findByText(texts.allSaved)).toBeVisible();
    await expect(canvas.getByRole('button', { name: texts.save })).toBeDisabled();
    await expect(canvas.getAllByTestId('project-point')).toHaveLength(4);
  }
};

export const CompareAndRestore: Story = {
  name: 'Точка · сравнить сценарий и вернуть его',
  tags: ['ci'],
  parameters: { songframe: historyOptions({ sections: [], changedFiles: 0 }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    await expect(await canvas.findByText(texts.allSaved)).toBeVisible();
    const [, second] = await canvas.findAllByTestId('project-point');
    await userEvent.click(within(second).getByRole('button', { name: texts.compare }));
    const dialog = within(await page.findByRole('dialog'));
    await expect(await dialog.findByText(texts.compareChanged)).toBeVisible();
    await expect(dialog.getByText(texts.compareProduced)).toBeVisible();
    await expect(dialog.getByText('M07')).toBeVisible();
    await userEvent.click(dialog.getByRole('button', { name: texts.restoreScenario }));
    const confirm = await page.findByRole('dialog', { name: texts.restoreSection({ section: navigationTexts.pages.scenario }) });
    await expect(within(confirm).getByText(texts.restoreScenarioNote)).toBeVisible();
    await userEvent.click(within(confirm).getByRole('button', { name: texts.restore }));
    await expect(await canvas.findByText(texts.unsaved({ sections: `${navigationTexts.pages.scenario}, ${texts.sections.views}`, files: 2 }))).toBeVisible();
  }
};

export const RestoreMenu: Story = {
  name: 'Точка · меню возврата раздела',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    const [first] = await canvas.findAllByTestId('project-point');
    await userEvent.click(within(first).getByRole('button', { name: texts.restore }));
    for (const section of [navigationTexts.pages.scenario, navigationTexts.pages.timing, navigationTexts.pages.cast]) {
      await expect(await page.findByRole('menuitem', { name: texts.restoreSection({ section }) })).toBeVisible();
    }
  }
};

export const AutoPointFailed: Story = {
  name: 'Автоматическая точка не создана',
  parameters: {
    songframe: historyOptions({
      autoError: 'Автоматическая точка перед применением сценария не создана: Git не знает автора коммитов.'
    })
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/Git не знает автора коммитов/)).toBeVisible();
  }
};

export const WithoutGit: Story = {
  name: 'Без Git · блока нет',
  tags: ['ci'],
  parameters: { songframe: historyOptions({ available: false }) },
  play: async ({ canvasElement }) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(within(canvasElement).queryByTestId('project-history')).toBeNull();
  }
};
