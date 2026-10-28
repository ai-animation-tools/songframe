/** Поля глобального выбора агента; пустой выбор сохраняет работу приложения без CLI. */
import type { ReactElement } from 'react';
import { Button, FormControl, FormControlLabel, FormLabel, Radio, RadioGroup, Stack, TextField } from '@mui/material';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import ManageSearchIcon from '@mui/icons-material/ManageSearch';
import type { AgentSettings } from '@shared/agents';
import { AGENT_PROVIDER_IDS, AGENT_PROVIDERS, isAgentProvider } from '@shared/agent-providers';
import { AgentIcon } from '../../../components';

interface Props {
  settings: AgentSettings | null;
  disabled: boolean;
  fieldsDisabled?: boolean;
  onChange(value: AgentSettings | null, pathTyping?: boolean): void;
  onPick(): Promise<void>;
}

export function AgentSettingsForm({ settings, disabled, fieldsDisabled = false, onChange, onPick }: Props): ReactElement {
  return (
    <Stack spacing={2}>
      <FormControl disabled={disabled}>
        <FormLabel id="agent-provider">Агент</FormLabel>
        <RadioGroup
          row
          aria-labelledby="agent-provider"
          value={settings?.provider ?? ''}
          onChange={(_, provider) => {
            if (isAgentProvider(provider)) onChange({ provider });
            else onChange(null);
          }}
        >
          <FormControlLabel value="" control={<Radio />} label="Не настроен" />
          {AGENT_PROVIDER_IDS.map((provider) => (
            <FormControlLabel
              key={provider}
              value={provider}
              control={<Radio />}
              label={
                <Stack component="span" direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                  <AgentIcon provider={provider} /> <span>{AGENT_PROVIDERS[provider].title}</span>
                </Stack>
              }
            />
          ))}
        </RadioGroup>
      </FormControl>
      <TextField
        label="Модель"
        value={settings?.model ?? ''}
        disabled={disabled || fieldsDisabled || !settings}
        helperText="Пусто — модель по умолчанию CLI"
        onChange={(event) => settings && onChange({ ...settings, model: event.target.value })}
      />
      <TextField
        label="Путь к CLI"
        value={settings?.executablePath ?? ''}
        disabled={disabled || fieldsDisabled || !settings}
        helperText="Пусто — автоматический поиск. Можно указать полный путь к установленному файлу."
        onChange={(event) => settings && onChange({ ...settings, executablePath: event.target.value }, true)}
      />
      <Stack direction="row" spacing={1}>
        <Button startIcon={<FolderOpenIcon />} disabled={disabled || fieldsDisabled || !settings} onClick={onPick}>
          Выбрать файл
        </Button>
        <Button
          startIcon={<ManageSearchIcon />}
          disabled={disabled || fieldsDisabled || !settings?.executablePath}
          onClick={() => settings && onChange({ ...settings, executablePath: '' })}
        >
          Найти автоматически
        </Button>
      </Stack>
    </Stack>
  );
}
