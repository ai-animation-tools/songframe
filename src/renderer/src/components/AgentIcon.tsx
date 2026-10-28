/** Присланные знаки провайдеров; на кнопках с заливкой контраст обеспечивается цветом текста. */
import type { ReactElement } from 'react';
import { Box } from '@mui/material';
import { AGENT_PROVIDER_IDS, type AgentProvider } from '@shared/agent-providers';

/** Цветной знак показывается как есть, одноцветный перекрашивается маской в цвет текста. */
const ICONS: Record<AgentProvider, { src: string; colored: boolean }> = {
  claude: { src: new URL('../assets/agents/claude.svg', import.meta.url).href, colored: true },
  codex: { src: new URL('../assets/agents/codex.svg', import.meta.url).href, colored: false }
};

export function AgentIcon({ provider, size = 20, monochrome = false }: { provider: AgentProvider | null; size?: number; monochrome?: boolean }): ReactElement {
  const providers = provider ? [provider] : AGENT_PROVIDER_IDS;
  return (
    <Box
      component="span"
      aria-hidden="true"
      data-agent-icon={provider ?? 'any'}
      sx={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 0.4, flexShrink: 0, verticalAlign: 'middle', lineHeight: 0 }}
    >
      {providers.map((value) =>
        ICONS[value].colored && !monochrome ? (
          <Box key={value} component="img" src={ICONS[value].src} alt="" sx={{ display: 'block', width: size, height: size }} />
        ) : (
          <Box
            key={value}
            component="span"
            sx={{
              display: 'block',
              width: size,
              height: size,
              bgcolor: 'currentColor',
              maskImage: `url("${ICONS[value].src}")`,
              maskSize: 'contain',
              maskRepeat: 'no-repeat',
              maskPosition: 'center'
            }}
          />
        )
      )}
    </Box>
  );
}
