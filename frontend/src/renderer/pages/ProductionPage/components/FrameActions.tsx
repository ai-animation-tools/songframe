import { productionTexts } from '@shared/texts/production';
/**
 * Действия одной опоры на её карточке: создать следующую по порядку или поставить свой файл.
 * Файл сразу становится кандидатом; утверждение остаётся отдельным вопросом шага. Опору своего описания без промпта
 * создать нечем: кнопка создания недоступна с причиной, остаётся свой файл.
 */
import { useState, type ReactElement } from 'react';
import EditNoteIcon from '@mui/icons-material/EditNote';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import { Button, Stack, TextField } from '@mui/material';
import type { ProductionFrameCandidate, ProductionWorkflowView } from '@shared/production-workflow';
import type { KeyframeNoteScope, PackageKeyframe } from '@shared/types';
import { useApp } from '../../../state';
import { ActionButton } from '../../../components/ActionButton';
import { BUSY_REASON } from '../constants';
import { KeyframeNoteScopeField } from './KeyframeNoteScopeField';
import { ProductionFrameGenerationButton } from './ProductionFrameGenerationButton';

/** Необязательное указание к опоре перед её созданием. */
export interface FrameInstruction {
  note: string;
  scope: KeyframeNoteScope;
}

export function FrameActions({
  frame,
  view,
  busy,
  onGenerate,
  onImport
}: {
  frame: PackageKeyframe;
  view: ProductionWorkflowView;
  busy: boolean;
  onGenerate(instruction?: FrameInstruction): void;
  onImport(images: ProductionFrameCandidate[]): Promise<boolean>;
}): ReactElement | null {
  const { notify, describeError } = useApp();
  const [instructionOpen, setInstructionOpen] = useState(false);
  const [note, setNote] = useState('');
  const [scope, setScope] = useState<KeyframeNoteScope>('frame');
  if (frame.approved) return null;
  const replacing = view.replaceFrame === frame.id;
  const available = replacing || view.canGenerateFrames;
  const reason = busy ? BUSY_REASON : !available ? (view.reasons.frames ?? productionTexts.productionWorkflowPanel.descriptionRequired) : null;
  // Пустой промпт бывает только у своего описания; опоры вне плана опор кнопки создания не получают и без этой проверки.
  const framePrompt = view.framePrompts.find((prompt) => prompt.id === frame.id);
  const hasPrompt = !framePrompt || framePrompt.prompt.trim() !== '';
  const generateReason = busy
    ? BUSY_REASON
    : !view.canGenerateFrames
      ? view.reasons.frames
      : !hasPrompt
        ? productionTexts.frameActions.noPrompt({ id: frame.id })
        : null;
  const choose = async (): Promise<void> => {
    try {
      const files = await window.api.dialog.pickFiles({
        title: productionTexts.frameActions.title({ id: frame.id }),
        multiple: false,
        filters: [{ name: productionTexts.frameActions.images, extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
      });
      if (files[0]) await onImport([{ id: frame.id, path: files[0] }]);
    } catch (reason) {
      notify(describeError(reason), 'error');
    }
  };
  return (
    <Stack spacing={0.5} sx={{ mt: 0.5, alignItems: 'flex-start' }}>
      {view.nextFrame === frame.id && !replacing && hasPrompt && instructionOpen ? (
        <Stack spacing={1} sx={{ alignSelf: 'stretch' }}>
          <TextField
            label={productionTexts.frameActions.instruction}
            multiline
            fullWidth
            minRows={2}
            maxRows={6}
            autoFocus
            disabled={busy}
            helperText={productionTexts.frameActions.instructionHint}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <KeyframeNoteScopeField scope={scope} onChange={setScope} disabled={busy} />
        </Stack>
      ) : null}
      {view.nextFrame === frame.id && !replacing ? (
        <ProductionFrameGenerationButton
          provider={view.imageProvider}
          disabled={busy || !view.canGenerateFrames || !hasPrompt}
          disabledReason={generateReason}
          frame={frame.id}
          title={productionTexts.productionWorkflowPanel.frameHint({ nextFrame: frame.id })}
          onGenerate={() => {
            const text = note.trim();
            setNote('');
            setInstructionOpen(false);
            onGenerate(text ? { note: text, scope } : undefined);
          }}
        />
      ) : null}
      {view.nextFrame === frame.id && !replacing && hasPrompt && !instructionOpen ? (
        <Button size="small" startIcon={<EditNoteIcon />} disabled={busy} onClick={() => setInstructionOpen(true)}>
          {productionTexts.frameActions.instructionOpen}
        </Button>
      ) : null}
      <ActionButton startIcon={<FolderOpenIcon />} size="small" disabled={busy || !available} disabledReason={reason} onClick={() => void choose()}>
        {frame.imagePath ? productionTexts.frameActions.other : productionTexts.frameActions.own}
      </ActionButton>
    </Stack>
  );
}
