let cachedModelName = null;

async function getAvailableModel(apiKey) {
  if (cachedModelName) return cachedModelName;
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    const data = await res.json();

    if (data.models && Array.isArray(data.models)) {
      const allModels = data.models
        .filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'))
        .map(m => m.name.replace('models/', ''));

      console.log('[Gemini] All available models:', allModels);

      // STRICTLY select Flash models (Pro has limit: 0 on free tier)
      const flashModels = allModels.filter(m => m.includes('flash') && !m.includes('exp'));

      const preferred =
        flashModels.find(m => m === 'gemini-1.5-flash') ||
        flashModels.find(m => m === 'gemini-1.5-flash-8b') ||
        flashModels.find(m => m.includes('1.5-flash')) ||
        flashModels[0] ||
        'gemini-1.5-flash';

      cachedModelName = preferred;
      console.log(`[Gemini] Selected Free-Tier Flash Model: ${cachedModelName}`);
      return cachedModelName;
    }
  } catch (err) {
    console.error('[Gemini ListModels Error]', err.message);
  }

  return 'gemini-1.5-flash';
}
