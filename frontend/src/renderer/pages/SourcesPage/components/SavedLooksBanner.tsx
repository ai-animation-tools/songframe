/** Плашка над референсами: зачем нужны сохранённые образы провайдера видео и сколько их в аккаунте. */
import type { ReactElement } from 'react';
import { Alert, AlertTitle, Stack, Typography } from '@mui/material';
import { mediaProviderTitle } from '@shared/media-providers';
import type { SavedLooksView } from '@shared/saved-looks';
import { savedLooksTexts } from '@shared/texts/saved-looks';
import { HelpArticleLink } from '../../../components/HelpArticleLink';
import { LinkedText } from '../../../components/LinkedText';
import { ANCHORS } from '../../../components/linkTargets';

interface Props {
  view: SavedLooksView | null;
  loading: boolean;
  /** Сбой самого вызова (нет связи с Go); сбой списка аккаунта приходит в view.error. */
  loadError: string | null;
}

export function SavedLooksBanner({ view, loading, loadError }: Props): ReactElement | null {
  if (loadError) return <Alert severity="warning">{savedLooksTexts.unknownStatuses({ reason: loadError })}</Alert>;
  // Провайдер видео без образов: плашки нет, остальная страница не меняется.
  if (!view?.supported) return null;
  return (
    <Stack spacing={1}>
      <Alert severity="info">
        <AlertTitle>{savedLooksTexts.bannerTitle}</AlertTitle>
        <Typography variant="body2">
          {savedLooksTexts.banner({ provider: mediaProviderTitle(view.provider) })}{' '}
          {view.report ? `${savedLooksTexts.accountCount({ count: view.report.count })} ` : null}
          <HelpArticleLink article={ANCHORS.helpSavedLooks}>{savedLooksTexts.helpLink}</HelpArticleLink>
        </Typography>
        {loading ? (
          <Typography variant="body2" role="status" sx={{ mt: 0.5 }}>
            {savedLooksTexts.loading}
          </Typography>
        ) : null}
      </Alert>
      {view.error ? (
        <Alert severity="warning">
          <LinkedText text={savedLooksTexts.unknownStatuses({ reason: view.error })} />
        </Alert>
      ) : null}
    </Stack>
  );
}
