import React, { useRef, useEffect, useCallback } from 'react';
import {
  CHARACTER_MODELS,
  CHARACTER_MODEL_LABELS,
  type CharacterModel,
  STRIP_FRAME_W,
  STRIP_FRAME_H,
  STRIP_FRAMES_PER_DIR,
  STRIP_DISPLAY_SCALE,
  FOX_FRAME_W,
  FOX_FRAME_H,
  FOX_WALK_FRAMES,
  FOX_DISPLAY_SCALE,
  DOG_FRAME_W,
  DOG_FRAME_H,
  DOG_FRAMES_PER_DIR,
  DOG_DISPLAY_SCALE,
  GIRL_FRAME_W,
  GIRL_FRAME_H,
  GIRL_WALK_FRAMES,
  GIRL_DISPLAY_SCALE,
} from '../../game/data/sprite-config';
import { FONTS } from '../styles';

// Walk spritesheet paths per character model (bottom-left / SW direction)
function getWalkSheetPath(model: CharacterModel): string {
  switch (model) {
    case 'astronaut': return '/astronaut/WALKING.png';
    case 'ogre': return '/ogre/WALK.png';
    case 'smith': return '/smith/SMITH_WALK.png';
    case 'fox': return '/fox/Fox_Walk/Fox_Walk_dir1.png'; // dir1 = DL (southwest)
    case 'dog': return '/dog/GoldenRetriever_spritesheet_free.png';
    case 'girl': return '/girl/GirlSample_Walk_256Update/GirlSample_Walk_DownLeft.png';
  }
}

// Get frame extraction config for southwest-facing walk
function getFrameConfig(model: CharacterModel) {
  switch (model) {
    case 'astronaut':
    case 'ogre':
    case 'smith':
      // Strip: dir1 = SE (frames 6-11), flipX to get SW
      return {
        frameW: STRIP_FRAME_W,
        frameH: STRIP_FRAME_H,
        startFrame: STRIP_FRAMES_PER_DIR * 1, // direction 1 (SE)
        totalFrames: STRIP_FRAMES_PER_DIR,
        cols: STRIP_FRAMES_PER_DIR * 5,
        scale: STRIP_DISPLAY_SCALE * 1.5,
        fps: 10,
        flipX: true, // mirror SE → SW
        yOffset: 10,
      };
    case 'fox':
      // dir1 = DL (southwest), 12 walk frames in a 6-col grid
      return {
        frameW: FOX_FRAME_W,
        frameH: FOX_FRAME_H,
        startFrame: 0,
        totalFrames: FOX_WALK_FRAMES,
        cols: 6,
        scale: FOX_DISPLAY_SCALE * 1.5,
        fps: 16,
        flipX: false,
        yOffset: 30,
      };
    case 'dog':
      // Sheet walk row direction order (clockwise from south):
      //   0=D, 1=DR, 2=R, 3=UR, 4=U, 5=UL, 6=L, 7=DL
      // DL (southwest / bottom-left) = index 7
      return {
        frameW: DOG_FRAME_W,
        frameH: DOG_FRAME_H,
        startFrame: 32 + DOG_FRAMES_PER_DIR * 7, // walk row + DL offset
        totalFrames: DOG_FRAMES_PER_DIR,
        cols: 32,
        scale: DOG_DISPLAY_SCALE * 2,
        fps: 8,
        flipX: false,
        yOffset: 10,
      };
    case 'girl':
      // Walk DownLeft: 9 frames in a 4-col x 3-row grid
      return {
        frameW: GIRL_FRAME_W,
        frameH: GIRL_FRAME_H,
        startFrame: 0,
        totalFrames: 9,
        cols: 4,
        scale: GIRL_DISPLAY_SCALE * 1.5,
        fps: 12,
        flipX: false,
        yOffset: 16,
      };
  }
}

interface CharacterPickerProps {
  value: CharacterModel;
  onChange: (model: CharacterModel) => void;
  accentColor?: string;
  labelColor?: string;
  bgColor?: string;
}

