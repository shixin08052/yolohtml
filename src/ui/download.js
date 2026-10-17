// 下载文件（浏览器）：文本、Blob、canvas → PNG
export function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export const downloadText = (text, name, type = 'text/plain;charset=utf-8') => downloadBlob(new Blob([text], { type }), name);

/** canvas → PNG 下载 */
export function downloadCanvas(canvas, name) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error('生成图片失败'));
      downloadBlob(blob, name);
      resolve();
    }, 'image/png');
  });
}

/** SVG 文本 → PNG（scale 倍分辨率，白底） */
export async function svgToCanvas(svg, width, height, scale = 3) {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = new Image();
    img.decoding = 'sync';
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('SVG 转图片失败'));
      img.src = url;
    });
    const c = document.createElement('canvas');
    c.width = Math.round(width * scale);
    c.height = Math.round(height * scale);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}
