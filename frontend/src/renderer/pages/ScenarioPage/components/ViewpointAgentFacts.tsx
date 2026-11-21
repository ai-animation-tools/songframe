import { scenarioTexts } from '@shared/texts/scenario';
import { useEffect, useState, type ReactElement } from 'react';
import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, CircularProgress, Stack, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import DataObjectIcon from '@mui/icons-material/DataObject';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { commonTexts } from '@shared/texts/common';
import { formatMetres } from '@shared/scheme-canvas';
import type { FrameObject, FramePhase, FrameSubject, ViewFrame } from '@shared/viewframe';
import type { SceneViewpoint } from '@shared/viewpoint';
import { useApp } from '../../../state';

const texts = scenarioTexts.viewpoint;

/** Задержка пересчёта после правки точки, мс: перетаскивание не шлёт запрос на каждый шаг. */
const REFRESH_DELAY = 200;

const number = (value: number): string => String(value).replace('.', ',').replace('-', '−');

/**
 * Панель «Что получит агент» карты точки съёмки: факты кадра текущей, ещё не сохранённой расстановки — те же, что
 * получат агенты описания и видеопромпта. Считает их только Go (schemes.frame), панель лишь показывает: читаемым
 * списком и, по кнопке, JSON как есть. Свёрнута по умолчанию и запрашивает факты, только пока раскрыта; правки
 * точки пересчитывают их с короткой задержкой. nameOf называет героев и сущности по кастингу.
 */
export function ViewpointAgentFacts({ viewpoint, nameOf }: { viewpoint: SceneViewpoint; nameOf(id: string): string }): ReactElement {
  const { state, describeError, notify } = useApp();
  const project = state?.current ?? '';
  const [expanded, setExpanded] = useState(false);
  const [json, setJson] = useState(false);
  const key = JSON.stringify(viewpoint);
  const [result, setResult] = useState<{ key: string; frame?: ViewFrame; error?: string } | null>(null);
  useEffect(() => {
    if (!expanded || !project) return;
    let active = true;
    const timer = setTimeout(() => {
      window.api.schemes
        .frame(project, JSON.parse(key) as SceneViewpoint)
        .then((frame) => active && setResult({ key, frame }))
        .catch((error: unknown) => active && setResult({ key, error: describeError(error) }));
    }, REFRESH_DELAY);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [expanded, project, key, describeError]);

  // Прежние факты видны, пока считаются новые: панель не мигает при перетаскивании.
  const frame = result?.frame;
  // JSON копируется как есть, тем же видом, что показан в панели.
  const copy = async (value: ViewFrame): Promise<void> => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(value, null, 2));
      notify(commonTexts.copied, 'success');
    } catch (reason) {
      notify(describeError(reason), 'error');
    }
  };
  return (
    <Accordion variant="outlined" disableGutters expanded={expanded} onChange={(_, next) => setExpanded(next)} sx={{ minWidth: 0 }} data-agent-facts="">
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Stack sx={{ minWidth: 0 }}>
          <Typography variant="subtitle2">{texts.agentFacts}</Typography>
          <Typography variant="body2" color="text.secondary">
            {texts.agentFactsSummary}
          </Typography>
        </Stack>
      </AccordionSummary>
      <AccordionDetails>
        {result?.error ? (
          <Alert severity="error">{texts.agentFactsError({ error: result.error })}</Alert>
        ) : !frame ? (
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <CircularProgress size={16} />
            <Typography variant="body2">{texts.agentFactsLoading}</Typography>
          </Stack>
        ) : (
          <Stack spacing={1.5} data-agent-frame="">
            {frame.note ? <Typography variant="body2">{frame.note}</Typography> : null}
            {frame.start ? <PhaseFacts title={texts.phases.start} phase={frame.start} nameOf={nameOf} /> : null}
            {frame.end ? <PhaseFacts title={texts.phases.end} phase={frame.end} nameOf={nameOf} /> : null}
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
              <Button size="small" startIcon={<DataObjectIcon />} onClick={() => setJson((value) => !value)}>
                {json ? texts.agentHideJson : texts.agentShowJson}
              </Button>
              <Button size="small" startIcon={<ContentCopyIcon />} onClick={() => void copy(frame)}>
                {texts.agentCopyJson}
              </Button>
            </Stack>
            {json ? (
              <Box
                component="pre"
                data-agent-json=""
                sx={{ m: 0, p: 1, borderRadius: 1, bgcolor: 'action.hover', fontSize: 12, overflow: 'auto', maxHeight: 320 }}
              >
                {JSON.stringify(frame, null, 2)}
              </Box>
            ) : null}
          </Stack>
        )}
      </AccordionDetails>
    </Accordion>
  );
}

/** Один кадр: заголовок со взглядом и высотой камеры, что в кадре и что вне его. */
function PhaseFacts({ title, phase, nameOf }: { title: string; phase: FramePhase; nameOf(id: string): string }): ReactElement {
  const inside = [
    ...phase.subjects.filter((subject) => subject.in_frame).map((subject) => subjectLine(subject, nameOf)),
    ...phase.objects.filter((object) => object.in_frame).map((object) => objectLine(object))
  ];
  const outside = [
    ...phase.subjects.filter((subject) => !subject.in_frame).map((subject) => subjectLine(subject, nameOf)),
    ...phase.objects.filter((object) => !object.in_frame).map((object) => objectLine(object))
  ];
  return (
    <Stack spacing={0.5}>
      <Typography variant="subtitle2">{texts.agentPhase({ phase: title, looks: phase.looks, height: formatMetres(phase.camera_height) })}</Typography>
      <FactList title={texts.agentInFrame} lines={inside} />
      <FactList title={texts.agentOutOfFrame} lines={outside} />
    </Stack>
  );
}

function FactList({ title, lines }: { title: string; lines: string[] }): ReactElement {
  return (
    <Box>
      <Typography variant="body2" color="text.secondary">
        {title}
      </Typography>
      {lines.length ? (
        <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
          {lines.map((line, index) => (
            <Typography key={index} component="li" variant="body2">
              {line}
            </Typography>
          ))}
        </Box>
      ) : (
        <Typography variant="body2">{texts.agentNone}</Typography>
      )}
    </Box>
  );
}

/** Строка героя: имя, главный ли, место, расстояние, доля высоты кадра и кто его закрывает. */
function subjectLine(subject: FrameSubject, nameOf: (id: string) => string): string {
  const parts = [nameOf(subject.entity)];
  if (subject.lead) parts.push(texts.agentLead);
  parts.push(subject.place);
  if (subject.x !== undefined) parts.push(texts.agentX({ x: number(subject.x) }));
  parts.push(texts.agentDistance({ metres: formatMetres(subject.distance) }));
  if (subject.frame_height !== undefined) parts.push(texts.agentFrameHeight({ percent: Math.round(subject.frame_height * 100) }));
  if (subject.whole !== undefined) parts.push(texts.agentWhole({ whole: subject.whole }));
  if (subject.hidden_by.length) parts.push(texts.agentHiddenBy({ names: subject.hidden_by.map(nameOf).join(', ') }));
  return parts.join(' · ');
}

/** Строка объекта схемы: название, место, расстояние до ближайшего края и высота. */
function objectLine(object: FrameObject): string {
  const parts = [object.name, object.place, texts.agentDistance({ metres: formatMetres(object.distance) })];
  if (object.height !== undefined) parts.push(texts.agentHeight({ metres: formatMetres(object.height) }));
  return parts.join(' · ');
}
