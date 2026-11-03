/** Выбранный агент и исполнитель выполняющегося задания имеют разные источники значка. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { storyAccess } from '../testing/commonStories';
import type { StoryOptions } from '../testing/storybook';
import { AgentButton } from './AgentButton';
const meta = {
  title: 'Общие/Действие агента',
  component: AgentButton,
  args: { children: 'Подготовить описание', variant: 'contained', onClick: fn() },
  parameters: { songframe: { app: { aiAccess: storyAccess, agentProvider: 'codex' } } satisfies StoryOptions }
} satisfies Meta<typeof AgentButton>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Selected: Story = { name: 'Выбран Codex' };
export const RunningProvider: Story = {
  name: 'Исполнитель задания Claude',
  args: { provider: 'claude', disabled: true, disabledReason: 'Дождитесь завершения задания.' }
};
export const NotSelected: Story = {
  name: 'Без выбранного агента',
  parameters: {
    songframe: {
      app: {
        agentProvider: null,
        aiAccess: { ...storyAccess, agent: { provider: null, selected: false, available: false, message: 'Выберите агента в настройках приложения.' } }
      }
    } satisfies StoryOptions
  }
};
export const Offline: Story = {
  name: 'Нет сети',
  parameters: { songframe: { app: { aiAccess: storyAccess, agentProvider: 'codex', online: false } } satisfies StoryOptions }
};
