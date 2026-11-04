/**
 * Создание проекта: название, полный путь новой папки, имя MP4; папка создаётся из шаблона, Git используется при наличии.
 * Отличие от 634fd94: шаблон встроен в Go-приложение (50.1), поэтому создание не зависит от корня комплекса (toolsRoot).
 */

import { projectsTexts } from '@shared/texts/projects';
import { commonTexts } from '@shared/texts/common';
import { navigationTexts } from '@shared/texts/navigation';
import { type ReactElement, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Stack, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import { ActionButton } from '../../components/ActionButton';
import { PageActionBar } from '../../components/PageActionBar';
import { useApp } from '../../state';
import { NewProjectForm } from './components';
import { useNewProjectForm } from './useNewProjectForm';

export function NewProjectPage(): ReactElement {
  const { refresh, notify, describeError } = useApp();
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
      notify(projectsTexts.created({ name: status.name }), 'success');
      navigate('/project/sources');
    } catch (error) {
      notify(describeError(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  // Причина недоступности «Создать» по ветвям её условия; проблемы формы перечислены у полей.
  const { name, path } = form.values;
  const createReason = busy
    ? projectsTexts.creating
    : !name.trim()
      ? projectsTexts.nameRequired
      : !path.trim()
        ? projectsTexts.folderRequired
        : form.problems.length
          ? projectsTexts.formProblems
          : projectsTexts.validating;

  return (
    <Stack spacing={2} inert={busy || undefined} aria-busy={busy} sx={{ width: '100%', minWidth: 0 }}>
      <PageActionBar>
        <Typography variant="h5" sx={{ flex: 1 }}>
          {navigationTexts.pages.newProject}
        </Typography>
        <Button startIcon={<CloseIcon />} onClick={() => navigate('/projects')}>
          {commonTexts.cancel}
        </Button>
        <ActionButton variant="contained" color="success" startIcon={<AddIcon />} disabled={!form.ready || busy} disabledReason={createReason} onClick={create}>
          {commonTexts.create}
        </ActionButton>
      </PageActionBar>
      <NewProjectForm {...form} />
      <Typography variant="body2" color="text.secondary">
        {projectsTexts.afterCreation}
      </Typography>
    </Stack>
  );
}
