import { environmentTexts } from '@shared/texts/environment';
import type { ReactElement } from 'react';
import { SlottedText } from '../../../components/SlottedText';
import { Box, Button, Paper, Typography } from '@mui/material';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import ManageSearchIcon from '@mui/icons-material/ManageSearch';
import type { AppState } from '@shared/types';
import { useMethodAvailability } from '../../../availability';

interface ApplicationResourcesProps {
  state: AppState | null;
  onChooseToolsRoot: () => Promise<void>;
  onResetToolsRoot: () => Promise<void>;
}

/**
 * Выбор checkout доступен только при запуске из исходников без найденных ресурсов. Отличие от
 * 634fd94: в Go-версии шаблон, промпты и документы провайдеров встроены в бинарник, корня комплекса
 * нет (toolsRoot — null), поэтому без выбора папки страница сообщает о встроенных ресурсах.
 */
export function ApplicationResources({ state, onChooseToolsRoot, onResetToolsRoot }: ApplicationResourcesProps): ReactElement {
  const toolsRootSelectable = useMethodAvailability('app.setToolsRoot').available;
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="subtitle2" gutterBottom>
        {environmentTexts.resourcesTitle}
      </Typography>
      <Typography variant="body2" sx={{ mb: 1 }}>
        {state?.toolsRoot
          ? state.toolsRoot
          : state
            ? toolsRootSelectable
              ? environmentTexts.resourcesMissing
              : environmentTexts.resourcesEmbedded
            : environmentTexts.resourcesDetecting}
      </Typography>
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1.5 }}>
        <SlottedText text={environmentTexts.localState} slots={{ path: state?.localDir }} />
      </Typography>
      {state?.packaged ? (
        <Typography variant="body2" color="text.secondary">
          {environmentTexts.packagedResources}
        </Typography>
      ) : toolsRootSelectable && state?.packaged === false && !state.toolsRoot ? (
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          <Typography variant="body2" color="text.secondary" sx={{ width: '100%' }}>
            {environmentTexts.developmentResources}
          </Typography>
          <Button size="small" variant="outlined" startIcon={<FolderOpenIcon />} onClick={onChooseToolsRoot}>
            {environmentTexts.chooseSources}
          </Button>
          <Button size="small" startIcon={<ManageSearchIcon />} onClick={onResetToolsRoot}>
            {environmentTexts.detectSources}
          </Button>
        </Box>
      ) : null}
    </Paper>
  );
}
