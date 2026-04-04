import Phaser from 'phaser';
import { BootScene } from './scenes/BootScene';
import { VillageScene } from './scenes/VillageScene';
import { ArenaScene } from './scenes/ArenaScene';

export const TILE_SIZE = 32;
export const MAP_WIDTH = 68;
export const MAP_HEIGHT = 45;

export function createGameConfig(parent: string, activeMap?: string): Phaser.Types.Core.GameConfig {
  const isArena = activeMap === 'battle_royale' || activeMap === 'werewolf';
  const bgColor = isArena ? '#1B3A4B' : '#f0ede4';

  return {
    type: Phaser.AUTO,
    parent,
    pixelArt: true,
    roundPixels: true,
    antialias: false,
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.NO_CENTER,
      width: '100%',
      height: '100%',
    },
    backgroundColor: bgColor,
    scene: [BootScene, VillageScene, ArenaScene],
    callbacks: {
      preBoot: (game) => {
        // Pass active map to BootScene via registry
        game.registry.set('activeMap', activeMap || 'village');
      },
    },
  };
}
