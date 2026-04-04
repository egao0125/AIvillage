/** Sprite layout configuration for all character types. */

// ── Direction Maps (verified visually) ───────────────────────────
//
// Strip-based (astronaut, ogre, smith) — 5 directions, flipX for the other 3:
//   index 0=S, 1=SE, 2=E, 3=NE, 4=N
//   SW = flipX(SE), W = flipX(E), NW = flipX(NE)
//
// Fox — 8 separate files per action, one per direction:
//   dir1=DL(SW), dir2=L(W), dir3=UL(NW), dir4=U(N),
//   dir5=UR(NE), dir6=R(E), dir7=DR(SE), dir8=D(S)
//
// Dog — single sheet, 8 directions packed left-to-right (clockwise from S):
//   index 0=D(S), 1=DR(SE), 2=R(E), 3=UR(NE),
//   4=U(N), 5=UL(NW), 6=L(W), 7=DL(SW)
//   Top row = idle, Bottom row = walk. 4 frames per direction.
//
// Girl — 8 separate files per action, named by direction:
//   Files: Down, DowlLeft, Left, UpLeft, Up, UpRight, Right, DownRight
//   256x256 frames, 4 cols x 2 rows, 5 frames per direction.
//   Same dir mapping as fox: dir1=DL, dir2=L, etc.
//

// ── Strip-based characters (astronaut, ogre, smith) ──────────────
// Single-row strips: 7740x258 = 30 frames of 258x258.
// 5 directions x 6 frames per direction.
// Directions: 0=S, 1=SE, 2=E, 3=NE, 4=N. Mirror via flipX for SW/W/NW.
export const STRIP_FRAME_W = 258;
export const STRIP_FRAME_H = 258;
export const STRIP_FRAMES_PER_DIR = 6;
export const STRIP_DIRECTIONS = 5;
export const STRIP_DISPLAY_SCALE = 0.3;

export const STRIP_IDLE_FPS = 6;
export const STRIP_WALK_FPS = 10;
export const STRIP_DIE_FPS = 8;
export const STRIP_SLEEP_FPS = 4;

// ── Fox (8-direction, separate files per direction) ──────────────
// Each file is a grid: Idle = 1536x1024 (256x256 frames, 6 cols), Walk = 1536x512.
// Idle = 20 frames (rows: 6+6+6+2), Walk = 12 frames (rows: 6+6).
// 8 directions: dir1=DL, dir2=L, dir3=UL, dir4=U, dir5=UR, dir6=R, dir7=DR, dir8=D
export const FOX_FRAME_W = 256;
export const FOX_FRAME_H = 256;
export const FOX_IDLE_FRAMES = 20;
export const FOX_WALK_FRAMES = 12;
export const FOX_DIRECTIONS = 8;
export const FOX_DISPLAY_SCALE = 0.3;

export const FOX_IDLE_FPS = 8;
export const FOX_WALK_FPS = 10;


// ── Dog (single small spritesheet) ───────────────────────────────
// 1024x64 = 32x32 frames, 32 cols x 2 rows = 64 frames.
// Top row: idle across 8 directions (4 frames each = 32).
// Bottom row: walk across 8 directions (4 frames each = 32).
export const DOG_FRAME_W = 32;
export const DOG_FRAME_H = 32;
export const DOG_FRAMES_PER_DIR = 4;
export const DOG_DIRECTIONS = 8;
export const DOG_DISPLAY_SCALE = 1.4; // 32px * 1.4 ≈ 45px — small critter

export const DOG_IDLE_FPS = 6;
export const DOG_WALK_FPS = 8;

// ── Girl (8-direction, separate files per direction) ─────────────
// Walk: 1024x768 = 256x256 frames, 4 cols x 3 rows, 9 frames per direction.
// Run:  1024x512 = 256x256 frames, 4 cols x 2 rows, 5 frames per direction.
// 8 directions: same as fox (DL, L, UL, U, UR, R, DR, D).
// Walk files: GirlSample_Walk_{Down,DownLeft,Left,UpLeft,Up,UpRight,Right,DownRight}.png
// Run files:  GirlSample_Run_{Down,DowlLeft,Left,UpLeft,Up,UpRight,Right,DownRight}.png
export const GIRL_FRAME_W = 256;
export const GIRL_FRAME_H = 256;
export const GIRL_WALK_FRAMES = 9;
export const GIRL_RUN_FRAMES = 5;
export const GIRL_DEATH_FRAMES = 28; // 1024x1792 = 4 cols x 7 rows
export const GIRL_DIRECTIONS = 8;
export const GIRL_DISPLAY_SCALE = 0.3;

export const GIRL_WALK_FPS = 10;

// ── Supported character models ───────────────────────────────────
export type CharacterModel = 'astronaut' | 'ogre' | 'smith' | 'fox' | 'dog' | 'girl';

export const CHARACTER_MODELS: CharacterModel[] = ['astronaut', 'ogre', 'smith', 'fox', 'dog', 'girl'];

export const CHARACTER_MODEL_LABELS: Record<CharacterModel, string> = {
  astronaut: 'Astronaut',
  ogre: 'Ogre',
  smith: 'Smith',
  fox: 'Fox',
  dog: 'Golden Retriever',
  girl: 'Girl',
};

/** Per-model sprite Y offset (negative = up from anchor). */
export const MODEL_Y_OFFSET: Record<CharacterModel, number> = {
  astronaut: -10,
  ogre: -10,
  smith: -10,
  fox: 0,    // fox sits on the ground
  dog: -12,
  girl: -10,
};

/** Map character model to the internal texture prefix used for animation keys. */
export function modelToPrefix(model: CharacterModel): string {
  switch (model) {
    case 'astronaut': return 'astro';
    case 'ogre': return 'ogre';
    case 'smith': return 'smith';
    case 'fox': return 'fox';
    case 'dog': return 'dog';
    case 'girl': return 'girl';
  }
}

/** Whether a model uses 8-direction system (no flipX mirroring). */
export function is8Dir(model: CharacterModel): boolean {
  return model === 'fox' || model === 'dog' || model === 'girl';
}
