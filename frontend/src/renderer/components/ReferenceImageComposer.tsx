/** Выбор разделов остаётся отделён от ручного текста; возврат к сборке требует явного подтверждения. */
import { useState, type ReactElement } from 'react';
import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, Checkbox, FormControlLabel, MenuItem, Stack, TextField, Typography } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import EditIcon from '@mui/icons-material/Edit';
import { sourcesTexts } from '@shared/texts/sources';
import { commonTexts } from '@shared/texts/common';
import { REFERENCE_VIEW_LABELS } from '@shared/types';
import { REFERENCE_VIEW_PROMPTS, type ReferencePromptOptions } from '@shared/reference-image-generation';
import { REFERENCE_SECTION_LABELS, REFERENCE_SECTION_ORDER, type useReferenceImageComposer } from '../hooks/useReferenceImageComposer';
import { ActionButton } from './ActionButton';
import { ConfirmationDialog } from './ConfirmationDialog';

type Composer = ReturnType<typeof useReferenceImageComposer>;
export function ReferenceImageComposer({
  composer,
  description,
  disabled,
  onChange
}: {
  composer: Composer;
  description: string;
  disabled: boolean;
  onChange(action: () => void): void;
}): ReactElement {
  const [rebuildOpen, setRebuildOpen] = useState(false);
  const selectedCount = REFERENCE_SECTION_ORDER.filter((key) => {
    const value = key === 'description' ? description : key === 'supportNotes' ? composer.supportNotes : (composer.context?.[key] ?? '');
    return composer.sections[key] && !!value.trim();
  }).length;
  return (
    <Stack component="section" aria-label={sourcesTexts.referenceConstructor} spacing={1}>
      {composer.loading && (
        <Typography role="status" variant="body2">
          {sourcesTexts.referenceContextLoading}
        </Typography>
      )}
      {composer.error && (
        <Alert severity="error">
          <Stack spacing={1} alignItems="flex-start">
            <Typography variant="body2">
              {sourcesTexts.referenceContextUnavailable} {composer.error}
            </Typography>
            <ActionButton
              startIcon={<RefreshIcon />}
              onClick={composer.retry}
              disabled={disabled || composer.loading}
              disabledReason={sourcesTexts.referenceConstructorBusy}
            >
              {sourcesTexts.referenceContextRetry}
            </ActionButton>
            <ActionButton
              startIcon={<EditIcon />}
              onClick={() => onChange(composer.withoutContext)}
              disabled={disabled}
              disabledReason={sourcesTexts.referenceConstructorBusy}
            >
              {sourcesTexts.referenceWithoutContext}
            </ActionButton>
          </Stack>
        </Alert>
      )}
      {composer.manual && <Alert severity="info">{sourcesTexts.referenceManualPrompt}</Alert>}
      {/* Параметры задаются почти у каждого референса, поэтому видны без раскрытия конструктора. */}
      <ReferenceOptionsPanel
        options={composer.options}
        disabled={disabled || composer.manual}
        onChange={(patch) => onChange(() => composer.changeOptions(patch))}
      />
      {/* Согласования и ошибки остаются видимыми; внутри свёрнуты только выбор разделов и их полный текст. */}
      <Accordion
        disableGutters
        variant="outlined"
        defaultExpanded={false}
        slotProps={{ transition: { unmountOnExit: true } }}
        sx={{ '&:before': { display: 'none' } }}
      >
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Box sx={{ minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 1, flexWrap: 'wrap' }}>
            <Typography variant="subtitle2">{sourcesTexts.referenceConstructor}</Typography>
            <Typography variant="caption" color="text.secondary">
              {sourcesTexts.referenceSelectedContextCount({ count: selectedCount })}
            </Typography>
          </Box>
        </AccordionSummary>
        <AccordionDetails>
          <Stack spacing={1}>
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 230px), 1fr))', gap: 1, alignItems: 'start' }}>
              {REFERENCE_SECTION_ORDER.map((key) => {
                const value = key === 'description' ? description : key === 'supportNotes' ? composer.supportNotes : (composer.context?.[key] ?? '');
                const label = key === 'supportNotes' ? sourcesTexts.referenceSupportNotes : REFERENCE_SECTION_LABELS[key];
                return (
                  <Stack key={key} spacing={0.5} sx={{ minWidth: 0 }}>
                    <FormControlLabel
                      label={label}
                      control={
                        <Checkbox
                          checked={composer.sections[key] && !!value.trim()}
                          disabled={disabled || composer.loading || composer.manual || !value.trim()}
                          onChange={(_event, checked) => onChange(() => composer.change(key, checked))}
                        />
                      }
                    />
                    {key === 'supportNotes' && (
                      <Typography variant="caption" color="text.secondary">
                        {sourcesTexts.referenceSupportNotesHint}
                      </Typography>
                    )}
                    <Typography variant="caption" color="text.secondary">
                      {value.trim() ? sourcesTexts.referenceCharacterCount({ count: Array.from(value).length }) : sourcesTexts.referenceContextEmpty}
                    </Typography>
                    {value.trim() && (
                      <Box component="details" sx={{ minWidth: 0 }}>
                        <Typography component="summary" variant="caption" sx={{ cursor: 'pointer' }}>
                          {sourcesTexts.referencePreviewSection({ label })}
                        </Typography>
                        <Typography
                          component="pre"
                          variant="body2"
                          sx={{
                            m: 0,
                            mt: 1,
                            p: 1,
                            maxHeight: 200,
                            overflow: 'auto',
                            whiteSpace: 'pre-wrap',
                            overflowWrap: 'anywhere',
                            bgcolor: 'action.hover',
                            borderRadius: 1
                          }}
                        >
                          {value}
                        </Typography>
                      </Box>
                    )}
                  </Stack>
                );
              })}
            </Box>
            {composer.manual && (
              <Box>
                <ActionButton
                  startIcon={<RefreshIcon />}
                  onClick={() => setRebuildOpen(true)}
                  disabled={disabled || !composer.context || composer.loading}
                  disabledReason={
                    composer.loading
                      ? sourcesTexts.referenceContextLoading
                      : !composer.context
                        ? sourcesTexts.referenceContextUnavailable
                        : sourcesTexts.referenceConstructorBusy
                  }
                >
                  {sourcesTexts.referenceRebuild}
                </ActionButton>
              </Box>
            )}
          </Stack>
        </AccordionDetails>
      </Accordion>
      <ConfirmationDialog
        open={rebuildOpen}
        title={sourcesTexts.referenceRebuildTitle}
        description={sourcesTexts.referenceRebuildDescription}
        confirmLabel={sourcesTexts.referenceRebuild}
        confirmIcon={<RefreshIcon />}
        cancelLabel={commonTexts.cancel}
        onClose={() => setRebuildOpen(false)}
        onConfirm={() => {
          setRebuildOpen(false);
          onChange(composer.rebuild);
        }}
        confirmDisabled={disabled}
        confirmDisabledReason={sourcesTexts.referenceConstructorBusy}
      />
    </Stack>
  );
}

