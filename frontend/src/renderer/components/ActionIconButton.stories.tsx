/** Значок имеет доступное имя; отключённая обёртка сохраняет подсказку и фокус. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import RefreshIcon from '@mui/icons-material/Refresh';
import { fn } from 'storybook/test';
import { commonTexts } from '@shared/texts/common';
import { ActionIconButton } from './ActionIconButton';
const meta = {
  title: 'Общие/Кнопка со значком',
  component: ActionIconButton,
  args: { 'aria-label': commonTexts.refresh, children: <RefreshIcon />, onClick: fn() }
} satisfies Meta<typeof ActionIconButton>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Available: Story = { name: 'Доступна' };
export const Disabled: Story = { name: 'Отключена с объяснением', args: { disabled: true, disabledReason: commonTexts.waitForCurrentOperation } };
