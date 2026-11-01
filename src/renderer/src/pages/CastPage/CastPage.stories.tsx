/** Настоящая страница состава передаёт привязки выбранной сущности в общий диалог генерации. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { castTexts } from '@shared/texts/cast';
import { commonTexts } from '@shared/texts/common';
import { ReferencePagesJourney } from '../../testing/ReferencePagesJourney';
import { sourcesTexts } from '@shared/texts/sources';
import { IMAGE_STORY_PROJECT, IMAGE_STORY_STYLE } from '../../testing/imageStories';
import {
  REFERENCE_PAGE_NAME,
  REFERENCE_PAGE_NOTE,
  REFERENCE_PAGE_PROFILE_NOTE,
  REFERENCE_PAGE_SAVED,
  REFERENCE_PAGE_PROFILE,
  REFERENCE_PAGE_BACK,
  REFERENCE_PAGE_SHARED_DESCRIPTION,
  REFERENCE_PAGE_SAVE_ERROR,
  referencePageSnapshot,
  referencePageInspection,
  referencePageOptions
} from '../../testing/referencePageStories';
import { CastPage } from './CastPage';

const meta = { title: 'Страницы/Состав', component: CastPage, tags: ['!autodocs'], parameters: { songframe: referencePageOptions('cast') } } satisfies Meta<
  typeof CastPage
>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ReferenceIdentity: Story = {
  tags: ['ci'],
  name: 'Референс — внешность и опоры сохранённой сущности',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: sourcesTexts.generateReferenceImage }));
    const screen = within(canvasElement.ownerDocument.body);
    const dialog = await screen.findByRole('dialog', { name: sourcesTexts.createReferenceImage });
    for (const label of [sourcesTexts.referenceSupports, sourcesTexts.referenceConstructor]) {
      const summary = within(dialog).getByRole('button', { name: (name) => name.startsWith(label) });
      await expect(summary).toHaveAttribute('aria-expanded', 'false');
      await userEvent.click(summary);
    }
    await expect(within(dialog).getByRole<HTMLTextAreaElement>('textbox', { name: sourcesTexts.referenceImagePrompt }).value).toContain(
      'Красная куртка, тёмные волосы.'
    );
    await expect(within(dialog).getAllByRole('img')).toHaveLength(1);
    const draft = within(dialog).getByRole<HTMLTextAreaElement>('textbox', { name: sourcesTexts.referenceImagePrompt });
    await waitFor(() => {
      if (within(dialog).getByRole<HTMLInputElement>('checkbox', { name: sourcesTexts.referenceVisualStyle }).disabled)
        throw new Error('Контекст ещё читается.');
    });
    await expect(draft.value).not.toContain(IMAGE_STORY_STYLE);
    await expect(within(dialog).getByRole('checkbox', { name: sourcesTexts.referenceVisualStyle })).not.toBeChecked();
    await expect(within(dialog).getByRole('checkbox', { name: sourcesTexts.referenceIdea })).not.toBeChecked();
    await expect(within(dialog).getByRole('checkbox', { name: sourcesTexts.referenceLyrics })).not.toBeChecked();
    await waitFor(() => expect(within(dialog).getByRole('button', { name: sourcesTexts.generateReferenceImage })).toBeEnabled());
    await userEvent.click(within(dialog).getByRole('button', { name: sourcesTexts.generateReferenceImage }));
    const confirmation = await screen.findByRole('dialog', { name: sourcesTexts.confirmPromptTitle });
    const text = within(confirmation).getByRole<HTMLTextAreaElement>('textbox', { name: sourcesTexts.confirmedPrompt }).value;
    await expect(text).toContain(REFERENCE_PAGE_NAME);
    await expect(text).not.toContain('Ремонтирует ворота');
    await expect(text).not.toContain(REFERENCE_PAGE_NOTE);
    await expect(text).toContain(referencePageSnapshot().manifest.references[0].description);
    await expect(text).not.toContain(IMAGE_STORY_STYLE);
    await expect(referencePageInspection().creates[0].input).toMatchObject({
      images: [{ path: `${IMAGE_STORY_PROJECT}/source/${REFERENCE_PAGE_SAVED}`, label: 'Спереди' }]
    });
    await expect(referencePageInspection().generations).toBe(0);
  }
};

export const SupplementPreservesSelection: Story = {
  tags: ['ci'],
  name: 'Дополнение — выбранные виды, порядок и основной сохраняются',
  parameters: { songframe: referencePageOptions('cast', { multipleImages: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('textbox', { name: castTexts.appearance });
    const expected = [REFERENCE_PAGE_PROFILE, REFERENCE_PAGE_SAVED];
    await expect(referencePageSnapshot().cast.entities[0].images).toEqual(expected);
    await expect(canvas.getByTitle(REFERENCE_PAGE_PROFILE)).toHaveClass(/MuiChip-colorPrimary/);
    for (let count = 1; count <= 2; count++) {
      await userEvent.click(canvas.getByRole('button', { name: castTexts.supplement }));
      await waitFor(() => expect(referencePageSnapshot().supplements).toBe(count));
      await waitFor(() => expect(canvas.getByRole('button', { name: castTexts.supplement })).toBeEnabled());
      await expect(referencePageSnapshot().cast.entities[0].images).toEqual(expected);
      await expect(referencePageSnapshot().cast.entities[0].images).not.toContain(REFERENCE_PAGE_BACK);
      await expect(canvas.getByTitle(REFERENCE_PAGE_PROFILE)).toHaveClass(/MuiChip-colorPrimary/);
    }
    await expect(referencePageSnapshot().cast.entities.find((entity) => entity.id === 'garden')?.images).toHaveLength(1);
    await expect(referencePageInspection().generations).toBe(0);
  }
};

export const SupplementPreservesEmptySelection: Story = {
  tags: ['ci'],
  name: 'Дополнение — намеренно пустой выбор не заполняется автоматически',
  parameters: { songframe: referencePageOptions('cast', { multipleImages: true, emptySelection: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('textbox', { name: castTexts.appearance });
    await expect(canvas.getByText(castTexts.imageMissing)).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: castTexts.supplement }));
    await waitFor(() => expect(referencePageSnapshot().supplements).toBe(1));
    await expect(referencePageSnapshot().cast.entities[0].images).toEqual([]);
    await waitFor(() => expect(canvas.getByRole('button', { name: castTexts.supplement })).toBeEnabled());
    await expect(canvas.getByText(castTexts.imageMissing)).toBeInTheDocument();
  }
};

export const SharedAppearanceSaveFailure: Story = {
  tags: ['ci'],
  name: 'Общее описание — ошибка кастинга не меняет исходники',
  parameters: { songframe: referencePageOptions('cast', { failCastSaveOnce: true }) },
  render: () => <ReferencePagesJourney />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    const before = referencePageSnapshot();
    const description = await canvas.findByRole('textbox', { name: castTexts.appearance });
    await userEvent.clear(description);
    await userEvent.type(description, REFERENCE_PAGE_SHARED_DESCRIPTION);
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.save }));
    await expect(await screen.findByText(REFERENCE_PAGE_SAVE_ERROR)).toBeInTheDocument();
    await expect(description).toHaveValue(REFERENCE_PAGE_SHARED_DESCRIPTION);
    await expect(referencePageSnapshot().manifest).toEqual(before.manifest);
    await expect(referencePageSnapshot().cast).toEqual(before.cast);
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.save }));
    await expect(await screen.findByText(castTexts.saved)).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Открыть исходники' }));
    await userEvent.click(await canvas.findByRole('button', { name: new RegExp(REFERENCE_PAGE_NAME) }));
    await expect(canvas.getByRole('textbox', { name: sourcesTexts.entityDescription })).toHaveValue(REFERENCE_PAGE_SHARED_DESCRIPTION);
  }
};

export const ReferenceSupportNotes: Story = {
  tags: ['ci'],
  name: 'Примечания опор — данные исходников, выбор и порядок кастинга',
  parameters: { songframe: referencePageOptions('cast', { multipleImages: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(await canvas.findByRole('button', { name: sourcesTexts.generateReferenceImage }));
    const dialog = await screen.findByRole('dialog', { name: sourcesTexts.createReferenceImage });
    for (const label of [sourcesTexts.referenceSupports, sourcesTexts.referenceConstructor]) {
      await userEvent.click(within(dialog).getByRole('button', { name: (name) => name.startsWith(label) }));
    }
    await expect(within(dialog).getAllByRole('img')).toHaveLength(2);
    const prompt = () => within(dialog).getByRole<HTMLTextAreaElement>('textbox', { name: sourcesTexts.referenceImagePrompt }).value;
    const toggle = within(dialog).getByRole('checkbox', { name: sourcesTexts.referenceSupportNotes });
    await waitFor(() => expect(toggle).toBeEnabled());
    await expect(toggle).not.toBeChecked();
    await expect(prompt()).not.toContain(REFERENCE_PAGE_NOTE);
    await expect(prompt()).not.toContain(REFERENCE_PAGE_PROFILE_NOTE);
    await userEvent.click(toggle);
    await expect(prompt()).toContain('Опора 1 (Сбоку):\n' + REFERENCE_PAGE_PROFILE_NOTE);
    await expect(prompt()).toContain('Опора 2 (Спереди):\n' + REFERENCE_PAGE_NOTE);
    await expect(prompt()).not.toContain('Не выбирать автоматически');
    await userEvent.click(within(dialog).getByRole('checkbox', { name: sourcesTexts.referenceUseImage({ label: 'Спереди' }) }));
    await waitFor(() => expect(prompt()).toContain(REFERENCE_PAGE_PROFILE_NOTE));
    await expect(prompt()).not.toContain(REFERENCE_PAGE_NOTE);
    await waitFor(() => expect(within(dialog).getByRole('button', { name: sourcesTexts.generateReferenceImage })).toBeEnabled());
    await userEvent.click(within(dialog).getByRole('button', { name: sourcesTexts.generateReferenceImage }));
    const confirmation = await screen.findByRole('dialog', { name: sourcesTexts.confirmPromptTitle });
    const prepared = within(confirmation).getByRole<HTMLTextAreaElement>('textbox', { name: sourcesTexts.confirmedPrompt }).value;
    await expect(prepared).toContain('Опора 1 (Сбоку):\n' + REFERENCE_PAGE_PROFILE_NOTE);
    await expect(prepared).not.toContain(REFERENCE_PAGE_NOTE);
    await expect(referencePageInspection().creates[0].prompt).toBe(prepared);
    await expect(referencePageInspection().creates[0].input?.images).toMatchObject([
      { path: `${IMAGE_STORY_PROJECT}/source/${REFERENCE_PAGE_PROFILE}`, label: 'Сбоку' }
    ]);
    await expect(referencePageInspection().generations).toBe(0);
  }
};
