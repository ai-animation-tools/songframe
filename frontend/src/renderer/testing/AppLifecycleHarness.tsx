import { useState } from 'react';
import { Box } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import CloseIcon from '@mui/icons-material/Close';
import { useNavigate } from 'react-router-dom';
import { App, type AppProps } from '../App';
import { ActionButton } from '../components/ActionButton';

/** Подписи принадлежат стенду Storybook и не попадают в пользовательские страницы приложения. */
export const lifecycleTexts = { mount: 'Смонтировать приложение', unmount: 'Размонтировать приложение' };

/** Стенд удаляет всё дерево App, включая Workspace, TimingPage и MediaPlayer.
 * Тема и маршрутизатор истории живут снаружи, а повторное монтирование начинает новый сеанс с проектов.
 */
export function AppLifecycleHarness(props: AppProps) {
  const [mounted, setMounted] = useState(true);
  const navigate = useNavigate();
  return (
    <>
      <Box sx={{ position: 'fixed', bottom: 8, right: 8, zIndex: 1600 }}>
        <ActionButton
          variant="contained"
          startIcon={mounted ? <CloseIcon /> : <RefreshIcon />}
          onClick={() => {
            if (!mounted) navigate('/projects');
            setMounted(!mounted);
          }}
        >
          {mounted ? lifecycleTexts.unmount : lifecycleTexts.mount}
        </ActionButton>
      </Box>
      {mounted && <App {...props} />}
    </>
  );
}
