/** Опоры и их решения используют одну локальную модель: изменение видно сразу в соседнем блоке. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { KeyframeReviewStory, keyframePackage } from '../../../testing/keyframeStories';
import { STORY_IMAGE_PATH } from '../../../testing/storybook';
import { PYTHON_REASON } from '../constants';
import type { PackageView } from '@shared/types';

/** Готовый промпт и запрос видео возможны после утверждения всех запланированных опор. */
function approvedPackage(overrides: Partial<PackageView> = {}): PackageView {
  return keyframePackage({
    pendingDecision: null,
    keyframes: keyframePackage().keyframes.map((frame) => ({ ...frame, approved: true, imagePath: `${STORY_IMAGE_PATH}?frame=${frame.id}` })),
    ...overrides
  });
}

const meta = {
  title: 'Производство/Опоры/Материалы и замечания',
  component: KeyframeReviewStory,
  // Галерея и подтверждение управляют фокусом, поэтому play выполняется только в отдельном Canvas.
  tags: ['!autodocs'],
  args: { showFrames: true, showDecision: true },
  parameters: { controls: { disable: true } },
  render: (args) => <KeyframeReviewStory key={JSON.stringify(args)} {...args} />
} satisfies Meta<typeof KeyframeReviewStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const States: Story = { name: 'Утверждена · текущий вопрос · кандидат · не создана' };
export const NoFrames: Story = {
  name: 'Нет плана опор · блок отсутствует',
  args: { initialPackage: keyframePackage({ keyframes: [], keyframeNotes: [], pendingDecision: null }), showDecision: false }
};
export const ApprovedFileMissing: Story = {
  name: 'Утверждение сохранено · файл отсутствует',
  args: {
    initialPackage: keyframePackage({ keyframes: keyframePackage().keyframes.map((frame) => (frame.id === 'K01' ? { ...frame, imagePath: null } : frame)) })
  }
};
export const LongNotes: Story = {
  name: 'Длинные подписи и два охвата замечаний',
  args: {
    initialPackage: keyframePackage({
      keyframes: keyframePackage().keyframes.map((frame) => ({
        ...frame,
        note: 'Сохранить направление взгляда, вечерний свет и положение героя относительно ворот. Камера движется плавно вдоль забора, одежда и предметы совпадают с предыдущей принятой опорой.'
      })),
      keyframeNotes: [
        {
          id: 1,
          frame: 'K02',
          note: 'Только для этого кадра: камера ниже, ворота целиком в поле зрения.\nНе менять одежду и выражение лица.',
          scope: 'frame',
          active: true
        },
        {
          id: 2,
          frame: 'K02',
          note: 'Для всех следующих опор: сохранять вечернее освещение и пространственное расположение персонажей.',
          scope: 'following',
          active: true
        }
      ]
    })
  }
};
export const Busy: Story = { name: 'Операция выполняется · возврат и снятие замечания заблокированы', args: { busy: true } };
export const RuntimeUnavailable: Story = { name: 'Нет Python · причина недоступности', args: { busy: true, busyReason: PYTHON_REASON } };
export const PromptApproved: Story = {
  name: 'Видеопромпт утверждён · возврат запрещён',
  args: {
    initialPackage: approvedPackage({
      stage: 'prompt_review',
      prompt: { path: '/mock/video-prompt.txt', text: 'Камера плавно приближается к воротам.', approved: true }
    })
  }
};
export const VideoPrepared: Story = {
  name: 'Запрос видео подготовлен · возврат запрещён',
  args: {
    initialPackage: approvedPackage({
      stage: 'request_choice',
      pendingDecision: null,
      request: {
        dir: '/mock/request-01',
        kind: 'video',
        sha256: 'a'.repeat(64),
        model: 'Демонстрационная модель',
        parameters: {},
        inputs: [],
        attemptStatus: 'prepared',
        generationId: null,
        manualResult: false,
        creditsConsumed: null,
        downloads: []
      }
    })
  }
};
export const ImageInFlight: Story = {
  name: 'Изображение ещё отправляется · возврат запрещён',
  args: {
    initialPackage: keyframePackage({
      stage: 'image_submitted',
      pendingDecision: null,
      keyframes: keyframePackage().keyframes.map((frame) => (frame.id === 'K02' ? { ...frame, imagePath: null } : frame)),
      request: {
        dir: '/mock/image-request-01',
        kind: 'image',
        frameId: 'K02',
        sha256: 'b'.repeat(64),
        model: 'Демонстрационная модель',
        parameters: {},
        inputs: [],
        attemptStatus: 'submitted',
        generationId: 'demo-image-01',
        manualResult: false,
        creditsConsumed: null,
        downloads: []
      }
    })
  }
};
export const Gallery: Story = {
  name: 'Галерея · клавиатура и возврат в блок',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /Открыть крупно: K02/ }));
    const screen = within(canvasElement.ownerDocument.body);
    const dialog = await screen.findByRole('dialog');
    await expect(within(dialog).getByText('Опора · 2 / 3')).toBeInTheDocument();
    await userEvent.keyboard('{ArrowRight}');
    await expect(within(dialog).getByText('Опора · 3 / 3')).toBeInTheDocument();
    await expect(within(dialog).getByRole('img')).toHaveAttribute('src', expect.stringContaining('frame=K03'));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  }
};
export const RemoveNote: Story = {
  name: 'Снятие замечания · кандидат и черновик сохранены',
  args: { initialNote: 'Несохранённый черновик к текущей опоре.' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Снять замечание к K02' }));
    await canvas.findByText('Замечание снято и больше не учитывается.');
    await expect(canvas.queryByText('Сохранить куртку и направление света из утверждённой K01.')).not.toBeInTheDocument();
    await expect(canvas.getByRole('textbox', { name: 'Что исправить в опоре K02' })).toHaveValue('Несохранённый черновик к текущей опоре.');
    await expect(canvas.getByRole('button', { name: 'Утвердить K02' })).toBeEnabled();
  }
};
export const Reopen: Story = {
  name: 'Вернуть утверждённую опору · отменить, затем подтвердить',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('button', { name: 'Вернуть на доработку' }));
    let dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.getByText(/Опоры · утверждено 1 из 4/)).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Вернуть на доработку' }));
    dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Сохранить форму ворот.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Вернуть на доработку' }));
    await canvas.findByText('Утверждение K01 снято; замечание сохранено. Остальные опоры сохранены.');
    await expect(canvas.getByText(/Опоры · утверждено 0 из 4/)).toBeInTheDocument();
    await expect(canvas.getByText('Сохранить форму ворот.')).toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: /Открыть крупно: K02/ })).toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: 'Утвердить K02' })).toBeEnabled();
    await expect(canvas.getByRole('button', { name: 'Подставить готового кандидата' })).toBeDisabled();
    await expect(canvas.queryByText('Нет открытого вопроса. Следующий кандидат требует отдельной подготовки и согласования.')).not.toBeInTheDocument();
    await expect(canvas.queryByRole('button', { name: /Открыть крупно: K01/ })).not.toBeInTheDocument();
  }
};
export const AllApproved: Story = {
  name: 'Все опоры утверждены · отдельное согласование промпта впереди',
  args: {
    initialPackage: approvedPackage()
  }
};
