// 示例照片（public/samples/）：列表与加载。合成图带真值，内参直接取真值。

/** 示例目录的 URL（相对页面，兼容 GitHub Pages 子路径） */
const samplesURL = (name) => new URL(`samples/${name}`, document.baseURI).href;

/**
 * @returns {Promise<{key:string, label:string, image:string, truth?:string}[]>}
 */
export async function loadSampleIndex() {
  const res = await fetch(samplesURL('index.json'));
  if (!res.ok) throw new Error(`读取示例列表失败（${res.status}）`);
  return (await res.json()).samples;
}

/**
 * 加载一个示例
 * @param {{key:string, image:string, truth?:string}} entry
 * @returns {Promise<{image: import('../state.js').ImageInput, truth: import('../state.js').GroundTruth|null}>}
 */
export async function loadSample(entry) {
  const [imgRes, truthRes] = await Promise.all([
    fetch(samplesURL(entry.image)),
    entry.truth ? fetch(samplesURL(entry.truth)) : Promise.resolve(null),
  ]);
  if (!imgRes.ok) throw new Error(`读取示例图片失败（${imgRes.status}）`);
  const bitmap = await createImageBitmap(await imgRes.blob(), { imageOrientation: 'from-image' });
  const truth = truthRes ? await truthRes.json() : null;
  return {
    image: {
      bitmap,
      width: bitmap.width,
      height: bitmap.height,
      fileName: entry.image,
      exif: { focal35: null, focalMm: null, lensModel: null, make: null, model: null },
    },
    truth,
  };
}
