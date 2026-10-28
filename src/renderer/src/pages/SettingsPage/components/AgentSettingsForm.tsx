/** Поля глобального выбора агента; пустой выбор сохраняет работу приложения без CLI. */
import type { ReactElement } from 'react';
import { Autocomplete, createFilterOptions, FormControl, FormControlLabel, FormLabel, Radio, RadioGroup, Stack, TextField, Typography } from '@mui/material';
import type { AgentModel, AgentSettings } from '@shared/agents';
import { AGENT_PROVIDER_IDS, AGENT_PROVIDERS, isAgentProvider } from '@shared/agent-providers';
import { AgentIcon } from '../../../components';

interface Props {
  settings: AgentSettings | null;
  disabled: boolean;
  fieldsDisabled?: boolean;
  models: AgentModel[];
  modelsLoading: boolean;
  modelsMessage: string | null;
  onChange(value: AgentSettings | null): void;
}

// Поиск идёт и по точному имени, и по подписи: «Opus» находит claude-opus-4-8.
const filterModels = createFilterOptions<AgentModel>({ stringify: (model) => `${model.id} ${model.label}` });

export function AgentSettingsForm({ settings, disabled, fieldsDisabled = false, models, modelsLoading, modelsMessage, onChange }: Props): ReactElement {
  const model = settings?.model ?? '';
  // Значение вне каталога остаётся строкой: CLI может принять модель, которой нет в списке.
  const selected = models.find((item) => item.id === model) ?? (model || null);
  const setModel = (value: string): void => {
    if (settings) onChange({ ...settings, model: value });
  };
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
          <FormControlLabel value="" control={<Radio />} label="Без агента" />
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
      <Autocomplete<AgentModel, false, false, true>
        freeSolo
        options={models}
        value={selected}
        inputValue={model}
        loading={modelsLoading}
        loadingText="Чтение каталога моделей"
        disabled={disabled || fieldsDisabled || !settings}
        filterOptions={filterModels}
        getOptionLabel={(option) => (typeof option === 'string' ? option : option.id)}
        isOptionEqualToValue={(option, value) => option.id === (typeof value === 'string' ? value : value.id)}
        onChange={(_, value) => setModel(typeof value === 'string' ? value : (value?.id ?? ''))}
        onInputChange={(_, value, reason) => {
          // reset приходит при выборе варианта и уже обработан onChange.
          if (reason !== 'reset') setModel(value);
        }}
        renderOption={(props, option) => {
          const { key, ...rest } = props;
          return (
            <li key={key} {...rest}>
              <Stack sx={{ minWidth: 0 }}>
                <Typography variant="body2">
                  {option.label}
                  {option.isDefault ? ' · по умолчанию' : ''}
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                  {option.id}
                  {option.description ? ` — ${option.description}` : ''}
                </Typography>
              </Stack>
            </li>
          );
        }}
        renderInput={(params) => (
          <TextField
            {...params}
            label="Модель"
            helperText={modelsMessage ?? 'Пусто — модель по умолчанию агента. Выберите из списка или введите название вручную.'}
          />
        )}
      />
    </Stack>
  );
}
