/** Просмотр карточки не меняет её несохранённые поля или список изображений. Проверка кастинга принадлежит странице. */
import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { DEFAULT_SOURCE_KINDS } from '@shared/types';
import { sourcesTexts } from '@shared/texts/sources';
import { componentsTexts } from '@shared/texts/components';
import { commonTexts } from '@shared/texts/common';
import type { ReferenceForm } from '../types';
import { ReferenceEditor } from './ReferenceEditor';

function Preview({ checking = false }: { checking?: boolean }) {
  const [reference, setReference] = useState<ReferenceForm>({
    key: 1,
    id: 'hero',
    kind: 'character',
    name: 'Герой',
    short_name: '',
    description: 'Синяя куртка',
    prompt: '',
    files: [
      { key: 2, existingPath: '/mock/front/story-image.png', view: 'front', note: 'Сохранённый вид', prompt: '' },
      { key: 3, sourcePath: '/mock/upload/story-image.png', view: 'side', note: 'Новый вид', prompt: '' }
    ]
  });
  return (
    <ReferenceEditor
      reference={reference}
      kinds={DEFAULT_SOURCE_KINDS}
      duplicateId={false}
      filePath={(path) => path}
      fileUrl={(path) => window.api.shell.fileUrl(path)}
      removalPending={checking}
      onUpdate={(patch) => setReference((current) => ({ ...current, ...patch }))}
      onRetryFilePrompt={async () => undefined}
      onRemove={() => undefined}
      onGenerate={() => undefined}
      onAddFiles={async () => undefined}
      onDropFiles={() => undefined}
      onUpdateFile={(key, patch) =>
        setReference((current) => ({ ...current, files: current.files.map((file) => (file.key === key ? { ...file, ...patch } : file)) }))
      }
      onRemoveFile={(key) => setReference((current) => ({ ...current, files: current.files.filter((file) => file.key !== key) }))}
    />
  );
}
const meta = { title: 'Исходники/Референс', component: Preview, tags: ['!autodocs'] } satisfies Meta<typeof Preview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ImagePreview: Story = {
  name: 'Просмотр сохранённого и нового изображения с сохранением черновика',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('button', { name: /Герой/ }));
    const description = canvas.getByRole('textbox', { name: sourcesTexts.entityDescription });
    await userEvent.type(description, ' и шляпа');
    const trigger = canvas.getByRole('button', { name: componentsTexts.gallery.openLarge({ label: 'Герой — Спереди' }) });
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog');
    await expect(within(dialog).getByRole('img')).toHaveAttribute('src', window.api.shell.fileUrl('/mock/front/story-image.png'));
    await userEvent.keyboard('{ArrowRight}');
    await expect(within(dialog).getByRole('img')).toHaveAttribute('src', window.api.shell.fileUrl('/mock/upload/story-image.png'));
    await userEvent.click(within(dialog).getByRole('button', { name: componentsTexts.gallery.originalSize }));
    await expect(within(dialog).getByRole('button', { name: componentsTexts.gallery.originalSize })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(within(dialog).getByRole('button', { name: commonTexts.close }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(trigger).toHaveFocus();
    await expect(description).toHaveValue('Синяя куртка и шляпа');
  }
};
export const CheckingUsage: Story = {
  name: 'Проверка кастинга — видимый статус и временный запрет удаления',
  tags: ['ci'],
  args: { checking: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /Герой/ }));
    await expect(canvas.getByRole('status')).toHaveTextContent(sourcesTexts.referenceRemovalChecking);
    await expect(canvas.getByRole('button', { name: sourcesTexts.removeReferenceImage({ view: 'Спереди' }) })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: sourcesTexts.removeReference({ name: 'Герой' }) })).toBeDisabled();
  }
};
