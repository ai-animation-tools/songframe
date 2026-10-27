/** Создание проекта: название, полный путь новой папки, имя MP4; папка создаётся из шаблона, Git используется при наличии. */

import { type ReactElement, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Stack, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import { PageActionBar } from '../../components/PageActionBar';
import { useApp } from '../../state';
import { NewProjectForm } from './components';
import { useNewProjectForm } from './useNewProjectForm';

export function NewProjectPage(): ReactElement {
  const { refresh, notify, describeError, state } = useApp();
  const navigate = useNavigate();
  const form = useNewProjectForm(describeError);
  const [busy, setBusy] = useState(false);

  const create = async (): Promise<void> => {
    if (busy || !form.ready) return;
    setBusy(true);
    const { name, path, video } = form.values;
    try {
      const status = await window.api.projects.create({ name: name.trim(), path: path.trim(), animaticVideo: video.trim() || undefined });
      await refresh();
      notify(`Проект «${status.name}» создан`, 'success');
      navigate('/project/sources');
    } catch (error) {
      notify(describeError(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack spacing={2} inert={busy || undefined} aria-busy={busy} sx={{ width: '100%', minWidth: 0 }}>
      <PageActionBar>
        <Typography variant="h5" sx={{ flex: 1 }}>
          Новый проект
        </Typography>
        <Button startIcon={<CloseIcon />} onClick={() => navigate('/projects')}>
          Отмена
        </Button>
        <Button variant="contained" color="success" startIcon={<AddIcon />} disabled={!form.ready || busy || !state?.toolsRoot} onClick={create}>
          Создать
        </Button>
      </PageActionBar>
      {!state?.toolsRoot ? <Alert severity="error">Ресурсы приложения не найдены, шаблон проекта недоступен. Подробности на странице «Среда».</Alert> : null}
      <NewProjectForm {...form} />
      <Typography variant="body2" color="text.secondary">
        После создания откроется страница исходников: трек, текст песни, идея клипа, обложка и референсы.
      </Typography>
    </Stack>
  );
}
