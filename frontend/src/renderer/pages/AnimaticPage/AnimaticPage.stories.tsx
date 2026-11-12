/** Настоящая страница аниматика на локальной модели Go-сервиса: сборка, просмотр планов и принятие. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { animaticTexts } from '@shared/texts/animatic';
import { commonTexts } from '@shared/texts/common';
import { notificationsTexts } from '@shared/texts/notifications';
import {
  ANIMATIC_BLOCKED_REASON,
  ANIMATIC_JOB_ERROR,
  ANIMATIC_PAGE_PROJECT,
  ANIMATIC_STALE_PROBLEMS,
  animaticPageInspection,
  animaticPageOptions
} from '../../testing/animaticPageStories';
import { AnimaticPage } from './AnimaticPage';

const meta = {
  title: 'Страницы/Аниматик',
  component: AnimaticPage,
  tags: ['!autodocs'],
  parameters: { songframe: animaticPageOptions(), controls: { disable: true } }
} satisfies Meta<typeof AnimaticPage>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Опрос заданий страницы идёт раз в две секунды: итог появляется после второго опроса. */
const JOB_TIMEOUT = { timeout: 6000 };

function body(canvasElement: HTMLElement): ReturnType<typeof within> {
  return within(canvasElement.ownerDocument.body);
}

