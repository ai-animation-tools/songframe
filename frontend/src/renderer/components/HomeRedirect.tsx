/** Стартовый переход к последнему проекту либо выбору папки. */
import { commonTexts } from '@shared/texts/common';
import type { ReactElement } from 'react';
import { Navigate } from 'react-router-dom';
import { Box, CircularProgress } from '@mui/material';
import { useApp } from '../state';

export function HomeRedirect(): ReactElement {
  const { state, loading } = useApp();
  if (loading || !state)
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', mt: 8 }}>
        <CircularProgress aria-label={commonTexts.appLoading} />
      </Box>
    );
  return <Navigate to={state.current ? '/project' : '/projects'} replace />;
}
