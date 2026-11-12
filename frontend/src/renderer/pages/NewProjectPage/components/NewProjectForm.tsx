import { projectsTexts } from '@shared/texts/projects';
import type { ReactElement } from 'react';
import { Box, MenuItem, Paper, TextField } from '@mui/material';
import { FRAME_RATES } from '@shared/video';
import { slugify } from '../helpers';
import type { NewProjectValues } from '../useNewProjectForm';
import { NewProjectFolderField } from './NewProjectFolderField';
import { NewProjectProblems } from './NewProjectProblems';

interface NewProjectFormProps {
  values: NewProjectValues;
  changeField: (field: keyof NewProjectValues, value: string) => void;
  pickParent: () => Promise<void>;
  problems: string[];
  touched: boolean;
}

/** Форма объединяет параметры проекта и показывает результат проверки перед созданием через API. */
export function NewProjectForm({ values, changeField, pickParent, problems, touched }: NewProjectFormProps): ReactElement {
  const { name, path, video, fps } = values;
  const slug = slugify(name);

  return (
    <Paper variant="outlined" sx={{ p: 3 }}>
      {/* Поля делят строку на широком экране; действия страницы закреплены в общей панели. */}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr)',
          '@container workspace (min-width: 1100px)': { gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.5fr)' },
          gap: 2.5,
          '& > *': { minWidth: 0 }
        }}
      >
        <TextField
          label={projectsTexts.clipName}
          value={name}
          onChange={(event) => changeField('name', event.target.value)}
          autoFocus
          helperText={projectsTexts.nameHelp}
        />
        <NewProjectFolderField value={path} onChange={(value) => changeField('path', value)} onPickParent={pickParent} />
        <TextField
          label={projectsTexts.animaticName}
          value={video}
          onChange={(event) => changeField('video', event.target.value)}
          placeholder={`${slug || 'animatic'}${slug ? '-animatic' : ''}.mp4`}
          helperText={projectsTexts.animaticNameHelp}
        />
        <TextField
          select
          label={projectsTexts.frameRate}
          value={fps}
          onChange={(event) => changeField('fps', event.target.value)}
          helperText={projectsTexts.frameRateHelp}
        >
          {FRAME_RATES.map((rate) => (
            <MenuItem key={rate} value={String(rate)}>
              {projectsTexts.frameRateOption(rate)}
            </MenuItem>
          ))}
        </TextField>
        {touched && problems.length ? (
          <Box sx={{ gridColumn: '1 / -1' }}>
            <NewProjectProblems problems={problems} />
          </Box>
        ) : null}
      </Box>
    </Paper>
  );
}
