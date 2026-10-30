import { sourcesTexts } from '@shared/texts/sources';
/** Список референсов объединяет редакторы сущностей и настройку типов. */
import type { ReactElement } from 'react';
import { Box, Button, Paper, Stack, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import type { SourceKind } from '@shared/types';
import type { FileForm, ReferenceForm } from '../types';
import { ReferenceEditor } from './ReferenceEditor';
import { ReferenceKinds } from './ReferenceKinds';

interface Props {
  refs: ReferenceForm[];
  kinds: SourceKind[];
  fileUrl: (path: string, absolute?: boolean) => string;
  onAdd: () => void;
  onUpdate: (key: number, patch: Partial<ReferenceForm>) => void;
  onRetryFilePrompt: (refKey: number, fileKey: number) => Promise<void>;
  onRemove: (key: number) => void;
  onGenerate: (key: number) => void;
  onAddFiles: (key: number) => Promise<void>;
  onDropFiles: (key: number, paths: string[]) => void;
  onUpdateFile: (refKey: number, fileKey: number, patch: Partial<FileForm>) => void;
  onRemoveFile: (refKey: number, fileKey: number) => void;
  onRemoveKind: (id: string) => void;
  onAddKind: () => void;
}

export function ReferencesSection({
  refs,
  kinds,
  fileUrl,
  onAdd,
  onUpdate,
  onRetryFilePrompt,
  onRemove,
  onGenerate,
  onAddFiles,
  onDropFiles,
  onUpdateFile,
  onRemoveFile,
  onRemoveKind,
  onAddKind
}: Props): ReactElement {
  // Повтор кода виден только по всему списку, поэтому считается здесь и передаётся каждой карточке.
  const idCounts = new Map<string, number>();
  for (const reference of refs) idCounts.set(reference.id, (idCounts.get(reference.id) ?? 0) + 1);
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
        <Box sx={{ flex: 1 }}>
          <Typography variant="subtitle1" fontWeight={600}>
            {sourcesTexts.references}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {sourcesTexts.referencesHint}
          </Typography>
        </Box>
      </Box>
      <ReferenceKinds kinds={kinds} onRemove={onRemoveKind} onAdd={onAddKind} />
      <Stack spacing={1}>
        {refs.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
            {sourcesTexts.noReferences}
          </Typography>
        ) : null}
        {refs.map((reference) => (
          <ReferenceEditor
            key={reference.key}
            reference={reference}
            kinds={kinds}
            duplicateId={(idCounts.get(reference.id) ?? 0) > 1}
            fileUrl={fileUrl}
            onUpdate={(patch) => onUpdate(reference.key, patch)}
            onRetryFilePrompt={(fileKey) => onRetryFilePrompt(reference.key, fileKey)}
            onRemove={() => onRemove(reference.key)}
            onGenerate={() => onGenerate(reference.key)}
            onAddFiles={() => onAddFiles(reference.key)}
            onDropFiles={(paths) => onDropFiles(reference.key, paths)}
            onUpdateFile={(fileKey, patch) => onUpdateFile(reference.key, fileKey, patch)}
            onRemoveFile={(fileKey) => onRemoveFile(reference.key, fileKey)}
          />
        ))}
      </Stack>
      <Button sx={{ mt: 2 }} variant="outlined" color="success" startIcon={<AddIcon />} onClick={onAdd}>
        {sourcesTexts.newReference}
      </Button>
    </Paper>
  );
}
