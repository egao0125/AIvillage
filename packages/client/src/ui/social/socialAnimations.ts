/** CSS keyframe animations for the social graph */

export const SOCIAL_KEYFRAMES = `
@keyframes socialBreathing {
  0%, 100% { stroke-dashoffset: 0; }
  50% { stroke-dashoffset: 8; }
}

@keyframes socialPulse {
  0%, 100% { opacity: 0.6; }
  50% { opacity: 1; }
}

@keyframes socialFlicker {
  0%, 100% { opacity: 0.8; }
  20% { opacity: 0.4; }
  40% { opacity: 0.9; }
  60% { opacity: 0.3; }
  80% { opacity: 0.7; }
}

@keyframes socialFadeIn {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}

@keyframes socialNodePop {
  0% { r: 0; opacity: 0; }
  70% { r: 22; opacity: 1; }
  100% { r: 18; opacity: 1; }
}

@keyframes socialPanelSlide {
  from { transform: translateX(100%); }
  to { transform: translateX(0); }
}
`;

/** Mood → border color for node mood ring.
 *  Uses keyword scanning since LLM returns freeform strings like
 *  "Focused. Tired of the noise." not single-word moods.
 *  Colors are neon-saturated for glow filter visibility. */
export function moodColor(mood: string): string {
  const m = mood.toLowerCase();
  if (/happy|joyful|excited|hopeful|relieved|grateful|proud|warm/.test(m)) return '#00ff88';
  if (/sad|grieving|melancholy|lonely|loss|hollow|numb|empty/.test(m)) return '#4488ff';
  if (/angry|furious|resentful|frustrated|bitter|rage/.test(m)) return '#ff4444';
  if (/anxious|fearful|paranoid|nervous|worried|terrified|scared|tense|uneasy/.test(m)) return '#ffaa00';
  if (/neutral|calm|content|steady|quiet|settled|focused|clear|grounded/.test(m)) return '#8866ff';
  return '#556688';
}

/** Agent state → node fill opacity */
export function stateOpacity(state: string): number {
  switch (state) {
    case 'active': return 1;
    case 'routine': return 0.95;
    case 'idle': return 0.85;
    case 'sleeping': return 0.65;
    default: return 0.7;
  }
}
