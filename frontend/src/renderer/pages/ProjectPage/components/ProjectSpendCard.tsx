/**
 * Расход клипа на странице «Проект»: суммы по всем планам в единицах своего источника с числом
 * планов, заметные списки планов без цены и с неизвестным списанием (ссылки на план на
 * «Производстве», где цену указывают в окне «Расход») и счётчики видео и опор. Данные —
 * production.projectSpend по журналу расхода; перечитываются при обновлении состояния проекта.
 */
import { type ReactElement, useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Alert, Box, Link, Paper, Stack, Typography } from '@mui/material';
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong';
import { projectTexts } from '@shared/texts/project';
import type { ProjectSpend } from '@shared/types';
import { shotPageRoute } from '../../../components/shotRoutes';
import { spendAmount, spendSource } from '../../../components/SpendChips';
import { useApp } from '../../../state';

const texts = projectTexts.spend;

/** Планы ссылками на их карточку на «Производстве». */
function ShotLinks({ shots }: { shots: string[] }): ReactElement {
  return (
    <>
      {shots.map((shot, index) => (
        <span key={shot}>
          {index ? ', ' : ''}
          <Link component={RouterLink} to={shotPageRoute('production', shot)}>
            {shot}
          </Link>
        </span>
      ))}
    </>
  );
}

export function ProjectSpendCard({ project, version }: { project: string; version: unknown }): ReactElement {
  const { describeError } = useApp();
  const [spend, setSpend] = useState<ProjectSpend | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    window.api.production
      .projectSpend(project)
      .then((next) => {
        if (active) {
          setSpend(next);
          setError(null);
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(texts.loadFailed({ reason: describeError(reason) }));
      });
    return () => {
      active = false;
    };
  }, [project, version, describeError]);

  const empty = spend && !spend.totals.length && !spend.unpriced.length && !spend.unknown.length;
  return (
    <Paper variant="outlined" sx={{ p: 2 }} data-testid="project-spend">
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }} title={texts.hint}>
        <ReceiptLongIcon color="action" />
        <Typography variant="subtitle1" fontWeight={600} component="h2">
          {texts.title}
        </Typography>
      </Box>
      {error ? <Alert severity="error">{error}</Alert> : null}
      {empty ? (
        <Typography variant="body2" color="text.secondary">
          {texts.empty}
        </Typography>
      ) : null}
      {spend && !empty ? (
        <Stack spacing={1}>
          {spend.totals.map((total) => (
            <Typography key={`${total.provider ?? ''}:${total.unit ?? ''}`} variant="body1" fontWeight={600}>
              {texts.total({ amount: spendAmount(total), source: spendSource(total.provider), shots: total.shots.length })}
            </Typography>
          ))}
          {spend.unpriced.length || spend.unknown.length ? (
            <Alert severity="warning">
              {spend.unpriced.length ? (
                <Box title={texts.unpricedHint}>
                  {texts.unpriced}: <ShotLinks shots={spend.unpriced} />
                </Box>
              ) : null}
              {spend.unknown.length ? (
                <Box title={texts.unknownHint}>
                  {texts.unknown}: <ShotLinks shots={spend.unknown} />
                </Box>
              ) : null}
              <Box>{texts.incomplete}</Box>
            </Alert>
          ) : null}
          <Typography variant="body2" color="text.secondary">
            {texts.counts(spend)}
          </Typography>
        </Stack>
      ) : null}
    </Paper>
  );
}
