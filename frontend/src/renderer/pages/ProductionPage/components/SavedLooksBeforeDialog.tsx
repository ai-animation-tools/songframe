/**
 * Вопрос перед описанием плана («Подготовить описание» или «Написать самому»): модель плана держит облик героя по
 * сохранённому образу, а у части сущностей «В кадре» образа нет или образов больше, чем модель примет. У попытки
 * «По референсам» облик остальных держат картинки шага «Референсы», у попытки по опорам — опоры. Отсутствие образа
 * не блокирует: пользователь переходит к референсу на «Исходниках» или продолжает без образа. При избытке образов перед
 * агентом пользователь отмечает, чей облик держать образом (персонажи отмечены первыми), и продолжение передаёт выбор
 * агенту; своё описание пишет сам человек — окно только говорит, сколько меток поставить.
 */
import { useEffect, useId, useState, type ReactElement } from 'react';
import { Alert, Box, Button, Checkbox, FormControlLabel, FormGroup, Stack, Typography } from '@mui/material';
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
  /** looks — отмеченные герои, если выбор был (агент и question.choose не пуст). */
  onContinue(looks?: string[]): void;
  onClose(): void;
}): ReactElement {
  const listId = useId();
  const chooseId = useId();
  // Новый вопрос — новый выбор по умолчанию: первые по пределу модели (персонажи стоят первыми).
  const [chosen, setChosen] = useState<string[]>([]);
  useEffect(() => {
    setChosen(question ? question.choose.slice(0, question.limit).map((hero) => hero.code) : []);
  }, [question]);
  const choosing = agent && !!question?.choose.length;
  const over = choosing && chosen.length > question.limit;
  return (
    <ConfirmationDialog
      open={!!question}
      title={savedLooksTexts.beforeTitle}
      confirmLabel={question?.without.length ? savedLooksTexts.beforeContinueWithout : savedLooksTexts.beforeContinue}
      confirmAgent={agent ? {} : undefined}
      confirmDisabled={over}
      confirmDisabledReason={over ? savedLooksTexts.beforeChooseOver({ limit: question.limit }) : undefined}
      onConfirm={() => onContinue(choosing ? question.choose.filter((hero) => chosen.includes(hero.code)).map((hero) => hero.code) : undefined)}
      onClose={onClose}
    >
      {question ? (
        <Stack spacing={2} sx={{ mt: 1 }}>
          {question.without.length ? (
            <Alert severity="warning">
              <Typography variant="body2">
                {(question.references ? savedLooksTexts.beforeWithoutReferences : savedLooksTexts.beforeWithout)({ model: question.model })}
              </Typography>
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
          {question.choose.length && !choosing ? (
            <Alert severity="info">{savedLooksTexts.beforeOver({ model: question.model, limit: question.limit, count: question.choose.length })}</Alert>
          ) : null}
          {choosing ? (
            <Alert severity={over ? 'warning' : 'info'}>
              <Typography variant="body2">
                {(question.references ? savedLooksTexts.beforeChooseReferences : savedLooksTexts.beforeChoose)({
                  model: question.model,
                  limit: question.limit,
                  count: question.choose.length
                })}
              </Typography>
              <Typography id={chooseId} component="h3" variant="subtitle2" sx={{ mt: 1.5 }}>
                {savedLooksTexts.beforeChooseLabel} · {savedLooksTexts.beforeChosen({ count: chosen.length, limit: question.limit })}
              </Typography>
              <FormGroup aria-labelledby={chooseId}>
                {question.choose.map((hero) => (
                  <FormControlLabel
                    key={hero.code}
                    label={hero.name}
                    control={
                      <Checkbox
                        size="small"
                        checked={chosen.includes(hero.code)}
                        onChange={(event) =>
                          setChosen((current) => (event.target.checked ? [...current, hero.code] : current.filter((code) => code !== hero.code)))
                        }
                      />
                    }
                  />
                ))}
              </FormGroup>
            </Alert>
          ) : null}
        </Stack>
      ) : null}
    </ConfirmationDialog>
  );
}
