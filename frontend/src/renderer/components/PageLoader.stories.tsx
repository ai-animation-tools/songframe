/** Реальная задержка прелоадера проверяется без подмены таймеров MUI. */
import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Alert, Stack } from '@mui/material';
import { ActionButton } from './ActionButton';
import { usePageLoading } from './PageLoader';
function LoadingPreview({ durationMs }: { durationMs: number }) {
  const [loading, setLoading] = useState(false);
  usePageLoading(loading);
  useEffect(() => {
    if (!loading) return;
    const timer = setTimeout(() => setLoading(false), durationMs);
    return () => clearTimeout(timer);
  }, [loading, durationMs]);
  return (
    <Stack spacing={2} alignItems="flex-start">
      <ActionButton variant="contained" disabled={loading} disabledReason="Дождитесь окончания загрузки." onClick={() => setLoading(true)}>
        Загрузить данные
      </ActionButton>
      <Alert severity="info">{loading ? 'Данные загружаются.' : `Длительность демонстрационной загрузки: ${durationMs} мс.`}</Alert>
    </Stack>
  );
}
const meta = { title: 'Общие/Загрузка страницы', component: LoadingPreview, args: { durationMs: 1200 } } satisfies Meta<typeof LoadingPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Slow: Story = { name: 'Индикатор после 150 мс' };
export const Fast: Story = { name: 'Быстрая загрузка без мигания', args: { durationMs: 80 } };
