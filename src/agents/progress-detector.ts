export interface ProgressState {
  percent: number;
  phaseName: string;
}

interface PhaseDefinition {
  name: string;
  weight: number;
  startPercent: number;
}

function buildPhases(definitions: Array<{ name: string; weight: number }>): PhaseDefinition[] {
  let cumulative = 0;
  return definitions.map((d) => {
    const phase: PhaseDefinition = { name: d.name, weight: d.weight, startPercent: cumulative };
    cumulative += d.weight;
    return phase;
  });
}

const DEV_PHASES = buildPhases([
  { name: 'cloning', weight: 5 },
  { name: 'initializing', weight: 5 },
  { name: 'analyzing', weight: 10 },
  { name: 'coding', weight: 55 },
  { name: 'committing', weight: 15 },
  { name: 'done', weight: 10 },
]);

const REVIEW_PHASES = buildPhases([
  { name: 'cloning', weight: 5 },
  { name: 'initializing', weight: 10 },
  { name: 'analyzing', weight: 70 },
  { name: 'finalizing', weight: 15 },
]);

const EXPECTED_MAX_OUTPUT = 15_000;
const OPENCODE_INITIAL_CHARS = 500;

function outputAfterMarker(output: string, marker: string): number {
  const idx = output.lastIndexOf(marker);
  if (idx === -1) return 0;
  return output.length - idx - marker.length;
}

function logProgress(chars: number, maxChars: number): number {
  if (chars <= 0) return 0;
  const ratio = Math.min(chars / maxChars, 1);
  return Math.min(Math.log1p(ratio * 10) / Math.log1p(10), 0.95);
}

function computePhasePercent(phases: PhaseDefinition[], phaseIndex: number, intraPhaseProgress: number): number {
  const phase = phases[phaseIndex];
  return phase.startPercent + phase.weight * Math.min(intraPhaseProgress, 1);
}

export function detectProgress(agentType: 'dev' | 'review' | 'lead' | 'explainer', strippedOutput: string): ProgressState {
  if (agentType === 'dev') {
    return detectDevProgress(strippedOutput);
  }
  if (agentType === 'lead' || agentType === 'explainer') {
    return detectReviewProgress(strippedOutput);
  }
  return detectReviewProgress(strippedOutput);
}

function detectDevProgress(output: string): ProgressState {
  const hasDone = output.includes('::done::');
  const hasResult = output.includes('::result::');
  const hasOpencode = output.includes('::opencode::');
  const hasClone = output.includes('::clone::');

  if (hasDone) {
    return { percent: computePhasePercent(DEV_PHASES, 5, 1), phaseName: 'done' };
  }

  if (hasResult) {
    const charsAfter = outputAfterMarker(output, '::result::');
    const intra = logProgress(charsAfter, 500);
    return { percent: computePhasePercent(DEV_PHASES, 4, intra), phaseName: 'committing' };
  }

  if (hasOpencode) {
    const charsAfter = outputAfterMarker(output, '::opencode::');

    if (charsAfter < OPENCODE_INITIAL_CHARS) {
      const intra = charsAfter / OPENCODE_INITIAL_CHARS;
      return { percent: computePhasePercent(DEV_PHASES, 1, intra), phaseName: 'initializing' };
    }

    const codingChars = charsAfter - OPENCODE_INITIAL_CHARS;

    if (codingChars < OPENCODE_INITIAL_CHARS) {
      const intra = codingChars / OPENCODE_INITIAL_CHARS;
      return { percent: computePhasePercent(DEV_PHASES, 2, intra), phaseName: 'analyzing' };
    }

    const intra = logProgress(codingChars - OPENCODE_INITIAL_CHARS, EXPECTED_MAX_OUTPUT);
    return { percent: computePhasePercent(DEV_PHASES, 3, intra), phaseName: 'coding' };
  }

  if (hasClone) {
    const charsAfter = outputAfterMarker(output, '::clone::');
    const intra = Math.min(charsAfter / 200, 1);
    return { percent: computePhasePercent(DEV_PHASES, 0, intra), phaseName: 'cloning' };
  }

  return { percent: 0, phaseName: 'cloning' };
}

function detectReviewProgress(output: string): ProgressState {
  const hasDone = output.includes('::done::');
  const hasVerdict = /VERDICT/i.test(output);
  const hasOpencode = output.includes('::opencode::');
  const hasClone = output.includes('::clone::');

  if (hasDone || hasVerdict) {
    return { percent: computePhasePercent(REVIEW_PHASES, 3, hasDone ? 1 : 0.5), phaseName: 'finalizing' };
  }

  if (hasOpencode) {
    const charsAfter = outputAfterMarker(output, '::opencode::');

    if (charsAfter < OPENCODE_INITIAL_CHARS) {
      const intra = charsAfter / OPENCODE_INITIAL_CHARS;
      return { percent: computePhasePercent(REVIEW_PHASES, 1, intra), phaseName: 'initializing' };
    }

    const intra = logProgress(charsAfter - OPENCODE_INITIAL_CHARS, EXPECTED_MAX_OUTPUT);
    return { percent: computePhasePercent(REVIEW_PHASES, 2, intra), phaseName: 'analyzing' };
  }

  if (hasClone) {
    const charsAfter = outputAfterMarker(output, '::clone::');
    const intra = Math.min(charsAfter / 200, 1);
    return { percent: computePhasePercent(REVIEW_PHASES, 0, intra), phaseName: 'cloning' };
  }

  return { percent: 0, phaseName: 'cloning' };
}
