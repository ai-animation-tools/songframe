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