/** Подтверждает открытый ConfirmationDialog кнопкой с данной подписью. */
async function confirmDialog(canvasElement: HTMLElement, title: string, confirm: string): Promise<void> {
  const screen = body(canvasElement);
  const dialog = await screen.findByRole('dialog', { name: title });
  await waitFor(() => expect(dialog).toBeVisible());
  await userEvent.click(within(dialog).getByRole('button', { name: confirm }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
}

export const NotBuilt: Story = {
  name: 'Нет сборки · проверка входов и сборка заданием',
  tags: ['ci'],
  parameters: { songframe: animaticPageOptions({ state: 'none' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = body(canvasElement);
    await canvas.findByText(animaticTexts.header.notBuilt);
    // Без сборки нет плеера, принятия и глав; доступны проверка входов и первая сборка.
    await expect(canvasElement.querySelector('video')).toBeNull();
    await expect(canvas.queryByText(animaticTexts.acceptance.title)).toBeNull();
    await expect(canvas.queryByRole('button', { name: commonTexts.rebuild })).toBeNull();
    // Кнопки перерисовываются при смене состояния задания: ищем их заново перед каждой проверкой.
    const check = (): HTMLElement => canvas.getByRole('button', { name: commonTexts.check });
    const build = (): HTMLElement => canvas.getByRole('button', { name: commonTexts.build });

    // Проверка входов — задание planOnly: пока оно выполняется, обе команды ждут его завершения.
    await userEvent.click(check());
    await expect(animaticPageInspection().builds).toEqual([true]);
    await waitFor(() => expect(build()).toBeDisabled());
    await expect(build()).toHaveAttribute('title', expect.stringContaining(animaticTexts.buildPending));
    await expect(check()).toBeDisabled();
    await screen.findByText(animaticTexts.jobReady({ title: notificationsTexts.animaticCheckTitle }), undefined, JOB_TIMEOUT);
    await waitFor(() => expect(build()).toBeEnabled());
    // Проверка не собирает видео.
    await expect(canvas.getByText(animaticTexts.header.notBuilt)).toBeVisible();

    await userEvent.click(build());
    await expect(animaticPageInspection().builds).toEqual([true, false]);
    await screen.findByText(animaticTexts.jobReady({ title: animaticTexts.main.buildTitle }), undefined, JOB_TIMEOUT);
    await canvas.findByText(animaticTexts.header.review);
    await expect(canvasElement.querySelector('video')).toBeInTheDocument();
    await expect(canvas.getByText(animaticTexts.acceptance.reviewInstruction)).toBeVisible();
    await expect(canvas.getByRole('button', { name: commonTexts.rebuild })).toBeEnabled();
    await expect(canvas.getByText(animaticTexts.chapters)).toBeVisible();
  }
};

export const FreshReview: Story = {
  name: 'Свежая сборка · плеер, главы и карточка плана',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(animaticTexts.header.review);
    const video = canvasElement.querySelector('video');
    await expect(video).toBeInTheDocument();
    await expect(video).toHaveAttribute('src', expect.stringContaining('media/story-video.mp4?v='));
    await waitFor(() => expect(video?.duration).toBe(8));
    // До запуска и выбора карточка подсказывает, как выбрать план, хотя первый план начинается с 0.
    await expect(canvas.getByText(animaticTexts.chooseShot)).toBeVisible();
    await expect(canvas.queryByText(animaticTexts.shot.speech)).toBeNull();
    // Главы — кнопки: план выбирается с клавиатуры, текущая глава отмечена aria-current.
    const first = canvas.getByRole('button', { name: /^M01/ });
    first.focus();
    await userEvent.keyboard('{Enter}');
    await expect(canvas.getByText(animaticTexts.shot.speech)).toBeVisible();
    await expect(canvas.getByText('Средний план, медленный наезд.')).toBeVisible();
    await waitFor(() => expect(canvas.getByRole('button', { name: /^M01/ })).toHaveAttribute('aria-current', 'true'));
    await userEvent.keyboard('{Tab}');
    await expect(canvas.getByRole('button', { name: /^M02/ })).toHaveFocus();

    // Глава переводит плеер на начало плана и показывает его карточку с опорами и постановкой;
    // переход роутера идёт в transition и может отстать от перемотки, поэтому адрес ждём.
    await userEvent.click(canvas.getByText('Грядки на рассвете', { selector: 'p, span' }));
    await waitFor(() => expect(video?.currentTime).toBeCloseTo(3, 1));
    await canvas.findByRole('img', { name: 'M02' });
    await expect(canvas.getByRole('img', { name: animaticTexts.shot.lastCard({ shot: 'M02' }) })).toBeVisible();
    await expect(canvas.getByText(animaticTexts.shot.sequence({ title: 'Двор' }))).toBeVisible();
    await expect(canvas.getByText('Туман сходит с грядок.')).toBeVisible();
    await waitFor(() => expect(canvas.getByTestId('story-route')).toHaveTextContent('/project/animatic?shot=M02'));

    // Карточка без анимации показывает подписи отсутствующей постановки.
    await userEvent.click(canvas.getByText('Пугало машет рукавом', { selector: 'p, span' }));
    await canvas.findByRole('img', { name: 'M03' });
    await expect(canvas.getByText(commonTexts.staging.cameraMissing)).toBeVisible();
    await waitFor(() => expect(canvas.getByTestId('story-route')).toHaveTextContent('/project/animatic?shot=M03'));

    await userEvent.click(canvas.getByRole('button', { name: commonTexts.openFolder }));
    await expect(animaticPageInspection().openedPaths).toEqual([`${ANIMATIC_PAGE_PROJECT}/plan/animatic/latest`]);
  }
};

export const AcceptAndReturn: Story = {
  name: 'Принятие · подтверждение и возврат на просмотр',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = body(canvasElement);
    await canvas.findByText(animaticTexts.header.review);

    // Отмена подтверждения не меняет статус.
    await userEvent.click(canvas.getByRole('button', { name: animaticTexts.acceptance.approve }));
    await confirmDialog(canvasElement, animaticTexts.confirm.approveTitle, commonTexts.cancel);
    await expect(animaticPageInspection().statuses).toEqual([]);

    await userEvent.click(canvas.getByRole('button', { name: animaticTexts.acceptance.approve }));
    await confirmDialog(canvasElement, animaticTexts.confirm.approveTitle, animaticTexts.acceptance.approve);
    await expect(animaticPageInspection().statuses).toEqual(['approved']);
    await screen.findByText(animaticTexts.approvedNotice);
    await canvas.findByText(animaticTexts.header.accepted);
    await expect(canvas.getByText(animaticTexts.acceptance.accepted)).toBeVisible();

    await userEvent.click(canvas.getByRole('button', { name: animaticTexts.acceptance.returnToReview }));
    await confirmDialog(canvasElement, animaticTexts.confirm.reviewTitle, animaticTexts.confirm.return);
    await expect(animaticPageInspection().statuses).toEqual(['approved', 'review']);
    await screen.findByText(animaticTexts.reviewNotice);
    await canvas.findByText(animaticTexts.header.review);
    await expect(canvas.getByRole('button', { name: animaticTexts.acceptance.approve })).toBeEnabled();
  }
};

export const StaleRebuild: Story = {
  name: 'Устаревшая сборка · проблемы и пересборка',
  tags: ['ci'],
  parameters: { songframe: animaticPageOptions({ state: 'stale' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = body(canvasElement);
    await canvas.findByText(animaticTexts.header.stale);
    for (const problem of ANIMATIC_STALE_PROBLEMS) await expect(canvas.getByText(problem)).toBeVisible();
    // Прежнее принятие не переносится на устаревшую сборку: принять можно только после пересборки.
    await expect(canvas.getByText(animaticTexts.acceptance.scenarioChanged)).toBeVisible();
    const approve = canvas.getByRole('button', { name: animaticTexts.acceptance.approve });
    await expect(approve).toBeDisabled();
    await expect(approve).toHaveAttribute('title', expect.stringContaining(animaticTexts.acceptance.rebuildScenario));

    // Пересборка заменяет текущий результат и поэтому требует подтверждения.
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.rebuild }));
    await confirmDialog(canvasElement, `${commonTexts.rebuild}?`, commonTexts.cancel);
    await expect(animaticPageInspection().builds).toEqual([]);
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.rebuild }));
    await confirmDialog(canvasElement, `${commonTexts.rebuild}?`, commonTexts.rebuild);
    await expect(animaticPageInspection().builds).toEqual([false]);
    await screen.findByText(animaticTexts.jobReady({ title: animaticTexts.main.buildTitle }), undefined, JOB_TIMEOUT);
    await canvas.findByText(animaticTexts.header.review);
    await expect(canvas.queryByText(ANIMATIC_STALE_PROBLEMS[0])).toBeNull();
    await expect(canvas.getByText(animaticTexts.acceptance.reviewInstruction)).toBeVisible();
    await waitFor(() => expect(canvas.getByRole('button', { name: animaticTexts.acceptance.approve })).toBeEnabled());
  }
};

