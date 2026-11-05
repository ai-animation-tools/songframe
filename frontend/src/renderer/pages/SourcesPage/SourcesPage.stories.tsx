/** Полная страница проверяет передачу несохранённых исходников и изображений только выбранного объекта. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { sourcesTexts } from '@shared/texts/sources';
import { castTexts } from '@shared/texts/cast';
import { ReferencePagesJourney } from '../../testing/ReferencePagesJourney';
import { commonTexts } from '@shared/texts/common';
import { IMAGE_STORY_PROJECT, IMAGE_STORY_STYLE } from '../../testing/imageStories';
import {
  REFERENCE_PAGE_NAME,
  REFERENCE_PAGE_SAVED,
  REFERENCE_PAGE_PROFILE,
  REFERENCE_PAGE_BACK,
  REFERENCE_PAGE_NOTE,
  REFERENCE_PAGE_PROFILE_NOTE,
  REFERENCE_PAGE_DRAFT_NOTE,
  REFERENCE_PAGE_ORIGINAL_PROMPT,
  REFERENCE_PAGE_SHARED_DESCRIPTION,
  REFERENCE_PAGE_SAVE_ERROR,
  referencePageSnapshot,
  REFERENCE_PAGE_UPLOAD,
  REFERENCE_PAGE_DRAFT_IDEA,
  REFERENCE_PAGE_DRAFT_LYRICS,
  referencePageInspection,
  referencePageOptions
} from '../../testing/referencePageStories';
import { SourcesPage } from './SourcesPage';
import { expectImplicitCloseBlocked } from '../../testing/dialogStories';

const meta = {
  title: 'Страницы/Исходники',
  component: SourcesPage,
  tags: ['!autodocs'],
  parameters: { songframe: referencePageOptions('sources') }
} satisfies Meta<typeof SourcesPage>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ReferenceDraftContext: Story = {
  tags: ['ci'],
  name: 'Референс — черновик контекста и загруженный вид объекта',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const idea = await canvas.findByRole('textbox', { name: sourcesTexts.idea });
    await userEvent.clear(idea);
    await userEvent.type(idea, REFERENCE_PAGE_DRAFT_IDEA);
    const lyrics = canvas.getByRole('textbox', { name: sourcesTexts.lyrics });
    await userEvent.clear(lyrics);
    await userEvent.type(lyrics, REFERENCE_PAGE_DRAFT_LYRICS.replaceAll('[', '[['));
    await userEvent.click(canvas.getByRole('button', { name: new RegExp(REFERENCE_PAGE_NAME) }));
    await userEvent.click(
      await canvas.findByRole('button', { name: (name) => name.startsWith(sourcesTexts.pickReferenceImages({ name: REFERENCE_PAGE_NAME })) })
    );
    await userEvent.click(canvas.getByRole('button', { name: sourcesTexts.generateReferenceImage }));
    const screen = within(canvasElement.ownerDocument.body);
    const dialog = await screen.findByRole('dialog', { name: sourcesTexts.createReferenceImage });
    for (const label of [sourcesTexts.referenceSupports, sourcesTexts.referenceConstructor]) {
      const summary = within(dialog).getByRole('button', { name: (name) => name.startsWith(label) });
      await expect(summary).toHaveAttribute('aria-expanded', 'false');
      await userEvent.click(summary);
    }
    await expect(within(dialog).getAllByRole('img')).toHaveLength(2);
    const draft = within(dialog).getByRole<HTMLTextAreaElement>('textbox', { name: sourcesTexts.referenceImagePrompt });
    await waitFor(() => {
      if (within(dialog).getByRole<HTMLInputElement>('checkbox', { name: sourcesTexts.referenceVisualStyle }).disabled)
        throw new Error('Контекст ещё читается.');
    });
    await expect(draft.value).not.toContain(IMAGE_STORY_STYLE);
    await expect(draft.value).not.toContain(REFERENCE_PAGE_NOTE);
    await expect(within(dialog).getByRole('checkbox', { name: sourcesTexts.referenceVisualStyle })).not.toBeChecked();
    await expect(draft.value).not.toContain(REFERENCE_PAGE_DRAFT_IDEA);
    await expect(draft.value).not.toContain(REFERENCE_PAGE_DRAFT_LYRICS);
    await userEvent.click(within(dialog).getByRole('checkbox', { name: sourcesTexts.referenceIdea }));
    await userEvent.click(within(dialog).getByRole('checkbox', { name: sourcesTexts.referenceLyrics }));
    await userEvent.click(within(dialog).getByRole('checkbox', { name: sourcesTexts.referenceVisualStyle }));
    await userEvent.click(within(dialog).getByRole('checkbox', { name: sourcesTexts.referenceUseImage({ label: 'Спереди' }) }));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: sourcesTexts.generateReferenceImage })).toBeEnabled());
    await userEvent.click(within(dialog).getByRole('button', { name: sourcesTexts.generateReferenceImage }));
    const confirmation = await screen.findByRole('dialog', { name: sourcesTexts.confirmPromptTitle });
    const prompt = within(confirmation).getByRole<HTMLTextAreaElement>('textbox', { name: sourcesTexts.confirmedPrompt });
    await expect(prompt.value).toContain(REFERENCE_PAGE_DRAFT_IDEA);
    await expect(prompt.value).toContain(REFERENCE_PAGE_DRAFT_LYRICS);
    await expect(prompt.value).toContain(IMAGE_STORY_STYLE);
    await expect(referencePageInspection().creates[0].input).toMatchObject({
      images: [{ path: REFERENCE_PAGE_UPLOAD, label: 'Другое' }]
    });
    await expect(referencePageInspection().contexts[0]).toEqual({
      project: IMAGE_STORY_PROJECT,
      drafts: { idea: REFERENCE_PAGE_DRAFT_IDEA, lyrics: REFERENCE_PAGE_DRAFT_LYRICS }
    });
    await expect(within(confirmation).getAllByRole('img')).toHaveLength(1);
    await expect(referencePageInspection().generations).toBe(0);
    await userEvent.click(within(confirmation).getByRole('button', { name: commonTexts.cancel }));
    await expect(await screen.findByRole('textbox', { name: sourcesTexts.referenceImagePrompt })).not.toHaveAttribute('readonly');
  }
};

export const SharedAppearanceRoundTrip: Story = {
  tags: ['ci'],
  name: 'Общее описание — исходники → кастинг → исходники и очистка',
  render: () => <ReferencePagesJourney />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(await canvas.findByRole('button', { name: new RegExp(REFERENCE_PAGE_NAME) }));
    let description = canvas.getByRole('textbox', { name: sourcesTexts.entityDescription });
    await expect(description).toHaveAccessibleDescription(sourcesTexts.entityDescriptionHint);
    await userEvent.clear(description);
    await userEvent.type(description, REFERENCE_PAGE_SHARED_DESCRIPTION);
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.save }));
    await waitFor(() => expect(referencePageSnapshot().manifest.references[0].description).toBe(REFERENCE_PAGE_SHARED_DESCRIPTION));
    await expect(await screen.findByText(sourcesTexts.saved)).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Открыть кастинг' }));
    description = await canvas.findByRole('textbox', { name: castTexts.appearance });
    await expect(description).toHaveValue(REFERENCE_PAGE_SHARED_DESCRIPTION);
    await expect(description).toHaveAccessibleDescription(castTexts.sharedDescriptionHint);
    const changed = 'Общий текст после правки в кастинге.';
    await userEvent.clear(description);
    await userEvent.type(description, changed);
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.save }));
    await waitFor(() => expect(referencePageSnapshot().manifest.references[0].description).toBe(changed));
    await expect(await screen.findByText(castTexts.saved)).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Открыть исходники' }));
    await userEvent.click(await canvas.findByRole('button', { name: new RegExp(REFERENCE_PAGE_NAME) }));
    description = canvas.getByRole('textbox', { name: sourcesTexts.entityDescription });
    await expect(description).toHaveValue(changed);
    await userEvent.clear(description);
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.save }));
    await waitFor(() => expect(referencePageSnapshot().manifest.references[0].description).toBe(''));
    await waitFor(() => expect(canvas.getByRole('button', { name: commonTexts.save })).toBeDisabled());
    await userEvent.click(canvas.getByRole('button', { name: 'Открыть кастинг' }));
    await expect(await canvas.findByRole('textbox', { name: castTexts.appearance })).toHaveValue('');
    await userEvent.click(canvas.getByRole('button', { name: castTexts.supplement }));
    await waitFor(() => expect(referencePageSnapshot().supplements).toBe(1));
    await expect(canvas.getByRole('textbox', { name: castTexts.appearance })).toHaveValue('');
    await expect(referencePageSnapshot().cast.entities.find((entity) => entity.id === 'hero')?.appearance).toBe('');
    await expect(referencePageInspection().generations).toBe(0);
  }
};

export const SharedAppearanceSaveFailure: Story = {
  tags: ['ci'],
  name: 'Общее описание — ошибка исходников сохраняет черновик для повтора',
  parameters: { songframe: referencePageOptions('sources', { failSourceSaveOnce: true }) },
  render: () => <ReferencePagesJourney />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    const before = referencePageSnapshot();
    await userEvent.click(await canvas.findByRole('button', { name: new RegExp(REFERENCE_PAGE_NAME) }));
    const description = canvas.getByRole('textbox', { name: sourcesTexts.entityDescription });
    await userEvent.clear(description);
    await userEvent.type(description, REFERENCE_PAGE_SHARED_DESCRIPTION);
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.save }));
    await expect(await screen.findByText(REFERENCE_PAGE_SAVE_ERROR)).toBeInTheDocument();
    await expect(description).toHaveValue(REFERENCE_PAGE_SHARED_DESCRIPTION);
    await expect(referencePageSnapshot().manifest).toEqual(before.manifest);
    await expect(referencePageSnapshot().cast).toEqual(before.cast);
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.save }));
    await waitFor(() => expect(referencePageSnapshot().sourceSaves).toBe(2));
    await expect(await screen.findByText(sourcesTexts.saved)).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Открыть кастинг' }));
    await expect(await canvas.findByRole('textbox', { name: castTexts.appearance })).toHaveValue(REFERENCE_PAGE_SHARED_DESCRIPTION);
  }
};

export const OriginalImagePromptHistory: Story = {
  tags: ['ci'],
  name: 'Исходный промпт — история изображения вне нового запроса',
  parameters: { songframe: referencePageOptions('sources', { originalPrompt: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(await canvas.findByRole('button', { name: new RegExp(REFERENCE_PAGE_NAME) }));
    const original = canvas.getByRole('textbox', { name: sourcesTexts.imagePrompt });
    await expect(original).toHaveValue(REFERENCE_PAGE_ORIGINAL_PROMPT);
    await expect(original).toHaveAccessibleDescription(sourcesTexts.imagePromptHint);
    await expect(original).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: sourcesTexts.generateReferenceImage }));
    const dialog = await screen.findByRole('dialog', { name: sourcesTexts.createReferenceImage });
    const action = () => within(dialog).getByRole<HTMLButtonElement>('button', { name: sourcesTexts.generateReferenceImage });
    await waitFor(() => {
      if (action().disabled) throw new Error('Контекст ещё читается.');
    });
    await expect(within(dialog).getByRole<HTMLTextAreaElement>('textbox', { name: sourcesTexts.referenceImagePrompt }).value).not.toContain(
      'Исторический запрос:'
    );
    await userEvent.click(action());
    const confirmation = await screen.findByRole('dialog', { name: sourcesTexts.confirmPromptTitle });
    await expect(within(confirmation).getByRole<HTMLTextAreaElement>('textbox', { name: sourcesTexts.confirmedPrompt }).value).not.toContain(
      'Исторический запрос:'
    );
    await expect(referencePageInspection().creates[0].prompt).not.toContain('Исторический запрос:');
    await expect(referencePageInspection().generations).toBe(0);
    await userEvent.click(within(confirmation).getByRole('button', { name: commonTexts.cancel }));
    const returned = await screen.findByRole('dialog', { name: sourcesTexts.createReferenceImage });
    await userEvent.click(within(returned).getByRole('button', { name: commonTexts.cancel }));
    const restored = await canvas.findByRole('textbox', { name: sourcesTexts.imagePrompt });
    // После отмены пользователь возвращается к чтению истории конкретного изображения.
    await userEvent.click(restored);
    await expect(restored).toHaveFocus();
    await expect(restored).toHaveValue(REFERENCE_PAGE_ORIGINAL_PROMPT);
    await expect(restored).toHaveAccessibleDescription(sourcesTexts.imagePromptHint);
  }
};

export const ReferenceSupportNotes: Story = {
  tags: ['ci'],
  name: 'Примечания опор — черновик, явное включение и исключение изображения',
  parameters: { songframe: referencePageOptions('sources', { multipleImages: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(await canvas.findByRole('button', { name: new RegExp(REFERENCE_PAGE_NAME) }));
    const note = canvas.getAllByRole('textbox', { name: sourcesTexts.imageDescription })[0];
    await expect(note).toHaveValue(REFERENCE_PAGE_NOTE);
    await expect(note).toHaveAccessibleDescription(sourcesTexts.imageNoteHint);
    await userEvent.clear(note);
    await userEvent.type(note, REFERENCE_PAGE_DRAFT_NOTE);
    await userEvent.click(canvas.getByRole('button', { name: sourcesTexts.generateReferenceImage }));
    const dialog = await screen.findByRole('dialog', { name: sourcesTexts.createReferenceImage });
    for (const label of [sourcesTexts.referenceSupports, sourcesTexts.referenceConstructor]) {
      await userEvent.click(within(dialog).getByRole('button', { name: (name) => name.startsWith(label) }));
    }
    const prompt = () => within(dialog).getByRole<HTMLTextAreaElement>('textbox', { name: sourcesTexts.referenceImagePrompt }).value;
    const toggle = within(dialog).getByRole('checkbox', { name: sourcesTexts.referenceSupportNotes });
    await waitFor(() => expect(toggle).toBeEnabled());
    await expect(toggle).not.toBeChecked();
    await expect(prompt()).not.toContain(REFERENCE_PAGE_NOTE);
    await expect(prompt()).not.toContain(REFERENCE_PAGE_DRAFT_NOTE);
    await expect(prompt()).not.toContain(REFERENCE_PAGE_PROFILE_NOTE);
    await userEvent.click(toggle);
    await expect(prompt()).toContain(REFERENCE_PAGE_DRAFT_NOTE);
    await expect(prompt()).toContain(REFERENCE_PAGE_PROFILE_NOTE);
    await userEvent.click(within(dialog).getByRole('checkbox', { name: sourcesTexts.referenceUseImage({ label: 'Сбоку' }) }));
    await waitFor(() => expect(prompt()).toContain('Опора 1 (Спереди):\n' + REFERENCE_PAGE_DRAFT_NOTE));
    await expect(prompt()).not.toContain(REFERENCE_PAGE_PROFILE_NOTE);
    await waitFor(() => expect(within(dialog).getByRole('button', { name: sourcesTexts.generateReferenceImage })).toBeEnabled());
    await userEvent.click(within(dialog).getByRole('button', { name: sourcesTexts.generateReferenceImage }));
    const confirmation = await screen.findByRole('dialog', { name: sourcesTexts.confirmPromptTitle });
    const prepared = within(confirmation).getByRole<HTMLTextAreaElement>('textbox', { name: sourcesTexts.confirmedPrompt }).value;
    await expect(prepared).toContain(REFERENCE_PAGE_DRAFT_NOTE);
    await expect(prepared).not.toContain(REFERENCE_PAGE_PROFILE_NOTE);
    await expect(referencePageInspection().creates[0].prompt).toBe(prepared);
    await expect(referencePageInspection().creates[0].input?.images).toMatchObject([
      { path: `${IMAGE_STORY_PROJECT}/source/${REFERENCE_PAGE_SAVED}`, label: 'Спереди' },
      { path: `${IMAGE_STORY_PROJECT}/source/${REFERENCE_PAGE_BACK}`, label: 'Сзади' }
    ]);
    await expect(referencePageInspection().creates[0].input?.images.some((image) => image.path.endsWith(REFERENCE_PAGE_PROFILE))).toBe(false);
    await expect(referencePageInspection().generations).toBe(0);
  }
};

export const MissingReferenceImageInspectionPreservesDrafts: Story = {
  tags: ['ci'],
  name: 'Прежний API опор — исходники сохраняют несохранённые поля',
  parameters: { songframe: referencePageOptions('sources', { missingReferenceImageInspection: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    const idea = await canvas.findByRole('textbox', { name: sourcesTexts.idea });
    await userEvent.clear(idea);
    await userEvent.type(idea, REFERENCE_PAGE_DRAFT_IDEA);
    const lyrics = canvas.getByRole('textbox', { name: sourcesTexts.lyrics });
    await userEvent.clear(lyrics);
    await userEvent.type(lyrics, REFERENCE_PAGE_DRAFT_LYRICS.replaceAll('[', '[['));
    await userEvent.click(canvas.getByRole('button', { name: new RegExp(REFERENCE_PAGE_NAME) }));
    const description = canvas.getByRole('textbox', { name: sourcesTexts.entityDescription });
    await userEvent.clear(description);
    await userEvent.type(description, REFERENCE_PAGE_SHARED_DESCRIPTION);
    const before = referencePageSnapshot();
    await expect(typeof window.api.referenceImages.inspect).toBe('undefined');
    await userEvent.click(canvas.getByRole('button', { name: sourcesTexts.generateReferenceImage }));
    const dialog = await screen.findByRole('dialog', { name: sourcesTexts.createReferenceImage });
    await expect(await within(dialog).findByText(sourcesTexts.referenceSupportsRestartRequired)).toBeVisible();
    await expect(within(dialog).getByRole('textbox', { name: sourcesTexts.referenceImagePrompt })).toBeVisible();
    await expect(within(dialog).getByRole('button', { name: sourcesTexts.generateReferenceImage })).toBeDisabled();
    await expect(within(dialog).queryByRole('button', { name: sourcesTexts.referenceSupportsRetry })).not.toBeInTheDocument();
    const summary = within(dialog).getByRole('button', { name: (name) => name.startsWith(sourcesTexts.referenceSupports) });
    await userEvent.click(summary);
    await expect(within(dialog).getByRole('button', { name: sourcesTexts.referenceSupportsRetry })).toBeDisabled();
    await expect(referencePageInspection()).toMatchObject({ creates: [], generations: 0, sessions: [] });
    await userEvent.click(within(dialog).getByRole('button', { name: commonTexts.cancel }));
    await expect(screen.queryByRole('dialog', { name: sourcesTexts.createReferenceImage })).not.toBeInTheDocument();
    await expect(canvas.getByRole('textbox', { name: sourcesTexts.idea })).toHaveValue(REFERENCE_PAGE_DRAFT_IDEA);
    await expect(canvas.getByRole('textbox', { name: sourcesTexts.lyrics })).toHaveValue(REFERENCE_PAGE_DRAFT_LYRICS);
    await expect(canvas.getByRole('textbox', { name: sourcesTexts.entityDescription })).toHaveValue(REFERENCE_PAGE_SHARED_DESCRIPTION);
    await expect(canvas.getByRole('button', { name: commonTexts.save })).toBeEnabled();
    await expect(referencePageSnapshot()).toEqual(before);
    await expect(referencePageInspection()).toMatchObject({ creates: [], generations: 0, sessions: [] });
    // Возврат оставляет пользователя в доступном поле: черновик можно прочитать и скопировать перед перезапуском.
    await userEvent.click(canvas.getByRole('textbox', { name: sourcesTexts.entityDescription }));
    await expect(canvas.getByRole('textbox', { name: sourcesTexts.entityDescription })).toHaveFocus();
  }
};

/** Фон проверяется кликом по контейнеру MUI вне Paper: это тот же путь закрытия, что и у настоящего backdrop. */
async function preserveSourceDialog(dialog: HTMLElement, verify: () => Promise<void>): Promise<void> {
  await expectImplicitCloseBlocked(dialog, verify);
}

