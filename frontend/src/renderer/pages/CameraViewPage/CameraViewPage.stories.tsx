/** Страница отдельного окна вида из камеры на локальной модели окна: кадры по присланной точке и зум объектива. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { CameraWindowMessage, CameraWindowState } from '@shared/camera-window';
import { scenarioTexts } from '@shared/texts/scenario';
import { SCENARIO_STORY_SCHEMES } from '../../testing/scenarioPageStories';
import { createStoryApi, type StoryApiSession, type StoryOptions } from '../../testing/storybook';
import { CameraViewPage } from './CameraViewPage';

const texts = scenarioTexts.viewpoint;

/** Точка у ворот: камера проезжает, герой стоит; угол обзора 30°. */
const MOVING: CameraWindowState = {
  title: texts.cameraWindowTitle({ shot: 'M03', location: 'Старые ворота' }),
  scheme: SCENARIO_STORY_SCHEMES.schemes[0],
  viewpoint: {
    location: 'gate',
    side: 'south',
    size: 'medium',
    fov: 30,
    camera: { start: [-4, -8], end: [4, -8] },
    subjects: [{ entity: 'hero', start: [0, 2] }]
  },
  heights: { hero: 1.8 },
  theme: 'light',
  editable: true
};

/** Сообщения, отправленные страницей окна в истории: play проверяет по ним зум. */
const sent: CameraWindowMessage[] = [];

/** Модель окна: на «готово» присылает состояние, как карта в основном окне. */
function options(state: CameraWindowState): StoryOptions {
  return {
    route: '/camera-view',
    createApi: () => {
      sent.length = 0;
      const session: StoryApiSession = createStoryApi({
        cameraWindow: {
          send: (message) => {
            sent.push(structuredClone(message));
            if (message.type === 'ready') queueMicrotask(() => session.emit.cameraMessage({ session: 'story', message: { type: 'state', state } }));
          }
        }
      });
      return session;
    }
  };
}

const meta = {
  title: 'Страницы/Вид из камеры',
  component: CameraViewPage,
  tags: ['!autodocs'],
  parameters: { songframe: options(MOVING), controls: { disable: true } }
} satisfies Meta<typeof CameraViewPage>;
export default meta;
type Story = StoryObj<typeof meta>;

export const MovingCamera: Story = {
  name: 'Камера движется · первый и последний кадр, зум отправляет угол карте',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    await expect(await screen.findByText(MOVING.title)).toBeVisible();
    for (const phase of ['start', 'end'] as const) {
      const frame = await waitFor(() => {
        const found = canvasElement.ownerDocument.querySelector<HTMLElement>(`[data-camera-frame="${phase}"]`);
        if (!found) throw new Error(`Нет кадра ${phase}.`);
        return found;
      });
      await expect(within(frame).getByRole('application', { name: texts.cameraFrame({ phase: texts.phases[phase] }) })).toBeVisible();
      await expect(Number(frame.querySelector('[data-volume-view]')?.getAttribute('data-triangles'))).toBeGreaterThan(40);
    }
    // Ползунок — зум объектива: вверх угол уже; окно отправляет угол карте и ждёт обновлённую точку.
    const zoom = screen.getByRole('slider', { name: texts.cameraZoom });
    await expect(zoom).toHaveAttribute('aria-valuetext', texts.cameraZoomValue({ fov: 30 }));
    zoom.focus();
    await userEvent.keyboard('{ArrowUp}');
    await waitFor(() => expect(sent.at(-1)).toEqual({ type: 'fov', fov: 29 }));
  }
};

export const Locked: Story = {
  name: 'План принят · зум выключен',
  tags: ['ci'],
  parameters: { songframe: options({ ...MOVING, editable: false }) },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    await expect(await screen.findByRole('slider', { name: texts.cameraZoom })).toBeDisabled();
  }
};

export const NoCamera: Story = {
  name: 'Камера не поставлена · подсказка вместо кадра',
  tags: ['ci'],
  parameters: { songframe: options({ ...MOVING, viewpoint: { ...MOVING.viewpoint, camera: undefined } }) },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    await expect(await screen.findByText(texts.cameraViewNoCamera)).toBeVisible();
    await expect(canvasElement.ownerDocument.querySelector('[data-camera-frame]')).toBeNull();
  }
};
