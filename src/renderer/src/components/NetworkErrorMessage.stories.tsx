/** Повторное отключение сети снова показывает закрытый баннер; AppProvider не монтируется. */
import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Stack } from '@mui/material';
import { AppValueProvider, useApp } from '../state';
import { ActionButton } from './ActionButton';
import { NetworkErrorMessage } from './NetworkErrorMessage';
function NetworkPreview() {
  const app = useApp();
  const [online, setOnline] = useState(false);
  return (
    <AppValueProvider value={{ ...app, online }}>
      <Stack spacing={2} alignItems="flex-start">
        <ActionButton onClick={() => setOnline(!online)}>{online ? 'Отключить сеть' : 'Восстановить сеть'}</ActionButton>
        <NetworkErrorMessage />
      </Stack>
    </AppValueProvider>
  );
}
const meta = { title: 'Общие/Нет сети', component: NetworkErrorMessage, render: () => <NetworkPreview /> } satisfies Meta<typeof NetworkErrorMessage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Reconnect: Story = { name: 'Закрытие и повторное отключение' };
