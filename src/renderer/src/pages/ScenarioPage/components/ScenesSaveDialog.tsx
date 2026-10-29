/** Подтверждение сохранения реестра, которое меняет постановку планов с принятым комплектом или пакетом. */
import type { ReactElement } from 'react';
import { Box, Chip, List, ListItem, Typography } from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import SaveAsIcon from '@mui/icons-material/SaveAs';
import { ConfirmationDialog } from '../../../components/ConfirmationDialog';
import { LinkedText } from '../../../components/LinkedText';
import { SHOT_STATE_LABELS } from '../../../components/shotState';
import type { ScenesSaveRequest } from '../types';

const BUSY_REASON = 'Дождитесь завершения сохранения.';
// Аниматик собирается из реестра, поэтому пересборка нужна при любом режиме; она локальная и бесплатная.
const ANIMATIC_NOTE = 'Аниматик после сохранения потребует пересборки — это локальная операция без оплаты.';

const TEXTS = {
  production: {
    title: 'Сохранить изменения постановки?',
    description: `Сохранение меняет постановку планов ниже. Принятые из них получат статус «постановка изменена» и потребуют нового производства, а их пакеты — нового согласования. Если правка не меняет сюжет, например исправляет опечатку, выберите «Сохранить без производства». ${ANIMATIC_NOTE}`,
    confirm: 'Сохранить'
  },
  keep: {
    title: 'Сохранить без нового производства?',
    description: `Подходит для опечаток и правок, не меняющих сюжет. Принятые комплекты и пакеты перечисленных планов останутся в силе, хотя их постановка в реестре изменится. ${ANIMATIC_NOTE}`,
    confirm: 'Сохранить без производства'
  }
} as const;

export function ScenesSaveDialog({
  request,
  busy,
  onConfirm,
  onClose
}: {
  request: ScenesSaveRequest | null;
  busy: boolean;
  onConfirm(): void;
  onClose(): void;
}): ReactElement {
  const texts = TEXTS[request?.mode ?? 'production'];
  return (
    <ConfirmationDialog
      open={!!request}
      title={texts.title}
      description={texts.description}
      onClose={onClose}
      onConfirm={onConfirm}
      confirmLabel={texts.confirm}
      confirmIcon={request?.mode === 'keep' ? <SaveAsIcon /> : <SaveIcon />}
      confirmColor={request?.mode === 'keep' ? 'primary' : 'warning'}
      confirmDisabled={busy}
      confirmDisabledReason={BUSY_REASON}
      cancelDisabled={busy}
      cancelDisabledReason={BUSY_REASON}
      closeDisabled={busy}
    >
      {/* Список берётся только из расчёта главного процесса: формальные связи постановки, без догадок о смысле правки. */}
      <Typography variant="subtitle2" sx={{ mt: 2 }}>
        Затронутые планы: {request?.shots.length ?? 0}
      </Typography>
      <List dense disablePadding sx={{ maxHeight: 320, overflowY: 'auto' }}>
        {(request?.shots ?? []).map((shot) => {
          const state = SHOT_STATE_LABELS[shot.state];
          return (
            <ListItem key={shot.id} disableGutters sx={{ alignItems: 'flex-start', gap: 1 }}>
              <Typography variant="body2" fontWeight={700} sx={{ fontFamily: 'monospace', minWidth: 48, flexShrink: 0 }}>
                {shot.id}
              </Typography>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body2">
                  <LinkedText text={shot.reason} />
                </Typography>
              </Box>
              <Chip size="small" color={state.color} label={state.label} sx={{ flexShrink: 0 }} />
            </ListItem>
          );
        })}
      </List>
    </ConfirmationDialog>
  );
}
