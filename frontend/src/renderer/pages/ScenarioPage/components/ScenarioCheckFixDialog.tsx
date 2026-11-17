import { scenarioTexts } from '@shared/texts/scenario';
import { commonTexts } from '@shared/texts/common';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Alert, FormControlLabel, LinearProgress, Radio, RadioGroup, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import type { ScenarioCheckFixPreview } from '@shared/scenario-workflow';
import { ConfirmationDialog } from '../../../components/ConfirmationDialog';
import { LinkedText } from '../../../components/LinkedText';
import { useApp } from '../../../state';

const texts = scenarioTexts.check.dialog;

/**
 * Окно «Исправить сценарий»: правки выбранных проблем проверки («Сейчас» → «Станет») и принятые планы, которые
 * они задевают напрямую или через наследование. По каждому принятому плану пользователь решает, переснять его
 * или оставить принятым, потому что видео уже соответствует исправленным записям. По умолчанию — переснять:
 * так же поступает обычное сохранение постановки. Окно ничего не пишет само: запись выполняет onApply.
 */
export function ScenarioCheckFixDialog({
  issues,
  stale,
  busy,
  load,
  onApply,
  onClose
}: {
  /** Номера проблем отчёта; null — окно закрыто. */
  issues: number[] | null;
  /** Отчёт устарел: текущие значения могут отличаться от тех, что видел агент. */
  stale: boolean;
  busy: boolean;
  load(issues: number[]): Promise<ScenarioCheckFixPreview>;
  onApply(issues: number[], keep: string[]): void;
  onClose(): void;
}): ReactElement {
  const { describeError } = useApp();
  const [preview, setPreview] = useState<ScenarioCheckFixPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keep, setKeep] = useState<string[]>([]);
  // load меняется при каждой отрисовке страницы; окно перечитывает правки только для нового набора проблем.
  const loader = useRef(load);
  loader.current = load;
  const key = issues?.join(',') ?? null;
  useEffect(() => {
    setPreview(null);
    setError(null);
    setKeep([]);
    if (key === null) return;
    let active = true;
    loader.current(key.split(',').map(Number)).then(
      (next) => active && setPreview(next),
      (reason: unknown) => active && setError(describeError(reason))
    );
    return () => {
      active = false;
    };
  }, [key, describeError]);
  const value = (text: string | null, removed = false): ReactElement => (
    <Typography variant="body2" color={text === null ? 'text.secondary' : undefined} sx={{ overflowWrap: 'anywhere' }}>
      {text ?? (removed ? texts.removed : texts.noValue)}
    </Typography>
  );
  return (
    <ConfirmationDialog
      open={issues !== null}
      title={texts.title}
      maxWidth="md"
      contentLabel={texts.changes}
      onClose={onClose}
      onConfirm={() => issues && onApply(issues, keep)}
      confirmLabel={texts.apply}
      confirmIcon={<AutoFixHighIcon />}
      confirmDisabled={busy || !preview}
      confirmDisabledReason={busy ? commonTexts.operationPending : !preview ? (error ?? texts.loading) : null}
      cancelDisabled={busy}
      cancelDisabledReason={commonTexts.operationPending}
      closeDisabled={busy}
    >
      <Stack spacing={2} sx={{ mt: 1 }}>
        {stale && <Alert severity="warning">{texts.stale}</Alert>}
        {error && (
          <Alert severity="error">
            <LinkedText text={error} />
          </Alert>
        )}
        {!preview && !error && (
          <Stack spacing={1}>
            <Typography variant="body2" color="text.secondary">
              {texts.loading}
            </Typography>
            <LinearProgress />
          </Stack>
        )}
        {preview && (
          <>
            <Typography variant="subtitle2" component="h3">
              {texts.changes}
            </Typography>
            <Table size="small" aria-label={texts.changes}>
              <TableHead>
                <TableRow>
                  <TableCell>{texts.shot}</TableCell>
                  <TableCell>{texts.phase}</TableCell>
                  <TableCell>{texts.entity}</TableCell>
                  <TableCell>{texts.property}</TableCell>
                  <TableCell>{texts.current}</TableCell>
                  <TableCell>{texts.value}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {preview.changes.map((change) => (
                  <TableRow key={`${change.shot}:${change.phase}:${change.entity}:${change.property}`}>
                    <TableCell>{change.shot}</TableCell>
                    <TableCell>{texts.phases[change.phase]}</TableCell>
                    <TableCell>{change.entityName}</TableCell>
                    <TableCell>{change.propertyLabel}</TableCell>
                    <TableCell>{value(change.current)}</TableCell>
                    <TableCell>{value(change.value, true)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Typography variant="body2" color="text.secondary">
              {texts.inherit}
            </Typography>
            {preview.accepted.length > 0 && (
              <Alert severity="warning" icon={false}>
                <Stack spacing={1.5}>
                  <Stack spacing={0.5}>
                    <Typography variant="subtitle2" component="h3">
                      {texts.acceptedTitle}
                    </Typography>
                    <Typography variant="body2">{texts.acceptedHint}</Typography>
                  </Stack>
                  {preview.accepted.map((shot) => (
                    <Stack key={shot.id} spacing={0.5}>
                      <Typography variant="body2" fontWeight={600} id={`check-fix-${shot.id}`}>
                        {shot.id} · {shot.direct ? texts.direct : texts.inherited}
                      </Typography>
                      <RadioGroup
                        row
                        aria-labelledby={`check-fix-${shot.id}`}
                        value={keep.includes(shot.id) ? 'keep' : 'reshoot'}
                        onChange={(event) =>
                          setKeep((current) => (event.target.value === 'keep' ? [...current, shot.id] : current.filter((id) => id !== shot.id)))
                        }
                      >
                        <FormControlLabel value="reshoot" control={<Radio size="small" />} label={texts.reshoot} disabled={busy} />
                        <FormControlLabel value="keep" control={<Radio size="small" />} label={texts.keep} disabled={busy} />
                      </RadioGroup>
                      <Typography variant="caption" color="text.secondary">
                        {keep.includes(shot.id) ? texts.keepHint : texts.reshootHint}
                      </Typography>
                    </Stack>
                  ))}
                </Stack>
              </Alert>
            )}
            {preview.stale.length > 0 && <Alert severity="info">{texts.stalePlans({ shots: preview.stale })}</Alert>}
          </>
        )}
      </Stack>
    </ConfirmationDialog>
  );
}
