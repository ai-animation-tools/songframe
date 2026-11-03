import { useState, type ComponentProps, type ReactElement } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import CheckIcon from '@mui/icons-material/Check';
import { derivedShotTexts as texts } from '@shared/texts/derived-shot';
import { derivedMainTexts } from '@shared/texts/derived-shot-main';
import { derivedPreview } from '../../../testing/derivedStories';
import { ConfirmationDialog } from '../../../components/ConfirmationDialog';
import { DerivedShotPreview } from './DerivedShotPreview';

type PreviewProps = ComponentProps<typeof DerivedShotPreview>;

/** Изолированная проба показывает явную приёмку и отменяемое подтверждение замены; задания показывает панель. */
function PreviewDemo(args: PreviewProps): ReactElement {
  const [accepted, setAccepted] = useState(args.preview.accepted);
  const [confirmation, setConfirmation] = useState(false);
  const accept = (): void => {
    setAccepted(true);
    setConfirmation(false);
  };
  return (
    <>
      <DerivedShotPreview
        {...args}
        preview={{ ...args.preview, accepted }}
        hasAsset={args.hasAsset || accepted}
        disabledReason={accepted ? texts.alreadyAccepted : args.disabledReason}
        onAccept={() => (args.hasAsset ? setConfirmation(true) : accept())}
      />
      <ConfirmationDialog
        open={confirmation}
        title={texts.replaceTitle}
        description={texts.replaceDescription({ shot: 'M02' })}
        confirmLabel={texts.replace}
        confirmIcon={<CheckIcon />}
        confirmColor="error"
        onClose={() => setConfirmation(false)}
        onConfirm={accept}
      />
    </>
  );
}

const meta = {
  title: 'Производство/Производный план/Предпросмотр',
  component: DerivedShotPreview,
  render: (args) => <PreviewDemo {...args} />,
  args: { preview: derivedPreview(), hasAsset: false, disabledReason: null, onAccept: () => {} },
  parameters: { controls: { disable: true }, songframe: {} }
} satisfies Meta<typeof DerivedShotPreview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Fresh: Story = { name: 'Свежая проба · отдельная приёмка' };
export const Replace: Story = { name: 'Замена · подтвердить или отменить', args: { hasAsset: true } };
export const Stale: Story = {
  name: 'Устаревшая проба · просмотр доступен',
  args: { preview: derivedPreview({ fresh: false, problem: derivedMainTexts.previewStale }), disabledReason: derivedMainTexts.previewStale }
};
export const Accepted: Story = {
  name: 'Проба уже принята',
  args: { preview: derivedPreview({ accepted: true }), hasAsset: true, disabledReason: texts.alreadyAccepted }
};
export const Hold: Story = { name: 'Стоп-кадр · фраза об удержании', args: { preview: derivedPreview({ recipe: { mode: 'still', frame: 12 } }) } };
