/** Переход между настоящими страницами использует общую локальную модель и заново читает сохранённые документы. */
import { Stack } from '@mui/material';
import AudiotrackIcon from '@mui/icons-material/Audiotrack';
import GroupsIcon from '@mui/icons-material/Groups';
import { useLocation, useNavigate } from 'react-router-dom';
import { ActionButton } from '../components/ActionButton';
import { SourcesPage } from '../pages/SourcesPage';
import { CastPage } from '../pages/CastPage';

export function ReferencePagesJourney() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }} aria-label="Переход между страницами в истории">
        <ActionButton startIcon={<AudiotrackIcon />} onClick={() => navigate('/project/sources')}>
          Открыть исходники
        </ActionButton>
        <ActionButton startIcon={<GroupsIcon />} onClick={() => navigate('/project/cast?entity=hero')}>
          Открыть кастинг
        </ActionButton>
      </Stack>
      {location.pathname.endsWith('/cast') ? <CastPage /> : <SourcesPage />}
    </Stack>
  );
}
