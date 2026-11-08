import { useEffect, useState } from 'react';
import { Box, LinearProgress } from '@mui/material';
import { shellTexts } from '@shared/texts/shell';

/** Короткое чтение состояния не мигает прелоадером; таймер принадлежит одному монтированию и очищается при выходе. */
export function StartupProgress() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 150);
    return () => clearTimeout(timer);
  }, []);
  return visible ? (
    <Box role="status" aria-label={shellTexts.loading}>
      <LinearProgress />
    </Box>
  ) : null;
}
