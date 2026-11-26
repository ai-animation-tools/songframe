/** Кнопка обложки показывает исполнителя провайдера изображений, а не выбранного текстового агента. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { sourcesTexts } from '@shared/texts/sources';
import { TEST_AGENT_PROVIDER } from '@shared/testing/media-provider';
import { imageStoryOptions } from '../../../testing/imageStories';
import { CoverSection } from './CoverSection';

const noop = (): void => undefined;

const meta = {
  title: 'Исходники/Обложка',
  component: CoverSection,
  tags: ['!autodocs'],
  args: { coverSrc: null, onPick: async () => undefined, onRemove: noop, onDrop: noop, onGenerate: noop },
  parameters: { songframe: imageStoryOptions() }
} satisfies Meta<typeof CoverSection>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Агентный провайдер изображений с исполнителем Codex при выбранном текстовом агенте Claude. */
export const AgentExecutor: Story = {
  name: 'Исполнитель изображений Codex при агенте Claude',
  parameters: {
    songframe: (() => {
      const options = imageStoryOptions({ provider: TEST_AGENT_PROVIDER });
      return { ...options, app: { ...options.app, agentProvider: 'claude' } };
    })()
  },
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: sourcesTexts.generateCover });
    await expect(button).toBeEnabled();
    await expect(button.querySelector('[data-agent-icon="codex"]')).not.toBeNull();
    await expect(button.querySelector('[data-agent-icon="claude"]')).toBeNull();
  }
};

/** Прямой запрос к сервису без исполнителя — обычная кнопка без знака агента. */
export const DirectProvider: Story = {
  name: 'Прямой провайдер — без знака агента',
  parameters: {
    songframe: (() => {
      const options = imageStoryOptions();
      return { ...options, app: { ...options.app, agentProvider: 'claude' } };
    })()
  },
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: sourcesTexts.generateCover });
    await expect(button).toBeEnabled();
    await expect(button.querySelector('[data-agent-icon]')).toBeNull();
  }
};

/** Без провайдера изображений кнопка выключена с причиной из настроек. */
export const ProviderRequired: Story = {
  name: 'Без провайдера изображений',
  parameters: { songframe: imageStoryOptions({}, false) },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('button', { name: sourcesTexts.generateCover })).toBeDisabled();
  }
};
