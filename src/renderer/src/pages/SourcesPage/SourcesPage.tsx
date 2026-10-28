/** Исходники проекта: трек, текст песни, идея, обложка и референсы. */
import { useEffect, useRef, type ReactElement } from 'react';
import { usePageLoading } from '../../components/PageLoader';
import { Alert, Box, Button, Chip, Stack, Typography } from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import RefreshIcon from '@mui/icons-material/Refresh';
import { ActionButton } from '../../components/ActionButton';
import { PageActionBar } from '../../components/PageActionBar';
import { CoverSection, IdeaSection, LyricsSection, ReferenceKindDialog, ReferencesSection, TrackSection } from './components';
import { useSourcesForm } from './useSourcesForm';
import { CoverGenerateDialog } from './components/CoverGenerateDialog';
import { LinkedText } from '../../components/LinkedText';

export function SourcesPage(): ReactElement {
  const form = useSourcesForm();
  const problemsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Файл, брошенный мимо области загрузки, не должен открыться вместо приложения.
    const preventNavigation = (event: DragEvent): void => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    };
    window.addEventListener('dragover', preventNavigation);
    window.addEventListener('drop', preventNavigation);
    return () => {
      window.removeEventListener('dragover', preventNavigation);
      window.removeEventListener('drop', preventNavigation);
    };
  }, []);

  // Пока данные страницы не готовы, общий прелоадер оболочки показывает индикатор.
  usePageLoading(!form.view && !form.loadError);
  if (form.loadError)
    return (
      <Alert
        severity="error"
        action={
          <Button startIcon={<RefreshIcon />} onClick={form.retry}>
            Повторить
          </Button>
        }
      >
        <LinkedText text={form.loadError} />
      </Alert>
    );

  if (!form.view) return <></>;

  // Проверка сервера включает разбор текста песни с задержкой; локальный разбор показывает его ошибки сразу.
  const problems = [...new Set([...form.problems, ...form.lyricsCheck.problems])];
  const problemCount = problems.length + (form.hasPromptErrors ? 1 : 0);
  const saveBlockedReason = form.busy
    ? null
    : form.hasPromptErrors
      ? 'Не удалось прочитать некоторые промпты референсов: восстановите файлы или введите текст заново.'
      : problems.length
        ? `Исправьте проблемы формы (${problems.length}): список — в начале страницы, ошибки отмечены у полей.`
        : !form.dirty
          ? 'Нет несохранённых правок.'
          : null;

  return (
    <Stack spacing={2} inert={form.busy || undefined} aria-busy={form.busy} sx={{ width: '100%', minWidth: 0, pb: 10 }}>
      <PageActionBar>
        <Typography variant="h5">Исходники</Typography>
        {form.dirty ? <Chip size="small" color="warning" label="Есть несохранённые правки" /> : null}
        {problemCount ? (
          <Chip
            size="small"
            color="warning"
            label={`Проблем: ${problemCount}`}
            // Список проблем стоит в начале страницы, а правка обычно идёт в карточке ниже.
            onClick={() => problemsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
          />
        ) : null}
        <Box sx={{ flex: 1 }} />
        <ActionButton
          variant="contained"
          startIcon={<SaveIcon />}
          disabled={form.busy || !!saveBlockedReason}
          disabledReason={form.busy ? 'Дождитесь окончания текущей операции.' : saveBlockedReason}
          onClick={form.save}
        >
          Сохранить
        </ActionButton>
      </PageActionBar>
      {form.view.problems.length ? (
        <Alert severity="error">
          <LinkedText text={form.view.problems.join(' ')} />
        </Alert>
      ) : null}
      {problemCount ? (
        <Stack ref={problemsRef} spacing={1}>
          {form.hasPromptErrors ? (
            <Alert severity="warning">
              Не удалось прочитать некоторые промпты. Раскройте отмеченные референсы и восстановите файл либо введите текст заново.
            </Alert>
          ) : null}
          {problems.length ? (
            <Alert severity="warning">
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {problems.map((problem) => (
                  <li key={problem}>
                    <LinkedText text={problem} />
                  </li>
                ))}
              </ul>
            </Alert>
          ) : null}
        </Stack>
      ) : null}
      {/* Референсы занимают отдельную колонку только при достаточной ширине рабочей области. */}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr)',
          alignItems: 'start',
          gap: 2,
          '@container workspace (min-width: 1600px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
          '& > *': { minWidth: 0 }
        }}
      >
        <Stack spacing={2} sx={{ minWidth: 0 }}>
          {/* Внутренние карточки ориентируются на свою колонку, а не на ширину всего окна. */}
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))',
              gap: 2,
              '& > *': { minWidth: 0 }
            }}
          >
            <TrackSection {...form.trackProps} />
            <CoverSection {...form.coverProps} />
          </Box>
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))',
              gap: 2,
              '& > *': { minWidth: 0 }
            }}
          >
            <LyricsSection {...form.lyricsProps} />
            <IdeaSection {...form.ideaProps} />
          </Box>
        </Stack>
        <ReferencesSection {...form.referencesProps} />
      </Box>
      <ReferenceKindDialog {...form.kindDialogProps} />
      {form.coverGenerationProps.open ? <CoverGenerateDialog {...form.coverGenerationProps} /> : null}
    </Stack>
  );
}
