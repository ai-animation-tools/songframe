import { settingsTexts } from '@shared/texts/settings';
import { commonTexts } from '@shared/texts/common';
/** Поля глобального выбора агента; пустой выбор сохраняет работу приложения без CLI. */
import type { ReactElement } from 'react';
import { Autocomplete, createFilterOptions, FormControl, FormControlLabel, FormLabel, Radio, RadioGroup, Stack, TextField, Typography } from '@mui/material';
import type { AgentModel, AgentSettings } from '@shared/agents';
import { AGENT_PROVIDER_IDS, AGENT_PROVIDERS, isAgentProvider, type AgentProvider } from '@shared/agent-providers';
import { AgentIcon } from '../../../components';

interface Props {
  settings: AgentSettings | null;
  disabled: boolean;
  fieldsDisabled?: boolean;
  models: AgentModel[];
  modelsLoading: boolean;
  modelsMessage: string | null;
  /** Найден ли агент на компьютере; null — проверка ещё идёт. */
  installed: Partial<Record<AgentProvider, boolean>> | null;
  onChange(value: AgentSettings | null): void;
}

// Поиск идёт и по точному имени, и по подписи: «Opus» находит claude-opus-4-8.
const filterModels = createFilterOptions<AgentModel>({ stringify: (model) => `${model.id} ${model.label}` });

export function AgentSettingsForm({
  settings,
  disabled,
  fieldsDisabled = false,
  models,
  modelsLoading,
  modelsMessage,
  installed,
  onChange
}: Props): ReactElement {
  const model = settings?.model ?? '';
  // Значение вне каталога остаётся строкой: CLI может принять модель, которой нет в списке.
  const selected = models.find((item) => item.id === model) ?? (model || null);
  const setModel = (value: string): void => {
    if (settings) onChange({ ...settings, model: value });
  };
  return (
    <Stack spacing={2}>
      <FormControl disabled={disabled}>
        <FormLabel id="agent-provider">{settingsTexts.agent}</FormLabel>
        <RadioGroup
          row
          aria-labelledby="agent-provider"
          value={settings?.provider ?? ''}
          onChange={(_, provider) => {
            if (isAgentProvider(provider)) onChange({ provider });
            else onChange(null);
          }}
        >
          <FormControlLabel value="" control={<Radio />} label={settingsTexts.withoutAgent} />
          {AGENT_PROVIDER_IDS.map((provider) => {
            // Пока идёт проверка, вариант недоступен; ненайденный агент выбрать нельзя.
            const missing = installed?.[provider] === false;
            return (
              <FormControlLabel
                key={provider}
                value={provider}
                control={<Radio />}
                disabled={!installed || missing}
                title={missing ? settingsTexts.agentMissing(AGENT_PROVIDERS[provider].title) : undefined}
                label={
                  <Stack component="span" direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                    <AgentIcon provider={provider} monochrome={missing} /> <span>{AGENT_PROVIDERS[provider].title}</span>
                    {missing ? (
                      <Typography component="span" variant="caption" color="text.secondary">
                        {settingsTexts.missingAgent}
                      </Typography>
                    ) : null}
                  </Stack>
                }
              />
            );
          })}
        </RadioGroup>
      </FormControl>
      {/* Без агента модель не выбирается, поле не показываем. */}
      {settings ? (
        <Autocomplete<AgentModel, false, false, true>
          freeSolo
          options={models}
          value={selected}
          inputValue={model}
          loading={modelsLoading}
          loadingText={settingsTexts.modelsLoading}
          disabled={disabled || fieldsDisabled}
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
                  <Typography variant="body2">{option.isDefault ? settingsTexts.defaultModel(option.label) : option.label}</Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                    {option.id}
                    {option.description ? ` — ${option.description}` : ''}
                  </Typography>
                </Stack>
              </li>
            );
          }}
          renderInput={(params) => <TextField {...params} label={commonTexts.model} helperText={modelsMessage ?? settingsTexts.modelHint} />}
        />
      ) : null}
    </Stack>
  );
}
