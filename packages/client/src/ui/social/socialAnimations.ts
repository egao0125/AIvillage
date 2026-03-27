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

/** Mood → border color for node mood ring */
export function moodColor(mood: string): string {
  switch (mood) {
    case 'happy':
    case 'joyful':
    case 'excited':
      return '#4ade80';
    case 'sad':
    case 'grieving':
    case 'melancholy':
      return '#60a5fa';
    case 'angry':
    case 'furious':
    case 'resentful':
      return '#f87171';
    case 'anxious':
    case 'fearful':
    case 'paranoid':
      return '#fbbf24';
    case 'neutral':
    case 'calm':
    case 'content':
      return '#a78bfa';
    default:
      return '#8888aa';
  }
}

/** Agent state → node fill opacity */
export function stateOpacity(state: string): number {
  switch (state) {
    case 'active': return 1;
    case 'routine': return 0.85;
    case 'idle': return 0.6;
    case 'sleeping': return 0.4;
    default: return 0.3;
  }
}
