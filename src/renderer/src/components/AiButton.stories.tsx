/** Прямой провайдер сохраняет свой предметный значок без логотипа текстового агента. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import { fn } from 'storybook/test';
import { storyAccess } from '../testing/commonStories';
import type { StoryOptions } from '../testing/storybook';
import { AiButton } from './AiButton';
const meta = {
  title: 'Общие/Прямое AI-действие',
  component: AiButton,
  args: { aiKind: 'image', children: 'Создать изображение', startIcon: <AutoAwesomeIcon />, onClick: fn() },
  parameters: { songframe: { app: { aiAccess: storyAccess } } satisfies StoryOptions }
} satisfies Meta<typeof AiButton>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Available: Story = { name: 'Провайдер доступен' };
export const MissingProvider: Story = {
  name: 'Провайдер не выбран',
  parameters: {
    songframe: {
      app: {
        aiAccess: {
          ...storyAccess,
          image: { provider: null, selected: false, available: false, message: 'Выберите провайдера изображений в настройках проекта.' }
        }
      }
    } satisfies StoryOptions
  }
};
export const Offline: Story = { name: 'Нет сети', parameters: { songframe: { app: { aiAccess: storyAccess, online: false } } satisfies StoryOptions } };
