import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import type { AppState } from '@shared/types';
import { shellTexts } from '@shared/texts/shell';
import { App } from './App';
import { RenderBoundary } from './components/RenderBoundary';
import { ReadyContent } from './components/ReadyContent';

/** Независимый снимок Go-контракта: история не использует чужой профиль и не запускает настоящий мост. */
const state: AppState = { packaged: true, problems: [], toolsRoot: null, localDir: '/test/songframe-go-dev', current: null, history: [], platform: 'linux' };
const meta = {
  title: 'Оболочка/SongFrame',
  component: App,
  args: { loadState: async (): Promise<AppState> => ({ ...state, history: [] }), onReady: async () => undefined },
  tags: ['ci']
} satisfies Meta<typeof App>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Ready: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: shellTexts.projectsTitle })).toBeVisible();
    await expect(canvas.getByRole('button', { name: shellTexts.openProject })).toBeDisabled();
  }
};
export const Dark: Story = { ...Ready, parameters: { dark: true } };
export const Loading: Story = {
  args: { loadState: () => new Promise<AppState>(() => undefined) },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByRole('status', { name: shellTexts.loading })).toBeVisible();
  }
};
export const StartupError: Story = {
  args: {
    loadState: async () => {
      throw new Error(shellTexts.profileProblem);
    }
  },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText(shellTexts.profileProblem)).toBeVisible();
  }
};

/** Локальная модель воспроизводит отказ первого чтения и успешное повторное чтение без перезапуска окна. */
export const Retry: Story = {
  render: (args) => {
    let attempts = 0;
    return (
      <App
        {...args}
        loadState={async () => {
          attempts += 1;
          if (attempts === 1) throw new Error(shellTexts.profileProblem);
          return state;
        }}
      />
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const retry = await canvas.findByRole('button', { name: shellTexts.retry });
    await userEvent.click(retry);
    await expect(await canvas.findByRole('heading', { name: shellTexts.projectsTitle })).toBeVisible();
    await expect(canvas.queryByText(shellTexts.startupError)).not.toBeInTheDocument();
  }
};
export const Unavailable: Story = {
  parameters: { route: '/project/timing' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(shellTexts.unavailable)).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: shellTexts.returnProjects }));
    await expect(await canvas.findByRole('heading', { name: shellTexts.projectsTitle })).toBeVisible();
  }
};

/** Ошибка потомка должна оставить действие восстановления; реальная диагностика здесь не отправляется. */
function BrokenPage(): never {
  throw new Error(shellTexts.profileProblem);
}
export const RenderError: Story = {
  args: { onReady: fn(async () => undefined) },
  render: (args) => (
    <RenderBoundary>
      <ReadyContent onReady={args.onReady ?? meta.args.onReady} onError={() => undefined}>
        <BrokenPage />
      </ReadyContent>
    </RenderBoundary>
  ),
  play: async ({ canvasElement, args }) => {
    await expect(await within(canvasElement).findByText(shellTexts.renderError)).toBeVisible();
    // Видимый fallback не считается готовой страницей и не разрешает завершить нативный smoke успехом.
    await expect(args.onReady).not.toHaveBeenCalled();
  }
};
