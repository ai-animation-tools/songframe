import { castTexts } from '@shared/texts/cast';
import { type ReactElement, useRef, useState } from 'react';
import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, Chip, Stack, Tab, Tabs, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import type { CastEntity, CastProperty, SourceKind } from '@shared/types';
import { LinkedText } from '../../../components/LinkedText';
import { dictionaryKinds, moveItem, patchProperty, propertyKeyProblem, propertyUsage } from '../properties';
import { CastPropertyAddForm } from './CastPropertyAddForm';
import { CastPropertyRow } from './CastPropertyRow';

interface CastPropertiesEditorProps {
  /** Типы страницы: задают подписи и порядок вкладок. */
  kinds: SourceKind[];
  entities: CastEntity[];
  /** Черновик словаря, сохраняется вместе с кастингом. */
  properties: Record<string, CastProperty[]>;
  /** Словарь последней загрузки: смена объекта означает перечитанный файл. */
  savedProperties: Record<string, CastProperty[]>;
  /** Первая проблема словаря, мешающая сохранению. */
  problem: string | null;
  onChange: (properties: Record<string, CastProperty[]>) => void;
}

/** Свёрнутый по умолчанию редактор словаря свойств: вкладка на тип, строки свойств и добавление. */
export function CastPropertiesEditor({ kinds, entities, properties, savedProperties, problem, onChange }: CastPropertiesEditorProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  // Строкам нужны постоянные идентификаторы: код нового свойства редактируется и не годится ключом,
  // а признак «новое» должен держаться за строку, даже если введённый код совпал с сохранённым.
  const [rowIds, setRowIds] = useState<Record<string, string[]>>({});
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  const [loaded, setLoaded] = useState(savedProperties);
  const counter = useRef(0);
  if (loaded !== savedProperties) {
    // После сохранения или перечитывания все свойства становятся сохранёнными.
    setLoaded(savedProperties);
    setRowIds({});
    setFresh(new Set());
    setExpanded(null);
  }

  const kindLabel = (kind: string): string => kinds.find((k) => k.id === kind)?.label ?? kind;
  const kindIds = dictionaryKinds(
    kinds.map((k) => k.id),
    properties,
    entities
  );
  const kind = tab && kindIds.includes(tab) ? tab : (kindIds[0] ?? null);
  const list = kind ? (properties[kind] ?? []) : [];
  const idsFor = (k: string, length: number): string[] => {
    const ids = rowIds[k];
    return ids && ids.length === length ? ids : Array.from({ length }, (_, index) => `${k}#${index}`);
  };
  const ids = kind ? idsFor(kind, list.length) : [];
  const changed = JSON.stringify(properties) !== JSON.stringify(savedProperties);

  const commit = (k: string, nextList: CastProperty[], nextIds: string[]): void => {
    setRowIds((current) => ({ ...current, [k]: nextIds }));
    onChange({ ...properties, [k]: nextList });
  };
  const add = (k: string, key: string, label: string): void => {
    counter.current += 1;
    const id = `new-${counter.current}`;
    setFresh((current) => new Set([...current, id]));
    commit(k, [...list, { key, label }], [...ids, id]);
    setExpanded(id);
  };

  return (
    <Accordion
      expanded={open}
      onChange={(_e, next) => setOpen(next)}
      disableGutters
      variant="outlined"
      slotProps={{ transition: { unmountOnExit: true } }}
      sx={{ minWidth: 0 }}
    >
      <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ '& .MuiAccordionSummary-content': { minWidth: 0 } }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flex: 1, minWidth: 0, flexWrap: 'wrap' }}>
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography fontWeight={600}>{castTexts.propertiesTitle}</Typography>
            <Typography variant="caption" color="text.secondary">
              {castTexts.propertiesDescription}
            </Typography>
          </Box>
          {changed ? <Chip size="small" variant="outlined" color="warning" label={castTexts.propertiesChanged} /> : null}
          {problem ? <Chip size="small" variant="outlined" color="error" label={castTexts.propertiesInvalid} /> : null}
        </Box>
      </AccordionSummary>
      <AccordionDetails>
        <Stack spacing={2}>
          <Typography variant="body2" color="text.secondary">
            <LinkedText text={castTexts.propertiesHelp} />
          </Typography>
          {problem ? <Alert severity="error">{problem}</Alert> : null}
          {!kind ? (
            <Typography color="text.secondary">{castTexts.noKinds}</Typography>
          ) : (
            <>
              <Tabs
                value={kind}
                onChange={(_e, next: string) => {
                  setTab(next);
                  setExpanded(null);
                }}
                variant="scrollable"
                scrollButtons="auto"
                aria-label={castTexts.entityKinds}
                sx={{ minHeight: 36, borderBottom: 1, borderColor: 'divider' }}
              >
                {kindIds.map((k) => (
                  <Tab
                    key={k}
                    value={k}
                    id={`cast-properties-tab-${k}`}
                    aria-controls="cast-properties-panel"
                    label={
                      properties[k]
                        ? castTexts.dictionaryCount({ kind: kindLabel(k), count: properties[k].length })
                        : castTexts.noDictionary({ kind: kindLabel(k) })
                    }
                    sx={{ minHeight: 36 }}
                  />
                ))}
              </Tabs>
              <Stack spacing={1} role="tabpanel" id="cast-properties-panel" aria-labelledby={`cast-properties-tab-${kind}`}>
                {!properties[kind] ? (
                  <Typography variant="body2" color="text.secondary">
                    {castTexts.defaultDictionaryHelp({ kind: kindLabel(kind) })}
                  </Typography>
                ) : !list.length ? (
                  <Typography variant="body2" color="text.secondary">
                    {castTexts.noProperties}
                  </Typography>
                ) : null}
                {list.map((property, index) => {
                  const id = ids[index];
                  return (
                    <CastPropertyRow
                      key={id}
                      property={property}
                      fresh={fresh.has(id)}
                      keyProblem={propertyKeyProblem(
                        property.key,
                        list.filter((_, other) => other !== index).map((p) => p.key)
                      )}
                      kindLabel={kindLabel(kind)}
                      usage={propertyUsage(entities, kind, property.key)}
                      first={index === 0}
                      last={index === list.length - 1}
                      expanded={expanded === id}
                      onExpandedChange={(next) => setExpanded(next ? id : null)}
                      onChange={(patch) =>
                        commit(
                          kind,
                          list.map((p, i) => (i === index ? patchProperty(p, patch) : p)),
                          ids
                        )
                      }
                      onMove={(offset) => commit(kind, moveItem(list, index, offset), moveItem(ids, index, offset))}
                      onRemove={() =>
                        commit(
                          kind,
                          list.filter((_, i) => i !== index),
                          ids.filter((_, i) => i !== index)
                        )
                      }
                    />
                  );
                })}
              </Stack>
              <CastPropertyAddForm key={kind} existingKeys={list.map((p) => p.key)} onAdd={(key, label) => add(kind, key, label)} />
            </>
          )}
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}
