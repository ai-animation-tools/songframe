/** Настоящая страница проверок в состоянии Go-версии: перенесённые проверки работают, остальное объясняет причину. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { checksTexts } from '@shared/texts/checks';
import { commonTexts } from '@shared/texts/common';
import { migrationTexts } from '@shared/texts/migration';
import { navigationTexts } from '@shared/texts/navigation';
import { checksPageInspection, checksPageOptions } from '../../testing/checksPageStories';
import { ChecksPage } from './ChecksPage';

const meta = {
  title: 'Страницы/Проверки',
  component: ChecksPage,
  tags: ['!autodocs'],
  parameters: { songframe: checksPageOptions(), controls: { disable: true } }
} satisfies Meta<typeof ChecksPage>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Строка проверки по её подписи. */
function row(canvasElement: HTMLElement, label: string): HTMLElement {
  const title = within(canvasElement).getByText(label, { selector: 'p, span' });
  const element = title.closest<HTMLElement>('div')?.parentElement;
  if (!element) throw new Error(`Нет строки проверки ${label}`);
  return element;
}

export const RunAllChecks: Story = {
  name: 'Все проверки · пять шагов',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(checksTexts.sceneDataLabel);
    // «Карточки и списки» перенесена: её кнопки доступны, как у остальных проверок.
    const views = row(canvasElement, checksTexts.viewsLabel);
    await expect(within(views).getByRole('button', { name: commonTexts.run })).toBeEnabled();
    await expect(within(views).getByRole('button', { name: checksTexts.rebuildViews })).toBeEnabled();
    // Проба стыков ещё не перенесена: блок показывает общий отказ вместо формы.
    await expect(canvas.getByText(navigationTexts.blocks.checksReview)).toBeVisible();
    await expect(canvas.getByText(migrationTexts.notMigratedTitle)).toBeVisible();

    await userEvent.click(canvas.getByRole('checkbox', { name: checksTexts.strictMode }));
    await userEvent.click(canvas.getByRole('button', { name: checksTexts.runAll }));
    await expect(checksPageInspection().runAll).toEqual([{ strict: true, next: false }]);
    const screen = within(canvasElement.ownerDocument.body);
    await screen.findByText(checksTexts.jobsDone([checksTexts.allChecksJobTitle]), undefined, { timeout: 5000 });
    for (const label of [checksTexts.sceneDataLabel, checksTexts.viewsLabel, checksTexts.assetsLabel, checksTexts.workspaceLabel, checksTexts.statusLabel]) {
      await waitFor(() => expect(within(row(canvasElement, label)).getByText(checksTexts.checkDone)).toBeVisible());
    }
  }
};

export const RebuildViews: Story = {
  name: 'Карточки и списки · пересборка',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(checksTexts.viewsLabel);
    const views = row(canvasElement, checksTexts.viewsLabel);
    await userEvent.click(within(views).getByRole('button', { name: checksTexts.rebuildViews }));
    await expect(checksPageInspection().updateViews).toBe(1);
    await expect(checksPageInspection().runs).toEqual([]);
    const screen = within(canvasElement.ownerDocument.body);
    await screen.findByText(checksTexts.jobsDone([checksTexts.updateViewsJobTitle]), undefined, { timeout: 5000 });
    await waitFor(() => expect(within(views).getByText(checksTexts.checkDone)).toBeVisible());
    // Другие строки не получают итог пересборки.
    await expect(within(row(canvasElement, checksTexts.sceneDataLabel)).queryByText(checksTexts.checkDone)).toBeNull();
  }
};

export const SingleCheckFailure: Story = {
  name: 'Отдельная проверка · отказ инструмента',
  tags: ['ci'],
  parameters: { songframe: checksPageOptions({ failing: ['status'] }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(checksTexts.statusLabel);
    const status = row(canvasElement, checksTexts.statusLabel);
    await userEvent.click(within(status).getByRole('checkbox', { name: checksTexts.nextShotAndQueue }));
    await userEvent.click(within(status).getByRole('button', { name: commonTexts.run }));
    await expect(checksPageInspection().runs).toEqual([{ id: 'status', options: { next: true } }]);
    const screen = within(canvasElement.ownerDocument.body);
    await screen.findByText(checksTexts.jobsFailed([checksTexts.checkJobTitle(checksTexts.statusLabel)]), undefined, { timeout: 5000 });
    await waitFor(() => expect(within(status).getByText('1')).toBeVisible());
    // Другие проверки не запускались и итога не показывают.
    await expect(within(row(canvasElement, checksTexts.sceneDataLabel)).queryByText(checksTexts.checkDone)).toBeNull();
  }
};

export const NoShotsYet: Story = {
  name: 'Сценарий без планов · проверки ждут реестр',
  tags: ['ci'],
  parameters: { songframe: checksPageOptions({ noShots: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(checksTexts.sceneDataLabel);
    // Готовность реестра берётся из сводки производства: без планов проверки не запускаются.
    const runAll = canvas.getByRole('button', { name: checksTexts.runAll });
    await waitFor(() => expect(runAll).toBeDisabled());
    await expect(runAll).toHaveAttribute('title', expect.stringContaining(checksTexts.scenesRequired));
    await expect(within(row(canvasElement, checksTexts.statusLabel)).getByRole('button', { name: commonTexts.run })).toBeDisabled();
  }
};