const CANVAS_SIZE = 128;

export const CharacterPicker: React.FC<CharacterPickerProps> = ({
  value,
  onChange,
  accentColor = '#2a8a6a',
  labelColor = '#777770',
  bgColor = '#eeeee8',
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  const currentIndex = CHARACTER_MODELS.indexOf(value);

  const prev = useCallback(() => {
    const idx = (currentIndex - 1 + CHARACTER_MODELS.length) % CHARACTER_MODELS.length;
    onChange(CHARACTER_MODELS[idx]);
  }, [currentIndex, onChange]);

  const next = useCallback(() => {
    const idx = (currentIndex + 1) % CHARACTER_MODELS.length;
    onChange(CHARACTER_MODELS[idx]);
  }, [currentIndex, onChange]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let cancelled = false;
    let raf = 0;
    let frame = 0;
    let lastTime = 0;

    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    const img = new Image();
    img.src = getWalkSheetPath(value);
    imgRef.current = img;

    const config = getFrameConfig(value);

    const animate = (time: number) => {
      if (cancelled) return;
      const interval = 1000 / config.fps;
      if (time - lastTime >= interval) {
        lastTime = time;

        ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

        if (img.complete && img.naturalWidth > 0) {
          const frameIndex = config.startFrame + (frame % config.totalFrames);
          const col = frameIndex % config.cols;
          const row = Math.floor(frameIndex / config.cols);
          const sx = col * config.frameW;
          const sy = row * config.frameH;

          const drawW = config.frameW * config.scale;
          const drawH = config.frameH * config.scale;
          const dx = (CANVAS_SIZE - drawW) / 2;
          const dy = (CANVAS_SIZE - drawH) / 2 + (config.yOffset ?? 0);

          ctx.save();
          ctx.imageSmoothingEnabled = false;
          if (config.flipX) {
            ctx.translate(CANVAS_SIZE, 0);
            ctx.scale(-1, 1);
          }
          ctx.drawImage(img, sx, sy, config.frameW, config.frameH, dx, dy, drawW, drawH);
          ctx.restore();

          frame++;
        }
      }
      raf = requestAnimationFrame(animate);
    };

    const start = () => {
      if (cancelled) return;
      raf = requestAnimationFrame(animate);
    };

    img.onload = start;
    if (img.complete) start();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [value]);

  const arrowBtnStyle: React.CSSProperties = {
    background: 'none',
    border: `1px solid ${accentColor}`,
    borderRadius: 4,
    width: 28,
    height: 28,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    fontFamily: FONTS.pixel,
    fontSize: 10,
    color: accentColor,
    flexShrink: 0,
    transition: 'background 0.15s, color 0.15s',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      <label style={{
        fontFamily: FONTS.pixel,
        fontSize: 6,
        color: labelColor,
        letterSpacing: 1,
        textTransform: 'uppercase',
      }}>
        CHARACTER
      </label>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}>
        <button
          type="button"
          onClick={prev}
          style={arrowBtnStyle}
          onMouseEnter={(e) => { e.currentTarget.style.background = accentColor; e.currentTarget.style.color = '#fff'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = accentColor; }}
        >
          {'<'}
        </button>
        <div style={{
          width: CANVAS_SIZE,
          height: CANVAS_SIZE,
          background: bgColor,
          borderRadius: 6,
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}>
          <canvas ref={canvasRef} width={CANVAS_SIZE} height={CANVAS_SIZE} />
        </div>
        <button
          type="button"
          onClick={next}
          style={arrowBtnStyle}
          onMouseEnter={(e) => { e.currentTarget.style.background = accentColor; e.currentTarget.style.color = '#fff'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = accentColor; }}
        >
          {'>'}
        </button>
      </div>
      <span style={{
        fontFamily: FONTS.pixel,
        fontSize: 7,
        color: accentColor,
        letterSpacing: 1,
      }}>
        {CHARACTER_MODEL_LABELS[value]}
      </span>
    </div>
  );
};
