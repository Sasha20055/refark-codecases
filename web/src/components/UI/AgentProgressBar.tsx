import { useTranslation } from 'react-i18next';

interface AgentProgressBarProps {
  progress: number;
  phaseName: string | null;
  agentType: 'dev' | 'review' | 'qa' | 'explainer';
  size?: 'sm' | 'md';
}

const agentColorVars: Record<string, string> = {
  dev: 'var(--color-status-dev)',
  review: 'var(--color-status-review)',
  qa: 'var(--color-status-qa)',
  explainer: 'var(--color-nx-warning)',
};

export function AgentProgressBar({ progress, phaseName, agentType, size = 'sm' }: AgentProgressBarProps) {
  const { t } = useTranslation();
  const barHeight = size === 'sm' ? 4 : 6;
  const color = agentColorVars[agentType] ?? 'var(--color-nx-accent)';
  const clamped = Math.max(0, Math.min(100, progress));

  const phaseLabel = phaseName ? t(`agentProgress.${phaseName}`, phaseName) : null;

  return (
    <div className="w-full">
      <div className="flex items-center gap-2">
        <div
          className="flex-1 rounded-full overflow-hidden"
          style={{
            height: `${barHeight}px`,
            backgroundColor: 'rgba(255, 255, 255, 0.06)',
          }}
        >
          <div
            className="h-full rounded-full"
            style={{
              width: `${clamped}%`,
              backgroundColor: color,
              boxShadow: clamped > 0 && clamped < 100 ? `0 0 8px ${color}` : undefined,
              transition: 'width 0.6s cubic-bezier(0.4, 0, 0.2, 1)',
            }}
          />
        </div>
        <span className="text-[10px] tabular-nums text-nx-text-muted shrink-0 w-7 text-right">
          {Math.round(clamped)}%
        </span>
      </div>
      {size === 'md' && phaseLabel && (
        <div className="mt-1 text-[10px] text-nx-text-muted truncate">{phaseLabel}</div>
      )}
    </div>
  );
}
