/** Настоящая страница проверок: проверки проекта и проба стыков на локальной модели сервиса. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { checksTexts } from '@shared/texts/checks';
import { commonTexts } from '@shared/texts/common';
import { navigationTexts } from '@shared/texts/navigation';
import { ANCHORS } from '../../components/linkTargets';
import { checksPageInspection, checksPageOptions, checksPageReview } from '../../testing/checksPageStories';
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

/** Блок пробы стыков: его кнопки «Проверить»/«Собрать» ищутся только внутри него. */
async function reviewPanel(canvasElement: HTMLElement): Promise<HTMLElement> {
  await within(canvasElement).findByText(navigationTexts.blocks.checksReview);
  const panel = canvasElement.querySelector<HTMLElement>(`[data-anchor="${ANCHORS.checksReview}"]`);
  if (!panel) throw new Error('Нет блока пробы стыков');
  return panel;
}

/** Shift + Enter на плане добавляет диапазон от начала выбора (клавиатурный путь щелчка с Shift). */
async function shiftSelect(element: HTMLElement): Promise<void> {
  element.focus();
  await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
}

export const RunAllChecks: Story = {
  name: 'Все проверки · пять шагов',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(checksTexts.sceneDataLabel);
    // У «Карточек и списков» кнопки доступны, как у остальных проверок.
    const views = row(canvasElement, checksTexts.viewsLabel);
    await expect(within(views).getByRole('button', { name: commonTexts.run })).toBeEnabled();
    await expect(within(views).getByRole('button', { name: checksTexts.rebuildViews })).toBeEnabled();
    // Рядом с проверками доступна форма пробы стыков и список собранных проб.
    const review = await reviewPanel(canvasElement);
    await within(review).findByText(checksTexts.savedReviews);
    await expect(within(review).getByRole('button', { name: commonTexts.build })).toBeDisabled();

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

export const ReviewBuild: Story = {
  name: 'Проба стыков · выбор планов подряд и сборка',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const review = await reviewPanel(canvasElement);
    const panel = within(review);
    const build = (): HTMLElement => panel.getByRole('button', { name: commonTexts.build });
    await panel.findByRole('button', { name: 'M01' });
    await expect(build()).toHaveAttribute('title', expect.stringContaining(checksTexts.selectReviewShots));
    // План без принятого видео подписан: в пробе он пойдёт карточкой.
    await expect(panel.getByRole('button', { name: checksTexts.reviewShotLabel({ id: 'M03', missingVideo: true }) })).toBeVisible();

    // Несмежный выбор не отправляется: проба собирается под непрерывный участок песни.
    await userEvent.click(panel.getByRole('button', { name: 'M01' }));
    await userEvent.click(panel.getByRole('button', { name: 'M04' }));
    await expect(build()).toBeDisabled();
    await expect(build()).toHaveAttribute('title', expect.stringContaining(checksTexts.contiguousShotsRequired));
    await userEvent.click(panel.getByRole('button', { name: commonTexts.clearSelection }));

    // Shift добавляет диапазон от первого выбранного плана.
    await userEvent.click(panel.getByRole('button', { name: 'M01' }));
    await shiftSelect(panel.getByRole('button', { name: checksTexts.reviewShotLabel({ id: 'M03', missingVideo: true }) }));
    for (const id of ['M01', 'M02']) await expect(panel.getByRole('button', { name: id })).toHaveAttribute('aria-pressed', 'true');
    await expect(panel.getByRole('button', { name: 'M04' })).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(build());
    await expect(checksPageInspection().reviews).toEqual([{ shots: ['M01', 'M02', 'M03'], planOnly: false }]);
    // Пока задание идёт, повторная сборка и проверки ждут его.
    await waitFor(() => expect(build()).toBeDisabled());
    await expect(build()).toHaveAttribute('title', expect.stringContaining(checksTexts.jobPending));
    const screen = within(canvasElement.ownerDocument.body);
    const title = checksTexts.reviewJobTitle({ shots: ['M01', 'M02', 'M03'], planOnly: false });
    await screen.findByText(checksTexts.jobsDone([title]), undefined, { timeout: 5000 });
    // Готовая проба появляется в списке plan/batches рядом с прежней.
    await panel.findByText('M01 M02 M03');
    await expect(panel.getByText('M01 M02')).toBeVisible();
    await waitFor(() => expect(build()).toBeEnabled());
  }
};

export const ReviewPlanOnly: Story = {
  name: 'Проба стыков · только проверка без видео',
  tags: ['ci'],
  parameters: { songframe: checksPageOptions({ reviews: [] }) },
  play: async ({ canvasElement }) => {
    const review = await reviewPanel(canvasElement);
    const panel = within(review);
    await userEvent.click(await panel.findByRole('button', { name: 'M02' }));
    await userEvent.click(panel.getByRole('checkbox', { name: checksTexts.reviewPlanOnly }));
    // В режиме проверки кнопка меняет подпись: видео не создаётся.
    await expect(panel.queryByRole('button', { name: commonTexts.build })).toBeNull();
    await userEvent.click(panel.getByRole('button', { name: commonTexts.check }));
    await expect(checksPageInspection().reviews).toEqual([{ shots: ['M02'], planOnly: true }]);
    const screen = within(canvasElement.ownerDocument.body);
    const title = checksTexts.reviewJobTitle({ shots: ['M02'], planOnly: true });
    await screen.findByText(checksTexts.jobsDone([title]), undefined, { timeout: 5000 });
    // Проверка пробы ничего не записывает в plan/batches.
    await expect(panel.queryByText(checksTexts.savedReviews)).toBeNull();
    await expect(checksPageInspection().runs).toEqual([]);
  }
};

export const ReviewWatchAndRemove: Story = {
  name: 'Собранные пробы · просмотр и удаление с подтверждением',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const review = await reviewPanel(canvasElement);
    const panel = within(review);
    await panel.findByText(checksTexts.savedReviews);
    await userEvent.click(panel.getByRole('button', { name: commonTexts.watch }));
    const video = review.querySelector('video');
    await expect(video).toHaveAttribute('src', expect.stringContaining('media/story-video.mp4'));
    await waitFor(() => expect(video?.duration).toBe(8));
    await userEvent.click(panel.getByRole('button', { name: commonTexts.openFolder }));

    const screen = within(canvasElement.ownerDocument.body);
    // Отмена диалога ничего не удаляет.
    await userEvent.click(panel.getByRole('button', { name: checksTexts.deleteReview }));
    let dialog = await screen.findByRole('dialog', { name: `${checksTexts.deleteReview}?` });
    await expect(within(dialog).getByText(checksTexts.deleteReviewDescription('story-video.mp4'))).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: commonTexts.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(checksPageInspection().removedReviews).toEqual([]);

    await userEvent.click(panel.getByRole('button', { name: checksTexts.deleteReview }));
    dialog = await screen.findByRole('dialog', { name: `${checksTexts.deleteReview}?` });
    await userEvent.click(within(dialog).getByRole('button', { name: commonTexts.delete }));
    await screen.findByText(checksTexts.reviewRemoved);
    await expect(checksPageInspection().removedReviews).toEqual([checksPageReview(['M01', 'M02']).video]);
    // Плеер закрыт до удаления, список пуст.
    await waitFor(() => expect(panel.queryByText(checksTexts.savedReviews)).toBeNull());
    await expect(review.querySelector('video')).toBeNull();
  }
};