/** Ракурсы, которые можно выбрать: «Другое» — вид без указания, поэтому в списке его нет. */
const VIEW_ORDER = Object.keys(REFERENCE_VIEW_PROMPTS) as NonNullable<ReferencePromptOptions['view']>[];

/** Галочка параметра с пояснением, связанным с ней для экранного диктора. */
function OptionCheckbox({
  id,
  label,
  hint,
  checked,
  disabled,
  onChange
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange(checked: boolean): void;
}): ReactElement {
  return (
    <Stack spacing={0} sx={{ minWidth: 0 }}>
      <FormControlLabel
        label={label}
        control={
          <Checkbox checked={checked} disabled={disabled} onChange={(_event, value) => onChange(value)} slotProps={{ input: { 'aria-describedby': id } }} />
        }
      />
      <Typography id={id} variant="caption" color="text.secondary">
        {hint}
      </Typography>
    </Stack>
  );
}

/** Ракурс и указания исполнителю: фон, объект целиком, ровный свет. */
function ReferenceOptionsPanel({
  options,
  disabled,
  onChange
}: {
  options: ReferencePromptOptions;
  disabled: boolean;
  onChange(patch: Partial<ReferencePromptOptions>): void;
}): ReactElement {
  const face = options.view === 'face';
  return (
    <Stack component="section" aria-label={sourcesTexts.referenceOptions} spacing={1}>
      <Typography variant="subtitle2">{sourcesTexts.referenceOptions}</Typography>
      <Typography variant="caption" color="text.secondary">
        {sourcesTexts.referenceOptionsHint}
      </Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))', gap: 1.5, alignItems: 'start' }}>
        {/* Пояснение отдельной подписью: helperText недоступного поля бледнеет ниже нормы контраста. */}
        <Stack spacing={0.5} sx={{ minWidth: 0 }}>
          <TextField
            select
            size="small"
            label={sourcesTexts.referenceView}
            value={options.view ?? ''}
            disabled={disabled}
            slotProps={{ select: { SelectDisplayProps: { 'aria-describedby': 'reference-view-hint' } } }}
            onChange={(event) => onChange({ view: (event.target.value || null) as ReferencePromptOptions['view'] })}
          >
            <MenuItem value="">{sourcesTexts.referenceViewNone}</MenuItem>
            {VIEW_ORDER.map((view) => (
              <MenuItem key={view} value={view}>
                {REFERENCE_VIEW_LABELS[view]}
              </MenuItem>
            ))}
          </TextField>
          <Typography id="reference-view-hint" variant="caption" color="text.secondary">
            {sourcesTexts.referenceViewHint}
          </Typography>
        </Stack>
        <OptionCheckbox
          id="reference-whole-object-hint"
          label={sourcesTexts.referenceWholeObject}
          hint={face ? sourcesTexts.referenceWholeObjectFace : sourcesTexts.referenceWholeObjectHint}
          checked={options.wholeObject && !face}
          disabled={disabled || face}
          onChange={(wholeObject) => onChange({ wholeObject })}
        />
        <OptionCheckbox
          id="reference-plain-background-hint"
          label={sourcesTexts.referencePlainBackground}
          hint={sourcesTexts.referencePlainBackgroundHint}
          checked={options.plainBackground}
          disabled={disabled}
          onChange={(plainBackground) => onChange({ plainBackground })}
        />
        <OptionCheckbox
          id="reference-even-light-hint"
          label={sourcesTexts.referenceEvenLight}
          hint={sourcesTexts.referenceEvenLightHint}
          checked={options.evenLight}
          disabled={disabled}
          onChange={(evenLight) => onChange({ evenLight })}
        />
      </Box>
    </Stack>
  );
}
