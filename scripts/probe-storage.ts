(async () => {
  const st = await chrome.storage.local.get(null);
  const c = st['llmConfig'];
  return JSON.stringify({
    keys: Object.keys(st),
    hasLlmConfig: !!c,
    provider: c?.provider,
    baseUrl: c?.baseUrl,
    model: c?.model,
    keyLen: c?.apiKey?.length ?? 0,
    maxTokens: c?.maxTokens,
    settings: st['settings'],
  }, null, 2);
})()
