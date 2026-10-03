// Google Gemini 이미지 생성
export const DEFAULT_MODEL = 'gemini-3.1-flash-image';

export async function generateImage(prompt, key, model = DEFAULT_MODEL) {
  if (!key) throw new Error('API 키가 필요해요');
  const text =
    `A richly detailed, wide landscape-format (4:3) illustration of: ${prompt}. ` +
    'Clean flat-color illustration with clearly separated solid color areas and bold simple shapes. ' +
    'No gradients, no shading noise, no outlines, no text, no border, no frame. ' +
    'Many distinct objects across the whole scene, suitable for a paint-by-number coloring page.';
  if (/[^\x21-\x7e]/.test(key)) throw new Error('API 키에 영문·숫자 외의 글자가 들어 있어요');
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error?.message || `요청 실패 (${res.status})`);
  const parts = json.candidates?.[0]?.content?.parts || [];
  const img = parts.map(p => p.inlineData || p.inline_data).find(Boolean);
  if (!img) throw new Error('이미지가 생성되지 않았어요');
  const bin = atob(img.data), buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type: img.mimeType || img.mime_type || 'image/png' });
}
