import type { ReactElement } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography
} from '@mui/material';
import { CancelOutlined, Check, ExpandMore, Refresh, Stop } from '@mui/icons-material';
import type { TimingLine } from '@shared/types';
import { mergeTimingAgentReport, type TimingAgentReport, type TimingAgentSource } from '@shared/timing-agent';
import { timingAgentTexts as texts } from '@shared/texts/timing-agent';
import { commonTexts } from '@shared/texts/common';
import { useApp } from '../../../state';
import { AgentButton } from '../../../components/AgentButton';
import { ActionButton } from '../../../components/ActionButton';
import { LinkedText } from '../../../components/LinkedText';
import { useTimingAgent } from '../useTimingAgent';

interface Props {
  project: string;
  lines: TimingLine[];
  onClose(): void;
  onApply(report: TimingAgentReport, source: TimingAgentSource): void;
}

/** Даже готовый отчёт закрывается только кнопкой: Esc и фон не теряют запрос или результат. */
export function TimingAgentDialog({ project, lines, onClose, onApply }: Props): ReactElement {
  const { describeError } = useApp();
  const agent = useTimingAgent(project, describeError);
  const { view, error, working } = agent;
  const running = view?.status === 'running';
  const report = view?.report;
  const applicable = report && view ? mergeTimingAgentReport(lines, report, view.source).appliedIds.length : 0;
  const applyReason = working || running ? commonTexts.operationPending : view?.stale ? texts.stale : !applicable ? texts.noApplicable : null;
  const close = async (): Promise<void> => {
    if (working) return;
    if (!running || (await agent.cancel())) onClose();
  };
  const apply = async (): Promise<void> => {
    if (!view?.job || applyReason) return;
    const fresh = await agent.perform(() => window.api.timingAgent.proposal(project, view.job!.id));
    if (!fresh) return;
    onApply(fresh, view.source);
    onClose();
  };
  return (
    <Dialog open disableEscapeKeyDown fullWidth maxWidth="lg" aria-labelledby="timing-agent-title">
      <DialogTitle id="timing-agent-title">{texts.title}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Alert severity="info">{texts.description}</Alert>
          {!view && !error && (
            <Stack direction="row" spacing={1} alignItems="center" role="status">
              <CircularProgress size={20} />
              <Typography>{texts.loading}</Typography>
            </Stack>
          )}
          {view && (
            <Accordion disableGutters>
              <AccordionSummary expandIcon={<ExpandMore />}>{texts.source}</AccordionSummary>
              <AccordionDetails>
                <Typography variant="subtitle2">{texts.prompt}</Typography>
                <Typography component="pre" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 13 }}>
                  {view.prompt}
                </Typography>
                <Typography variant="subtitle2">{texts.context}</Typography>
                <Typography component="pre" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 13 }}>
                  {view.context}
                </Typography>
              </AccordionDetails>
            </Accordion>
          )}
          {running && (
            <Alert severity="info" icon={<CircularProgress size={20} />} role="status">
              {texts.running}
              {view?.job?.phase ? ` ${view.job.phase}` : ''}
            </Alert>
          )}
          {(error || view?.error) && (
            <Alert severity="error">
              <LinkedText text={error ?? view?.error ?? texts.failure} />
            </Alert>
          )}
          {view?.stale && <Alert severity="warning">{texts.stale}</Alert>}
          {view?.status === 'cancelled' && <Alert severity="info">{texts.cancelled}</Alert>}
          {report && (
            <>
              <Alert severity={report.status === 'unsupported' ? 'warning' : 'success'}>{report.summary}</Alert>
              {report.engine && <Typography>{texts.engine({ name: report.engine })}</Typography>}
              <Typography>{texts.matchCount({ matched: report.matches.length, missing: report.unmatchedSourceLines.length })}</Typography>
              {!!report.matches.length && (
                <Accordion disableGutters>
                  <AccordionSummary expandIcon={<ExpandMore />}>{texts.matches}</AccordionSummary>
                  <AccordionDetails>
                    <Stack spacing={1}>
                      {report.matches.map((match) => (
                        <Typography key={match.sourceLine}>
                          {texts.segment({
                            start: match.start,
                            end: match.end,
                            text: view?.source.lyrics.find((line) => line.number === match.sourceLine)?.text ?? match.sourceLine,
                            note: match.note
                          })}
                        </Typography>
                      ))}
                    </Stack>
                  </AccordionDetails>
                </Accordion>
              )}
              {!!report.segments.length && (
                <Accordion disableGutters>
                  <AccordionSummary expandIcon={<ExpandMore />}>{texts.evidence}</AccordionSummary>
                  <AccordionDetails>
                    <Stack spacing={1}>
                      {report.segments.map((segment, index) => (
                        <Typography key={index}>{texts.segment(segment)}</Typography>
                      ))}
                    </Stack>
                  </AccordionDetails>
                </Accordion>
              )}
              {!!report.limitations.length && (
                <Alert severity="warning">
                  <Typography>{texts.limitations}</Typography>
                  <ul>
                    {report.limitations.map((text, index) => (
                      <li key={index}>{text}</li>
                    ))}
                  </ul>
                </Alert>
              )}
            </>
          )}
          <Alert severity="info">{texts.applyHint}</Alert>
          <Alert severity="warning">{texts.cancelHint}</Alert>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
        <ActionButton startIcon={<CancelOutlined />} disabled={working} disabledReason={commonTexts.operationPending} onClick={() => void close()}>
          {commonTexts.cancel}
        </ActionButton>
        {!view && error && agent.available && (
          <ActionButton startIcon={<Refresh />} disabled={working} disabledReason={commonTexts.operationPending} onClick={() => void agent.reload()}>
            {commonTexts.retry}
          </ActionButton>
        )}
        {running ? (
          <ActionButton startIcon={<Stop />} disabled={working} disabledReason={commonTexts.operationPending} onClick={() => void agent.cancel()}>
            {commonTexts.stop}
          </ActionButton>
        ) : (
          <AgentButton
            disabled={working || !view || !agent.available}
            disabledReason={working ? commonTexts.operationPending : (error ?? texts.loading)}
            onClick={() => void agent.start()}
          >
            {view?.job ? commonTexts.retry : commonTexts.run}
          </AgentButton>
        )}
        <ActionButton variant="contained" startIcon={<Check />} disabled={!!applyReason} disabledReason={applyReason} onClick={() => void apply()}>
          {texts.apply}
        </ActionButton>
      </DialogActions>
    </Dialog>
  );
}