export const GenerationExplicitCancellation: Story = {
  tags: ['ci'],
  name: 'Генерация — Esc и фон сохраняют черновик, опоры и кандидата на странице',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    const idea = await canvas.findByRole('textbox', { name: sourcesTexts.idea });
    await userEvent.clear(idea);
    await userEvent.type(idea, REFERENCE_PAGE_DRAFT_IDEA);
    await userEvent.click(canvas.getByRole('button', { name: new RegExp(REFERENCE_PAGE_NAME) }));
    const before = referencePageSnapshot();
    await userEvent.click(canvas.getByRole('button', { name: sourcesTexts.generateReferenceImage }));
    const dialog = await screen.findByRole('dialog', { name: sourcesTexts.createReferenceImage });
    const local = within(dialog);
    await userEvent.click(local.getByRole('button', { name: (name) => name.startsWith(sourcesTexts.referenceSupports) }));
    const supportName = sourcesTexts.referenceUseImage({ label: 'Спереди' });
    await waitFor(() => expect(local.getByRole('checkbox', { name: supportName })).toBeEnabled());
    await userEvent.click(local.getByRole('checkbox', { name: supportName }));
    const draft = local.getByRole('textbox', { name: sourcesTexts.referenceImagePrompt });
    await userEvent.clear(draft);
    await userEvent.type(draft, 'Несохранённый промпт страницы без опор.');
    await preserveSourceDialog(dialog, async () => {
      await expect(local.getByRole('textbox', { name: sourcesTexts.referenceImagePrompt })).toHaveValue('Несохранённый промпт страницы без опор.');
      await expect(local.getByRole('checkbox', { name: supportName })).not.toBeChecked();
      await expect(referencePageInspection()).toMatchObject({ creates: [], generations: 0, closes: [] });
    });
    await waitFor(() => expect(local.getByRole('button', { name: sourcesTexts.generateReferenceImage })).toBeEnabled());
    await userEvent.click(local.getByRole('button', { name: sourcesTexts.generateReferenceImage }));
    const confirmation = await screen.findByRole('dialog', { name: sourcesTexts.confirmPromptTitle });
    await userEvent.click(within(confirmation).getByRole('button', { name: sourcesTexts.generateReferenceImage }));
    await waitFor(() => expect(local.getByRole('button', { name: sourcesTexts.accept })).toBeEnabled());
    const candidate = referencePageInspection().sessions[0];
    await preserveSourceDialog(dialog, async () => {
      await expect(local.getByRole('img', { name: REFERENCE_PAGE_NAME })).toBeVisible();
      await expect(local.getByRole('button', { name: sourcesTexts.accept })).toBeEnabled();
      await expect(referencePageInspection().sessions[0]).toEqual(candidate);
      await expect(referencePageInspection()).toMatchObject({ closes: [], generations: 1 });
    });
    await userEvent.click(local.getByRole('button', { name: commonTexts.cancel }));
    await waitFor(() => expect(referencePageInspection().closes).toEqual([candidate.id]));
    await expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await expect(canvas.getByRole('textbox', { name: sourcesTexts.idea })).toHaveValue(REFERENCE_PAGE_DRAFT_IDEA);
    await expect(referencePageSnapshot()).toEqual(before);
    await userEvent.click(canvas.getByRole('button', { name: sourcesTexts.generateReferenceImage }));
    const reopened = await screen.findByRole('dialog', { name: sourcesTexts.createReferenceImage });
    await expect(within(reopened).getByRole('textbox', { name: sourcesTexts.referenceImagePrompt })).not.toHaveValue('Несохранённый промпт страницы без опор.');
    await expect(within(reopened).getByRole('button', { name: sourcesTexts.accept })).toBeDisabled();
  }
};

