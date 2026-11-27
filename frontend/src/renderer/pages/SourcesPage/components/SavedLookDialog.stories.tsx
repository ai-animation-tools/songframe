/** Окно образа отдельно: состояния, которые страница показывает редко, — образ удалён в аккаунте и мало снимков. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { SourceReference } from '@shared/types';
import { savedLooksTexts } from '@shared/texts/saved-looks';
import { SAVED_LOOKS_STORY_RULES } from '../../../testing/savedLooksStories';
import { SavedLookDialog, type SavedLookDialogProps } from './SavedLookDialog';

const reference: SourceReference = {
  id: 'hero',
  kind: 'character',
  name: 'Герой',
  short_name: '',
  description: '',
  prompt: null,
  files: [
    { path: 'heroes/story-image.png', sha256: 'a'.repeat(64), bytes: 1, view: 'full', note: '' },
    { path: 'heroes/story-frame-a.png', sha256: 'b'.repeat(64), bytes: 1, view: 'side', note: '' }
  ]
};

const done = async (): Promise<string | null> => null;

function Preview(props: Partial<SavedLookDialogProps>) {
  return (
    <SavedLookDialog
      reference={reference}
      rules={SAVED_LOOKS_STORY_RULES}
      state={{ reference: 'hero', status: 'none' }}
      looks={[]}
      fileUrl={(path) => window.api.shell.fileUrl(`/mock/${path}`)}
      onClose={() => undefined}
      onCreate={done}
      onBind={done}
      onUnbind={done}
      onRemove={done}
      {...props}
    />
  );
}

const meta = { title: 'Исходники/Окно сохранённого образа', component: Preview, tags: ['!autodocs'] } satisfies Meta<typeof Preview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Missing: Story = {
  name: 'Образ удалён в аккаунте · создать новый или выбрать другой',
  args: { state: { reference: 'hero', status: 'missing', look: '7', name: 'Герой' } },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    await expect(await screen.findByText(savedLooksTexts.missingNotice({ name: 'Герой' }))).toBeVisible();
    await expect(screen.getByRole('tab', { name: savedLooksTexts.tabCreate })).toBeVisible();
    await expect(screen.queryByRole('button', { name: savedLooksTexts.remove })).not.toBeInTheDocument();
  }
};

export const TooFewFiles: Story = {
  name: 'У референса один снимок · создание недоступно с объяснением',
  args: { reference: { ...reference, files: reference.files.slice(0, 1) } },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    await expect(await screen.findByText(savedLooksTexts.extraNeedFiles({ min: 1 }))).toBeVisible();
    await expect(screen.getByRole('button', { name: savedLooksTexts.create })).toBeDisabled();
  }
};

export const ChooseEmpty: Story = {
  name: 'Выбор из пустого аккаунта',
  args: { looks: [] }
};
