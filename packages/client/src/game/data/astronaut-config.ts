/** Astronaut spritesheet layout configuration.
 *  Sheets are single-row strips: 7740×258 = 30 frames of 258×258.
 *  5 directions × 6 frames per direction.
 *  Directions run left-to-right: 0°, 45°, 90°, 135°, 180°.
 *  Mirror (flipX) for 225°, 270°, 315°.
 */
export const ASTRO_FRAME_W = 258;
export const ASTRO_FRAME_H = 258;
export const ASTRO_FRAMES_PER_DIR = 6;
export const ASTRO_DIRECTIONS = 5; // 0°, 45°, 90°, 135°, 180°

/** Animation frame rate */
export const ASTRO_IDLE_FPS = 6;
export const ASTRO_WALK_FPS = 10;
export const ASTRO_DIE_FPS = 8;
