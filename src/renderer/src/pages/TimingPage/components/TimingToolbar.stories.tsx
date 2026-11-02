/** Панель раскрывает выбор режима, сохраняя явное сохранение и причины блокировки автоматического запуска. */
import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { timingEditorTexts as texts } from '@shared/texts/timing-editor';
import { timingTexts } from '@shared/texts/timing';
import { TimingToolbar } from './TimingToolbar';

function ToolbarStory({ dirty = false, missingTrack = false }: { dirty?: boolean; missingTrack?: boolean }) {
  const [manual, setManual] = useState(false);
  return (
    <TimingToolbar
      lineCount={28}
      verifiedCount={22}
      dirty={dirty}
      busy={false}
      generating={false}
      manualMode={manual}
      onManualModeChange={setManual}
      invalidBindings={false}
      canGenerate={!missingTrack}
      generateBlockedReason={missingTrack ? timingTexts.addTrack : null}
      onGenerate={() => {}}
      onConfirmAll={() => {}}
      onRecalculateSections={() => {}}
      onSave={() => {}}
      onDiscard={() => {}}
    />
  );
}
const meta = {
  title: 'Тайминги/Действия и причины',
  component: ToolbarStory,
  tags: ['!autodocs'],
  parameters: { controls: { disable: true } },
  render: (args) => <ToolbarStory {...args} />
} satisfies Meta<typeof ToolbarStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const MenuModes: Story = {
  tags: ['ci'],
  name: 'Распознать · Автоматически / Вручную',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('button', { name: texts.recognize }));
    await expect(screen.getByRole('menuitem', { name: texts.automatic })).not.toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(screen.getByRole('menuitem', { name: texts.manual }));
    await expect(canvas.getByText(texts.mode)).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
  }
};
export const MissingTrack: Story = {
  args: { missingTrack: true },
  name: 'Нет трека · ручная работа доступна',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('button', { name: texts.recognize }));
    await expect(screen.getByRole('menuitem', { name: texts.automatic })).toHaveAttribute('aria-disabled', 'true');
    await expect(screen.getByRole('menuitem', { name: texts.manual })).not.toHaveAttribute('aria-disabled', 'true');
    await expect(screen.getByRole('menuitem', { name: texts.automatic })).toHaveAttribute('title', timingTexts.addTrack);
  }
};
export const Unsaved: Story = {
  tags: ['ci'],
  args: { dirty: true },
  name: 'Есть правки · автоматический запуск заблокирован · ручной доступен',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('button', { name: texts.recognize }));
    await expect(screen.getByRole('menuitem', { name: texts.automatic })).toHaveAttribute('aria-disabled', 'true');
    await expect(screen.getByRole('menuitem', { name: texts.automatic })).toHaveAttribute('title', timingTexts.saveBeforeGenerate);
    await userEvent.click(screen.getByRole('menuitem', { name: texts.manual }));
    await expect(canvas.getByRole('button', { name: 'Сохранить' })).toBeEnabled();
  }
};
