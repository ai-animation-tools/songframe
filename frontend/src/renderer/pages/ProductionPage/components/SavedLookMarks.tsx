/**
 * Кнопки меток героев над полем своего видеопромпта: герои «В кадре» плана, у которых есть сохранённый образ.
 * Кнопка вставляет метку [@код] в позицию курсора; ID образа пользователь не вводит. Провайдер видео без образов —
 * блока нет. Статусы приходят одним бесплатным списком аккаунта (window.api.savedLooks.shot) при открытии окна.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { Alert, Box, Button, Stack, Tooltip, Typography } from '@mui/material';
import FaceRetouchingNaturalOutlinedIcon from '@mui/icons-material/FaceRetouchingNaturalOutlined';
import type { ShotLooksView } from '@shared/saved-looks';
import { savedLooksTexts } from '@shared/texts/saved-looks';
import { LinkedText } from '../../../components/LinkedText';
import { useApp } from '../../../state';

export function SavedLookMarks({ project, shot, onInsert }: { project: string; shot: string; onInsert(code: string): void }): ReactElement | null {
  const { describeError } = useApp();
  const [view, setView] = useState<ShotLooksView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    window.api.savedLooks.shot(project, shot).then(
      (result) => current && setView(result),
      (reason: unknown) => current && setError(describeError(reason))
    );
    return () => {
      current = false;
    };
  }, [project, shot, describeError]);
  if (error) return <Alert severity="warning">{savedLooksTexts.unknownStatuses({ reason: error })}</Alert>;
  if (!view)
    return (
      <Typography variant="body2" color="text.secondary" role="status">
        {savedLooksTexts.marksLoading}
      </Typography>
    );
  if (!view.supported) return null;
  if (view.error)
    return (
      <Alert severity="warning">
        <LinkedText text={savedLooksTexts.unknownStatuses({ reason: view.error })} />
      </Alert>
    );
  const heroes = view.heroes.filter((hero) => hero.status === 'ready' || hero.status === 'stale');
  return (
    <Stack spacing={1} component="section" aria-label={savedLooksTexts.marksTitle}>
      <Typography variant="subtitle2">{savedLooksTexts.marksTitle}</Typography>
      {heroes.length ? (
        <>
          <Typography variant="body2" color="text.secondary">
            {savedLooksTexts.marksHint}
          </Typography>
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            {heroes.map((hero) => (
              <Tooltip key={hero.code} title={savedLooksTexts.statusHint[hero.status]} describeChild>
                <Button
                  size="small"
                  variant="outlined"
                  color={hero.status === 'stale' ? 'warning' : 'primary'}
                  startIcon={<FaceRetouchingNaturalOutlinedIcon />}
                  aria-label={savedLooksTexts.markLabel({ name: hero.name })}
                  onClick={() => onInsert(hero.code)}
                >
                  {hero.name}
                </Button>
              </Tooltip>
            ))}
          </Box>
        </>
      ) : (
        <Typography variant="body2" color="text.secondary">
          {savedLooksTexts.marksNone}
        </Typography>
      )}
    </Stack>
  );
}
