import * as THREE from 'three';

/** Seamless staggered masonry with broad bevels and restrained hand-painted variation. */
export function arenaStoneTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 512;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#8c9ca1';
  ctx.fillRect(0, 0, 512, 512);
  const fills = ['#bdcbd0', '#b8c6cc', '#c4d0d2', '#b8c5c8', '#c0ccce'];
  const polygon = (x: number, y: number, inset: number): void => {
    const cut = 8;
    ctx.beginPath();
    ctx.moveTo(x + inset + cut, y + inset);
    ctx.lineTo(x + 128 - inset - cut, y + inset);
    ctx.lineTo(x + 128 - inset, y + inset + cut);
    ctx.lineTo(x + 128 - inset, y + 128 - inset - cut);
    ctx.lineTo(x + 128 - inset - cut, y + 128 - inset);
    ctx.lineTo(x + inset + cut, y + 128 - inset);
    ctx.lineTo(x + inset, y + 128 - inset - cut);
    ctx.lineTo(x + inset, y + inset + cut);
    ctx.closePath();
  };
  for (let row = 0; row < 4; row++) {
    for (let col = -1; col < 5; col++) {
      const x = col * 128 + (row % 2) * 64;
      const y = row * 128;
      const index = ((col + 4) % 4 * 7 + row * 3) % fills.length;
      ctx.fillStyle = '#a3b2b8';
      polygon(x, y, 2);
      ctx.fill();
      ctx.fillStyle = fills[index]!;
      polygon(x, y, 5);
      ctx.fill();
      ctx.strokeStyle = '#e0e6e7';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(x + 6, y + 109);
      ctx.lineTo(x + 6, y + 14);
      ctx.lineTo(x + 14, y + 6);
      ctx.lineTo(x + 114, y + 6);
      ctx.stroke();
      ctx.fillStyle = 'rgba(244,246,241,0.07)';
      ctx.beginPath();
      ctx.ellipse(x + 57, y + 42, 40, 20, -0.2, 0, Math.PI * 2);
      ctx.fill();
      if (index === 2) {
        ctx.strokeStyle = '#a3b3b8';
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.moveTo(x + 118, y + 112);
        ctx.lineTo(x + 100, y + 103);
        ctx.lineTo(x + 96, y + 88);
        ctx.stroke();
      }
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  return texture;
}
