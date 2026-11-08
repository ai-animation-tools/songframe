/** Выбор разделов остаётся отделён от ручного текста; возврат к сборке требует явного подтверждения. */
import { useState, type ReactElement } from 'react';
import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, Checkbox, FormControlLabel, Stack, Typography } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import EditIcon from '@mui/icons-material/Edit';
import { sourcesTexts } from '@shared/texts/sources';
import { commonTexts } from '@shared/texts/common';
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
