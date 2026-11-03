/** Текст с лёгкой разметкой markdown показывается заголовками, абзацами и списками без исходных символов. */
import type { ReactElement, ReactNode } from 'react';
import { Box, Stack, Typography } from '@mui/material';

export function inline(text: string): ReactNode {
  // Жирный текст и ссылки markdown показываются как текст, остальное без изменений.
  const parts = text.split(/(\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g).filter(Boolean);
  return parts.map((part, index) => {
    const bold = /^\*\*([^*]+)\*\*$/.exec(part);
    if (bold) return <b key={index}>{bold[1]}</b>;
    const link = /^\[([^\]]+)\]\([^)]+\)$/.exec(part);
    if (link) return <span key={index}>{link[1]}</span>;
    return <span key={index}>{part}</span>;
  });
}

/** Markdown описаний превращается в заголовки, абзацы и списки без исходной разметки. */
export function Prose({ text }: { text: string }): ReactElement {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  const flush = (): void => {
    if (paragraph.length) {
      blocks.push(
        <Typography key={blocks.length} variant="body2" sx={{ overflowWrap: 'anywhere' }}>
          {inline(paragraph.join(' '))}
        </Typography>
      );
      paragraph = [];
    }
    if (list.length) {
      blocks.push(
        <Box key={blocks.length} component="ul" sx={{ m: 0, pl: 2.5 }}>
          {list.map((item, index) => (
            <Typography key={index} component="li" variant="body2" sx={{ overflowWrap: 'anywhere' }}>
              {inline(item)}
            </Typography>
          ))}
        </Box>
      );
      list = [];
    }
  };
  for (const raw of lines) {
    const line = raw.trim();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^[-*]\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (!line) flush();
    else if (heading) {
      flush();
      blocks.push(
        <Typography key={blocks.length} variant="subtitle2" sx={{ mt: blocks.length ? 1 : 0 }}>
          {inline(heading[1])}
        </Typography>
      );
    } else if (bullet) {
      if (paragraph.length) flush();
      list.push(bullet[1]);
    } else {
      if (list.length) flush();
      paragraph.push(line);
    }
  }
  flush();
  return <Stack spacing={0.75}>{blocks}</Stack>;
}
