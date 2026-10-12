// 信息面板中的"照片"和"内参"两个分区，内参分区带来源切换（EXIF / 标定文件 / 真值）。

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (x, d = 1) => (x == null || Number.isNaN(x) ? '—' : Number(x).toFixed(d));
const kv = (rows) => '<dl class="kv">' + rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('') + '</dl>';
const notesHTML = (notes) => notes.map((n) => `<p class="note ${n.level}">${esc(n.text)}</p>`).join('');

/**
 * @param {ReturnType<import('./infoPanel.js').createInfoPanel>} panel
 * @param {{ image: import('../state.js').ImageInput, intrinsics: import('../state.js').Intrinsics,
 *           truth: object|null, notes: {level:string, text:string}[],
 *           calibAvailable: boolean, onSourceChange: (s: string) => void }} p
 */
export function renderImagePanel(panel, { image, intrinsics, truth, notes, calibAvailable, selfFocal = null, onSourceChange }) {
  const e = image.exif;
  const camera = [e.make, e.model].filter(Boolean).join(' ');
  const body = panel.setCustom('image', '照片');
  body.innerHTML = kv([
    ['文件', esc(image.fileName)],
    ['分辨率', `${image.width} × ${image.height}`],
    ...(truth
      ? [['类型', '合成图（带真值）']]
      : [
          ['机型', camera ? esc(camera) : '—'],
          ['镜头', e.lensModel ? esc(e.lensModel) : '—'],
          ['等效焦距', e.focal35 != null ? `${e.focal35} mm` : '—（未读到 EXIF）'],
        ]),
  ]);

  const k = panel.setCustom('intrinsics', '内参');
  const sources = [
    { key: 'exif', label: 'EXIF', enabled: true },
    { key: 'calib', label: '标定文件', enabled: calibAvailable, title: calibAvailable ? '' : '没有 public/intrinsics.json（步骤 13 生成）' },
    {
      key: 'self',
      label: '照片估计',
      enabled: !!selfFocal?.reliable,
      title: selfFocal
        ? selfFocal.reliable ? '' : '这张照片接近正上方拍摄，无法估计焦距（斜拍 45°–75° 时可用）'
        : '位姿求出后才能估计',
    },
    ...(truth ? [{ key: 'truth', label: '真值', enabled: true }] : []),
  ];
  k.innerHTML =
    '<div class="seg" role="radiogroup" aria-label="内参来源">' +
    sources
      .map(
        (s) =>
          `<button type="button" role="radio" data-src="${s.key}" aria-checked="${s.key === intrinsics.source}"` +
          `${s.key === intrinsics.source ? ' class="on"' : ''}${s.enabled ? '' : ' disabled'} title="${esc(s.title ?? '')}">${s.label}</button>`,
      )
      .join('') +
    '</div>' +
    kv([
      ['fx / fy', `${fmt(intrinsics.fx)} / ${fmt(intrinsics.fy)}`],
      ['cx / cy', `${fmt(intrinsics.cx)} / ${fmt(intrinsics.cy)}`],
      ['来源', { exif: 'EXIF 等效焦距', calib: '标定文件', truth: '真值', self: '由这张照片估计' }[intrinsics.source]],
    ]) +
    notesHTML(notes);
  for (const b of k.querySelectorAll('.seg button')) {
    b.addEventListener('click', () => {
      if (!b.disabled && b.dataset.src !== intrinsics.source) onSourceChange(b.dataset.src);
    });
  }
}
