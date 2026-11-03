import { useState, type ComponentProps, type ReactElement } from 'react';
import { Alert, Stack, Typography } from '@mui/material';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { derivedShotTexts as texts } from '@shared/texts/derived-shot';
import { derivedView } from '../../../testing/derivedStories';
import { derivedActionReasons, recipeDraft, recipeInfo } from '../derivedRecipeForm';
import { DerivedRecipeFields } from './DerivedRecipeFields';

type FieldsProps = ComponentProps<typeof DerivedRecipeFields>;

/** Поля остаются управляемыми; ошибки и расчёт скорости берутся из рабочих функций формы. */
function RecipeDemo(args: FieldsProps): ReactElement {
  const [draft, change] = useState(args.draft);
  const view = derivedView({ sourceFrames: args.sourceFrames });
  const reasons = derivedActionReasons(view, draft, false);
  return (
    <Stack spacing={2}>
      <Typography variant="body2">{texts.sourceFrames({ frames: view.sourceFrames })}</Typography>
      <Typography variant="body2">{texts.targetFrames({ frames: view.targetFrames })}</Typography>
      <DerivedRecipeFields {...args} draft={draft} onChange={change} />
      {reasons.shapeProblem ? <Alert severity="warning">{reasons.shapeProblem}</Alert> : null}
      {reasons.boundsProblem ? <Alert severity="warning">{reasons.boundsProblem}</Alert> : null}
      {reasons.recipe && !reasons.boundsProblem ? <Typography>{recipeInfo(reasons.recipe, view.targetFrames)}</Typography> : null}
    </Stack>
  );
}

const meta = {
  title: 'Производство/Производный план/Поля рецепта',
  component: DerivedRecipeFields,
  render: (args) => <RecipeDemo {...args} />,
  args: { draft: recipeDraft(null), disabled: false, sourceFrames: 150, onChange: () => {} },
  parameters: { controls: { disable: true }, songframe: {} }
} satisfies Meta<typeof DerivedRecipeFields>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ChooseMode: Story = { name: 'Явный выбор способа' };
export const Trim: Story = { name: 'Обрезка · 92 кадра без изменения скорости', args: { draft: recipeDraft({ mode: 'trim', start_frame: 10 }) } };
export const Fit: Story = {
  name: 'Подгонка скоростью · коэффициент 0.500',
  args: { draft: recipeDraft({ mode: 'fit', start_frame: 0, end_frame_exclusive: 46 }) }
};
export const Still: Story = { name: 'Стоп-кадр · удержание 92 кадра', args: { draft: recipeDraft({ mode: 'still', frame: 12 }) } };
export const Repeat: Story = {
  name: 'Повтор · 3 цикла и хвост 2 кадра',
  args: { draft: recipeDraft({ mode: 'repeat', start_frame: 0, end_frame_exclusive: 30 }) }
};
export const EmptyFrame: Story = { name: 'Пустое поле не становится нулём', args: { draft: { mode: 'trim', start: '', end: '', frame: '0' } } };
export const FractionalFrame: Story = { name: 'Дробный кадр · ошибка формы', args: { draft: { mode: 'still', start: '0', end: '', frame: '1.5' } } };
export const OutOfBounds: Story = { name: 'Фрагмент выходит за источник', args: { draft: recipeDraft({ mode: 'trim', start_frame: 100 }) } };
export const ReversedInterval: Story = { name: 'Конец участка раньше начала', args: { draft: { mode: 'repeat', start: '35', end: '30', frame: '0' } } };
