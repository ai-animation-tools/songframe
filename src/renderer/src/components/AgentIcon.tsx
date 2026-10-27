/** Присланные знаки провайдеров; на кнопках с заливкой контраст обеспечивается цветом текста. */
import type { ReactElement } from 'react';
import { Box } from '@mui/material';
import type { AgentSettings } from '@shared/agents';

const codex = new URL('../assets/agents/codex.svg', import.meta.url).href;
const claude = new URL('../assets/agents/claude.svg', import.meta.url).href;

export function AgentIcon({
  provider,
  size = 20,
  monochrome = false
}: {
  provider: AgentSettings['provider'] | null;
  size?: number;
  monochrome?: boolean;
}): ReactElement {
  const providers = provider ? [provider] : (['claude', 'codex'] as const);
  return (
    <Box
      component="span"
      aria-hidden="true"
      data-agent-icon={provider ?? 'any'}
      sx={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 0.4, flexShrink: 0, verticalAlign: 'middle', lineHeight: 0 }}
    >
      {providers.map((value) =>
        value === 'claude' && !monochrome ? (
          <Box key={value} component="img" src={claude} alt="" sx={{ display: 'block', width: size, height: size }} />
        ) : (
          <Box
            key={value}
            component="span"
            sx={{
              display: 'block',
              width: size,
              height: size,
              bgcolor: 'currentColor',
              maskImage: `url("${value === 'claude' ? claude : codex}")`,
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