export const BlockedByScenario: Story = {
  name: 'Сценарий не утверждён · сборка и принятие объясняют причину',
  tags: ['ci'],
  parameters: { songframe: animaticPageOptions({ state: 'blocked' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(animaticTexts.header.stale);
    // Причина видна в списке проблем и в подсказках выключенных команд; видео остаётся доступным.
    await expect(canvas.getByRole('alert')).toHaveTextContent(ANIMATIC_BLOCKED_REASON);
    for (const name of [commonTexts.check, commonTexts.rebuild]) {
      const button = canvas.getByRole('button', { name });
      await expect(button).toBeDisabled();
      await expect(button).toHaveAttribute('title', expect.stringContaining(ANIMATIC_BLOCKED_REASON));
    }
    await expect(canvas.getByRole('button', { name: animaticTexts.acceptance.approve })).toBeDisabled();
    await expect(canvasElement.querySelector('video')).toHaveAttribute('controls');
    await expect(animaticPageInspection().builds).toEqual([]);
    await expect(animaticPageInspection().statuses).toEqual([]);
  }
};

export const BuildFailure: Story = {
  name: 'Ошибка сборки · уведомление, прежний результат сохраняется',
  tags: ['ci'],
  parameters: { songframe: animaticPageOptions({ failing: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = body(canvasElement);
    await canvas.findByText(animaticTexts.header.review);
    const src = canvasElement.querySelector('video')?.getAttribute('src');
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.rebuild }));
    await confirmDialog(canvasElement, `${commonTexts.rebuild}?`, commonTexts.rebuild);
    // Пока сборка идёт, рядом с индикатором — переход к её журналу.
    await waitFor(() => expect(canvas.getByRole('link', { name: commonTexts.job.openLog })).toHaveAttribute('href', '/jobs?job=animatic-1'));
    await screen.findByText(animaticTexts.jobFailed({ title: animaticTexts.main.buildTitle }), undefined, JOB_TIMEOUT);
    // После сбоя причина и журнал остаются на странице, а не только в уведомлении.
    const failure = (await canvas.findByText(ANIMATIC_JOB_ERROR, undefined, JOB_TIMEOUT)).closest<HTMLElement>('[role="alert"]')!;
    await expect(failure).toBeVisible();
    await expect(within(failure).getByRole('link', { name: commonTexts.job.openLog })).toHaveAttribute('href', '/jobs?job=animatic-1');
    // Неудачное задание не заменяет latest: видео и решение о приёмке остаются прежними.
    await expect(canvasElement.querySelector('video')).toHaveAttribute('src', src);
    await waitFor(() => expect(canvas.getByRole('button', { name: commonTexts.rebuild })).toBeEnabled());
    await expect(canvas.getByRole('button', { name: animaticTexts.acceptance.approve })).toBeEnabled();
  }
};

export const LoadErrorRetry: Story = {
  name: 'Ошибка чтения сборки · повтор',
  tags: ['ci'],
  parameters: { songframe: animaticPageOptions({ loadFailures: 1 }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(animaticTexts.main.manifestCorrupt);
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.retry }));
    await canvas.findByText(animaticTexts.header.review);
    await expect(canvas.queryByText(animaticTexts.main.manifestCorrupt)).toBeNull();
  }
};
