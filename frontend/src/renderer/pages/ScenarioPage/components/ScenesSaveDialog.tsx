import { scenarioTexts } from '@shared/texts/scenario';
import { commonTexts } from '@shared/texts/common';
import { useEffect, useState, type ReactElement } from 'react';
import { Box, Chip, FormControlLabel, List, ListItem, Radio, RadioGroup, Typography } from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import SaveAsIcon from '@mui/icons-material/SaveAs';
import { ConfirmationDialog } from '../../../components/ConfirmationDialog';
import { LinkedText } from '../../../components/LinkedText';
import { SHOT_STATE_LABELS } from '../../../components/shotState';
import type { ScenesSaveRequest } from '../types';

const BUSY_REASON = scenarioTexts.save.wait;
const choice = scenarioTexts.check.dialog;

const TEXTS = {
  production: {
    title: scenarioTexts.save.productionTitle,
    description: scenarioTexts.save.productionDescription(),
    confirm: commonTexts.save
  },
  keep: {
    title: scenarioTexts.save.keepTitle,
    description: scenarioTexts.save.keepDescription(),
    confirm: scenarioTexts.toolbar.saveWithoutProduction
  }
} as const;

/**
 * Подтверждение сохранения сценария, которое меняет постановку планов с принятым комплектом или пакетом. При обычном
 * сохранении по каждому такому плану выбирается «Переснять» (по умолчанию) или «Оставить принятым»: правка части
 * задевает все её планы, но видео части из них может уже подходить. Выбор передаётся в onConfirm списком keep.
 */
export function ScenesSaveDialog({
  request,
  busy,
  onConfirm,
  onClose
}: {
  request: ScenesSaveRequest | null;
  busy: boolean;
  /** keep — принятые планы, которые остаются принятыми; в режиме «без производства» список пуст. */
  onConfirm(keep: string[]): void;
  onClose(): void;
}): ReactElement {
  const texts = TEXTS[request?.mode ?? 'production'];
  const choosing = request?.mode === 'production';
  const [keep, setKeep] = useState<string[]>([]);
  // Новый расчёт — новый выбор: прежнее решение не переносится на другой черновик.
  useEffect(() => setKeep([]), [request]);
  return (
    <ConfirmationDialog
      open={!!request}
      title={texts.title}
      description={texts.description}
      onClose={onClose}
      onConfirm={() => onConfirm(choosing ? keep : [])}
      confirmLabel={texts.confirm}
      confirmIcon={request?.mode === 'keep' ? <SaveAsIcon /> : <SaveIcon />}
      confirmColor={request?.mode === 'keep' ? 'primary' : 'warning'}
      confirmDisabled={busy}
      confirmDisabledReason={BUSY_REASON}
      cancelDisabled={busy}
      cancelDisabledReason={BUSY_REASON}
      closeDisabled={busy}
      contentLabel={scenarioTexts.save.affectedShotsRegion}
    >
      {/* Список берётся только из расчёта Go: формальные связи постановки, без догадок о смысле правки. */}
      <Typography variant="subtitle2" sx={{ mt: 2 }}>
        {scenarioTexts.save.affectedShots({ count: request?.shots.length ?? 0 })}
      </Typography>
      {choosing && request?.shots.some((shot) => shot.produced) ? (
        <Typography variant="body2" color="text.secondary">
          {scenarioTexts.save.choiceHint}
        </Typography>
      ) : null}
      {/* Длинный список прокручивается вместе с содержимым диалога: одна область прокрутки вместо вложенной. */}
      <List dense disablePadding>
        {(request?.shots ?? []).map((shot) => {
          const state = SHOT_STATE_LABELS[shot.state];
          const kept = keep.includes(shot.id);
          return (
            <ListItem key={shot.id} disableGutters sx={{ alignItems: 'flex-start', gap: 1 }}>
              <Typography variant="body2" fontWeight={700} id={`scenes-save-${shot.id}`} sx={{ fontFamily: 'monospace', minWidth: 48, flexShrink: 0 }}>
                {shot.id}
              </Typography>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body2">
                  <LinkedText text={shot.reason} />
                </Typography>
                {choosing && shot.produced ? (
                  <>
                    <RadioGroup
                      row
                      aria-labelledby={`scenes-save-${shot.id}`}
                      value={kept ? 'keep' : 'reshoot'}
                      onChange={(event) =>
                        setKeep((current) => (event.target.value === 'keep' ? [...current, shot.id] : current.filter((id) => id !== shot.id)))
                      }
                    >
                      <FormControlLabel value="reshoot" control={<Radio size="small" />} label={choice.reshoot} disabled={busy} />
                      <FormControlLabel value="keep" control={<Radio size="small" />} label={choice.keep} disabled={busy} />
                    </RadioGroup>
                    <Typography variant="caption" color="text.secondary">
                      {kept ? scenarioTexts.save.keepHint : choice.reshootHint}
                    </Typography>
                  </>
                ) : null}
              </Box>
              <Chip size="small" color={state.color} label={state.label} sx={{ flexShrink: 0 }} />
            </ListItem>
          );
        })}
      </List>
    </ConfirmationDialog>
  );
}