export const GenerationWaitingExplicitCancellation: Story = {
  tags: ['ci'],
  name: 'Генерация — ожидание на странице закрывается только явной отменой',
  parameters: { songframe: referencePageOptions('sources', { generating: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(await canvas.findByRole('button', { name: new RegExp(REFERENCE_PAGE_NAME) }));
    const before = referencePageSnapshot();
    await userEvent.click(canvas.getByRole('button', { name: sourcesTexts.generateReferenceImage }));
    const dialog = await screen.findByRole('dialog', { name: sourcesTexts.createReferenceImage });
    const local = within(dialog);
    await waitFor(() => expect(local.getByRole('button', { name: sourcesTexts.generateReferenceImage })).toBeEnabled());
    await userEvent.click(local.getByRole('button', { name: sourcesTexts.generateReferenceImage }));
    const confirmation = await screen.findByRole('dialog', { name: sourcesTexts.confirmPromptTitle });
    await userEvent.click(within(confirmation).getByRole('button', { name: sourcesTexts.generateReferenceImage }));
    await waitFor(() => expect(referencePageInspection().sessions[0]?.status).toBe('generating'));
    const session = referencePageInspection().sessions[0];
    await preserveSourceDialog(dialog, async () => {
      await expect(local.getByRole('status')).toBeVisible();
      await expect(referencePageInspection().sessions[0]).toEqual(session);
      await expect(referencePageInspection()).toMatchObject({ closes: [], generations: 1 });
    });
    await userEvent.click(local.getByRole('button', { name: commonTexts.cancel }));
    await waitFor(() => expect(referencePageInspection().closes).toEqual([session.id]));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(referencePageSnapshot()).toEqual(before);
    // Возврат фокуса проверяется до нового действия; затем поле даёт прочитать или скопировать описание.
    await waitFor(() => expect(canvas.getByRole('button', { name: sourcesTexts.generateReferenceImage })).toHaveFocus());
    await userEvent.click(canvas.getByRole('textbox', { name: sourcesTexts.entityDescription }));
    await expect(canvas.getByRole('textbox', { name: sourcesTexts.entityDescription })).toHaveFocus();
  }
};

export const NewKindExplicitCancellation: Story = {
  tags: ['ci'],
  name: 'Новый тип — Esc и фон сохраняют три поля до явной отмены',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(await canvas.findByRole('button', { name: sourcesTexts.addKind }));
    const dialog = await screen.findByRole('dialog', { name: sourcesTexts.newKind });
    const local = within(dialog);
    await userEvent.type(local.getByRole('textbox', { name: commonTexts.label }), 'Машина героя');
    await userEvent.clear(local.getByRole('textbox', { name: commonTexts.code }));
    await userEvent.type(local.getByRole('textbox', { name: commonTexts.code }), 'hero_car');
    await userEvent.type(local.getByRole('textbox', { name: sourcesTexts.kindDirectory }), 'hero-cars');
    const before = referencePageSnapshot();
    await preserveSourceDialog(dialog, async () => {
      await expect(local.getByRole('textbox', { name: commonTexts.label })).toHaveValue('Машина героя');
      await expect(local.getByRole('textbox', { name: commonTexts.code })).toHaveValue('hero_car');
      await expect(local.getByRole('textbox', { name: sourcesTexts.kindDirectory })).toHaveValue('hero-cars');
      await expect(referencePageSnapshot()).toEqual(before);
    });
    await userEvent.click(local.getByRole('button', { name: commonTexts.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.queryByText('Машина героя · hero-cars/')).not.toBeInTheDocument();
    await expect(referencePageSnapshot()).toEqual(before);
    await userEvent.click(canvas.getByRole('button', { name: sourcesTexts.addKind }));
    const reopened = await screen.findByRole('dialog', { name: sourcesTexts.newKind });
    for (const name of [commonTexts.label, commonTexts.code, sourcesTexts.kindDirectory])
      await expect(within(reopened).getByRole('textbox', { name })).toHaveValue('');
  }
};

export const PreviewAndProtectedRemoval: Story = {
  name: 'Изображения — просмотр и запрет удаления используемого без потери формы',
  tags: ['ci'],
  parameters: { songframe: referencePageOptions('sources', { multipleImages: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      screen = within(canvasElement.ownerDocument.body);
    await canvas.findByRole('textbox', { name: sourcesTexts.idea });
    await userEvent.click(canvas.getByRole('button', { name: new RegExp(REFERENCE_PAGE_NAME) }));
    const description = canvas.getByRole('textbox', { name: sourcesTexts.entityDescription });
    await userEvent.clear(description);
    await userEvent.type(description, 'Несохранённая внешность');
    await userEvent.click(canvas.getByRole('button', { name: (name) => name.startsWith(sourcesTexts.pickReferenceImages({ name: REFERENCE_PAGE_NAME })) }));
    const previews = canvas.getAllByRole('button', { name: /^Открыть крупно/ });
    await userEvent.click(previews[0]);
    let gallery = await screen.findByRole('dialog');
    await userEvent.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}');
    await expect(within(gallery).getByRole('img')).toHaveAttribute('src', window.api.shell.fileUrl(REFERENCE_PAGE_UPLOAD));
    await userEvent.click(within(gallery).getByRole('button', { name: commonTexts.close }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(previews[0]).toHaveFocus();
    await userEvent.click(canvas.getByRole('button', { name: sourcesTexts.removeReferenceImage({ view: 'Спереди' }) }));
    gallery = await screen.findByRole('dialog');
    await userEvent.click(within(gallery).getByRole('button', { name: commonTexts.delete }));
    await within(description.closest<HTMLElement>('[id$="-details"]')!).findByText(/Используют: Механик/);
    await waitFor(() => expect(canvas.getAllByRole('button', { name: /^Открыть крупно/ })).toHaveLength(4));
    await expect(description).toHaveValue('Несохранённая внешность');
    await expect(referencePageSnapshot().sourceSaves).toBe(0);
    // Неиспользуемый вид удаляется отдельно; выбранные кастингом остаются на месте.
    await userEvent.click(canvas.getByRole('button', { name: sourcesTexts.removeReferenceImage({ view: 'Сзади' }) }));
    gallery = await screen.findByRole('dialog');
    await userEvent.click(within(gallery).getByRole('button', { name: commonTexts.delete }));
    await waitFor(() => expect(canvas.getAllByRole('button', { name: /^Открыть крупно/ })).toHaveLength(3));
    await expect(description).toHaveValue('Несохранённая внешность');
    description.focus();
  }
};
export const RemovalReadFailure: Story = {
  name: 'Удаление — ошибка чтения кастинга сохраняет референс и черновик',
  tags: ['ci'],
  parameters: { songframe: referencePageOptions('sources', { failCastRead: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      screen = within(canvasElement.ownerDocument.body);
    await canvas.findByRole('textbox', { name: sourcesTexts.idea });
    await userEvent.click(canvas.getByRole('button', { name: new RegExp(REFERENCE_PAGE_NAME) }));
    const description = canvas.getByRole('textbox', { name: sourcesTexts.entityDescription });
    await userEvent.type(description, ' Черновик');
    await userEvent.click(canvas.getByRole('button', { name: sourcesTexts.removeReference({ name: REFERENCE_PAGE_NAME }) }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: commonTexts.delete }));
    await within(description.closest<HTMLElement>('[id$="-details"]')!).findByText(/Не удалось проверить использование изображений/);
    await expect((description as HTMLTextAreaElement).value).toContain('Черновик');
    await waitFor(() => expect(canvas.getByRole('button', { name: /^Открыть крупно/ })).toBeInTheDocument());
    await expect(referencePageSnapshot().sourceSaves).toBe(0);
    description.focus();
  }
};
export const ExternalGenerationSupport: Story = {
  name: 'Референс — прикреплённая опора не добавляется в исходники',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      screen = within(canvasElement.ownerDocument.body);
    await canvas.findByRole('textbox', { name: sourcesTexts.idea });
    await userEvent.click(canvas.getByRole('button', { name: new RegExp(REFERENCE_PAGE_NAME) }));
    await userEvent.click(canvas.getByRole('button', { name: sourcesTexts.generateReferenceImage }));
    const dialog = await screen.findByRole('dialog', { name: sourcesTexts.createReferenceImage });
    const local = within(dialog);
    await userEvent.click(local.getByRole('button', { name: (name) => name.startsWith(sourcesTexts.referenceSupports) }));
    await userEvent.click(local.getByRole('button', { name: (name) => name.startsWith(sourcesTexts.additionalSupports) }));
    await expect(
      await local.findByRole('checkbox', { name: sourcesTexts.referenceUseImage({ label: sourcesTexts.additionalSupportLabel({ name: 'story-image.png' }) }) })
    ).toBeChecked();
    await waitFor(() => expect(local.getByRole('button', { name: sourcesTexts.generateReferenceImage })).toBeEnabled());
    await userEvent.click(local.getByRole('button', { name: sourcesTexts.generateReferenceImage }));
    const confirmation = await screen.findByRole('dialog', { name: sourcesTexts.confirmPromptTitle });
    await expect(referencePageInspection().creates[0].input?.images.map((image) => image.path)).toEqual([
      `${IMAGE_STORY_PROJECT}/source/${REFERENCE_PAGE_SAVED}`,
      REFERENCE_PAGE_UPLOAD
    ]);
    await userEvent.click(within(confirmation).getByRole('button', { name: sourcesTexts.generateReferenceImage }));
    await waitFor(() => expect(local.getByRole('button', { name: sourcesTexts.accept })).toBeEnabled());
    await userEvent.click(local.getByRole('button', { name: sourcesTexts.accept }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.getAllByRole('button', { name: /^Открыть крупно/ })).toHaveLength(2);
    await expect(referencePageSnapshot().manifest.references[0].files).toHaveLength(1);
    await expect(referencePageSnapshot().sourceSaves).toBe(0);
    canvas.getByRole('textbox', { name: sourcesTexts.entityDescription }).focus();
  }
};
export const CoverReferenceSelection: Story = {
  name: 'Обложка — выбор референса из формы без автоматических опор',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      screen = within(canvasElement.ownerDocument.body);
    await canvas.findByRole('textbox', { name: sourcesTexts.idea });
    await userEvent.click(canvas.getByRole('button', { name: sourcesTexts.generateCover }));
    const dialog = await screen.findByRole('dialog', { name: sourcesTexts.createCover });
    const local = within(dialog);
    await userEvent.click(local.getByRole('button', { name: (name) => name.startsWith(sourcesTexts.coverSupports) }));
    for (const checkbox of local.getAllByRole('checkbox')) await expect(checkbox).not.toBeChecked();
    await userEvent.click(local.getByRole('checkbox', { name: sourcesTexts.referenceUseImage({ label: 'Чужая локация · В полный рост' }) }));
    await waitFor(() => expect(local.getByRole('button', { name: sourcesTexts.generateCover })).toBeEnabled());
    await userEvent.click(local.getByRole('button', { name: sourcesTexts.generateCover }));
    const confirmation = await screen.findByRole('dialog', { name: sourcesTexts.confirmPromptTitle });
    await expect(referencePageInspection().creates[0]).toMatchObject({
      mode: 'cover',
      input: { images: [{ path: `${IMAGE_STORY_PROJECT}/source/locations/garden/story-image.png`, label: 'Чужая локация · В полный рост' }] }
    });
    await expect(within(confirmation).getByText('Чужая локация · В полный рост')).toBeInTheDocument();
    await userEvent.click(within(confirmation).getByRole('button', { name: commonTexts.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: sourcesTexts.confirmPromptTitle })).not.toBeInTheDocument());
    await userEvent.click(local.getByRole('button', { name: commonTexts.cancel }));
    await expect(referencePageSnapshot().sourceSaves).toBe(0);
  }
};

/** Смена типа сохранённого референса: перед сохранением видно, переедут ли изображения в папку нового типа. */
async function changeHeroKind(canvasElement: HTMLElement, label: string, open = true): Promise<void> {
  const canvas = within(canvasElement);
  const screen = within(canvasElement.ownerDocument.body);
  if (open) await userEvent.click(await canvas.findByRole('button', { name: new RegExp(REFERENCE_PAGE_NAME) }));
  await userEvent.click(await canvas.findByRole('combobox', { name: commonTexts.type }));
  await userEvent.click(await screen.findByRole('option', { name: label }));
}

export const KindChangeMovesFiles: Story = {
  name: 'Тип референса — смена переносит изображения в папку нового типа',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await changeHeroKind(canvasElement, 'Локация');
    await expect(await canvas.findByText(sourcesTexts.kindMovesFiles({ dir: 'locations' }))).toBeVisible();
    await changeHeroKind(canvasElement, 'Персонаж', false);
    await waitFor(() => expect(canvas.queryByText(sourcesTexts.kindMovesFiles({ dir: 'locations' }))).not.toBeInTheDocument());
  }
};

export const PinnedKindChangeKeepsFiles: Story = {
  name: 'Тип референса — при готовых материалах изображения остаются на месте',
  parameters: { songframe: referencePageOptions('sources', { pinnedReferences: { hero: ['M01', 'M02'] } }) },
  play: async ({ canvasElement }) => {
    await changeHeroKind(canvasElement, 'Локация');
    const notice = sourcesTexts.kindKeepsFiles({ dir: REFERENCE_PAGE_SAVED.slice(0, REFERENCE_PAGE_SAVED.lastIndexOf('/')), shots: ['M01', 'M02'] });
    await expect(await within(canvasElement).findByText(notice)).toBeVisible();
  }
};

export const TrackPlayback: Story = {
  name: 'Трек — общий плеер с громкостью вместо встроенного',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const play = await canvas.findByRole('button', { name: commonTexts.player.play });
    const audio = canvasElement.querySelector('audio');
    // Встроенные элементы WebKitGTK не регулируют громкость: страница показывает общий плеер.
    await expect(audio).not.toHaveAttribute('controls');
    await expect(canvas.getByRole('slider', { name: commonTexts.player.volume })).toBeInTheDocument();
    await expect(canvas.getByRole('slider', { name: commonTexts.player.position })).toBeInTheDocument();
    await userEvent.click(play);
    await waitFor(() => expect(audio?.paused).toBe(false), { timeout: 10000 });
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.player.pause }));
    await waitFor(() => expect(audio?.paused).toBe(true));
  }
};
