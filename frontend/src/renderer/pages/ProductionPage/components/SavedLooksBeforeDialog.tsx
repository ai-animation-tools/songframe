/**
 * Вопрос перед описанием плана («Подготовить описание» или «Написать самому»): модель плана держит облик героя по
 * сохранённому образу, а у части сущностей «В кадре» образа нет или образов больше, чем модель примет. Это не
 * блокировка: пользователь переходит к референсу на «Исходниках» или продолжает без образа.
 */
import { useId, type ReactElement } from 'react';
import { Alert, Box, Button, Stack, Typography } from '@mui/material';
import FaceRetouchingNaturalOutlinedIcon from '@mui/icons-material/FaceRetouchingNaturalOutlined';
import type { DescriptionLooksQuestion } from '@shared/saved-looks';
import { savedLooksTexts } from '@shared/texts/saved-looks';
import { ConfirmationDialog } from '../../../components/ConfirmationDialog';

export function SavedLooksBeforeDialog({
  question,
  agent,
  onOpenReference,
  onContinue,
  onClose
}: {
  question: DescriptionLooksQuestion | null;
  /** Продолжение запускает агента описания: кнопка подтверждения — кнопка агента. */
  agent: boolean;
  /** Переход к референсу сущности на «Исходниках»; окно закрывает вызывающий. */
  onOpenReference(code: string): void;
  onContinue(): void;
  onClose(): void;
}): ReactElement {
  const listId = useId();
  return (
    <ConfirmationDialog
      open={!!question}
      title={savedLooksTexts.beforeTitle}
      confirmLabel={question?.without.length ? savedLooksTexts.beforeContinueWithout : savedLooksTexts.beforeContinue}
      confirmAgent={agent ? {} : undefined}
      onConfirm={onContinue}
      onClose={onClose}
    >
      {question ? (
        <Stack spacing={2} sx={{ mt: 1 }}>
          {question.without.length ? (
            <Alert severity="warning">
              <Typography variant="body2">{savedLooksTexts.beforeWithout({ model: question.model })}</Typography>
              <Typography id={listId} component="h3" variant="subtitle2" sx={{ mt: 1.5 }}>
                {savedLooksTexts.beforeWithoutLabel}
              </Typography>
              <Box component="ul" aria-labelledby={listId} sx={{ m: 0, pl: 2.5 }}>
                {question.without.map((hero) => (
                  <Box component="li" key={hero.code} sx={{ py: 0.5 }}>
                    <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                      <Typography variant="body2">
                        {hero.name} — {savedLooksTexts.status[hero.status]}
                      </Typography>
                      <Button
                        size="small"
                        variant="outlined"
                        startIcon={<FaceRetouchingNaturalOutlinedIcon />}
                        aria-label={`${savedLooksTexts.openFromCast}: ${hero.name}`}
                        onClick={() => onOpenReference(hero.code)}
                      >
                        {savedLooksTexts.openFromCast}
                      </Button>
                    </Stack>
                  </Box>
                ))}
              </Box>
            </Alert>
          ) : null}
          {question.over ? (
            <Alert severity="info">{savedLooksTexts.beforeOver({ model: question.model, limit: question.limit, count: question.over })}</Alert>
          ) : null}
        </Stack>
      ) : null}
    </ConfirmationDialog>
  );
}
