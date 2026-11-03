/** Редактор инструкций проекта: чтение доступно всегда, изменение — выбранному агенту после подтверждения. */
import { useReducer, type ReactElement } from 'react';
import { Box, InputAdornment, Stack, TextField, Typography } from '@mui/material';
import LockOpenIcon from '@mui/icons-material/LockOpen';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import type { AgentProvider } from '@shared/agent-providers';
import { projectTexts } from '@shared/texts/project';
import { ActionButton } from '../../../components/ActionButton';
import { ConfirmationDialog } from '../../../components/ConfirmationDialog';
import { LinkedText } from '../../../components/LinkedText';
import { instructionEditor } from './instructionEditor';
import { editInstructionText } from './instructionText';

interface Props {
  value: string;
  agentProvider: AgentProvider | null;
  busy: boolean;
  onChange(value: string): void;
}

export function ProjectAgentInstructions({ value, agentProvider, busy, onChange }: Props): ReactElement {
  const [editor, dispatch] = useReducer(instructionEditor, 'locked');
  const editing = !!agentProvider && editor === 'editing';
  const readOnly = !editing || busy;
  const reason = busy ? projectTexts.settings.waitSaving : !agentProvider ? projectTexts.agentInstructions.chooseAgent : null;
  return (
    <Stack spacing={1} sx={{ minWidth: 0 }}>
      <TextField
        label={projectTexts.agentInstructions.title}
        value={value}
        multiline
        minRows={5}
        maxRows={18}
        fullWidth
        slotProps={{
          input: {
            readOnly,
            // Чтение и копирование доступны: приглушённый фон, пунктир и замок отличают поле от редактора даже в фокусе.
            endAdornment: readOnly ? (
              <InputAdornment position="end">
                <LockOutlinedIcon color="action" />
              </InputAdornment>
            ) : undefined,
            sx: readOnly
              ? {
                  bgcolor: 'action.hover',
                  '& .MuiOutlinedInput-notchedOutline': { borderColor: 'divider', borderStyle: 'dashed' },
                  '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: 'text.secondary' },
                  '&.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: 'text.secondary', borderWidth: 2 }
                }
              : undefined
          },
          inputLabel: { sx: readOnly ? { '&.Mui-focused': { color: 'text.secondary' } } : undefined }
        }}
        onChange={(event) => {
          if (editing && !busy) onChange(editInstructionText(value, event.target.value));
        }}
        helperText={projectTexts.agentInstructions.help}
      />
      <Typography variant="caption" color="text.secondary">
        <LinkedText
          text={
            busy
              ? projectTexts.settings.waitSaving
              : !agentProvider
                ? projectTexts.agentInstructions.chooseAgent
                : editing
                  ? projectTexts.agentInstructions.editing
                  : projectTexts.agentInstructions.locked
          }
        />
      </Typography>
      <Box>
        <ActionButton
          startIcon={<LockOpenIcon />}
          disabled={!!reason || editing}
          disabledReason={reason ?? (editing ? projectTexts.agentInstructions.editing : null)}
          onClick={() => dispatch('request')}
        >
          {projectTexts.agentInstructions.unlock}
        </ActionButton>
      </Box>
      <ConfirmationDialog
        open={editor === 'confirming'}
        title={projectTexts.agentInstructions.unlockTitle}
        description={projectTexts.agentInstructions.warning}
        confirmLabel={projectTexts.agentInstructions.unlock}
        confirmIcon={<LockOpenIcon />}
        confirmDisabled={!!reason}
        confirmDisabledReason={reason}
        cancelAutoFocus
        onClose={() => dispatch('cancel')}
        onConfirm={() => {
          if (!reason) dispatch('confirm');
        }}
      />
    </Stack>
  );
}
