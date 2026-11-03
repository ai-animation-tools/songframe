/** Присланные знаки провайдеров; всегда ровно один знак, на кнопках с заливкой контраст обеспечивается цветом текста. */
import type { ReactElement } from 'react';
import { Box } from '@mui/material';
import type { AgentProvider } from '@shared/agent-providers';

/** Цветной знак показывается как есть, одноцветный перекрашивается маской в цвет текста. */
const ICONS: Record<AgentProvider, { src: string; colored: boolean }> = {
  claude: { src: new URL('../assets/agents/claude.svg', import.meta.url).href, colored: true },
  codex: { src: new URL('../assets/agents/codex.svg', import.meta.url).href, colored: false }
};

export function AgentIcon({ provider, size = 20, monochrome = false }: { provider: AgentProvider; size?: number; monochrome?: boolean }): ReactElement {
  const icon = ICONS[provider];
  return (
    <Box
      component="span"
      aria-hidden="true"
      data-agent-icon={provider}
      sx={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, verticalAlign: 'middle', lineHeight: 0 }}
    >
      {icon.colored && !monochrome ? (
        <Box component="img" src={icon.src} alt="" sx={{ display: 'block', width: size, height: size }} />
      ) : (
        <Box
          component="span"
          sx={{
            display: 'block',
            width: size,
            height: size,
            bgcolor: 'currentColor',
            maskImage: `url("${icon.src}")`,
            maskSize: 'contain',
            maskRepeat: 'no-repeat',
            maskPosition: 'center'
          }}
        />
      )}
    </Box>
  );
}
