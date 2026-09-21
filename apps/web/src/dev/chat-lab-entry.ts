if (!import.meta.env.DEV || import.meta.env.COCKPIT_CHAT_LAB !== true) {
  throw new Error('Start the isolated chat lab with COCKPIT_CHAT_LAB=1.');
}

if (new URLSearchParams(location.search).get('ui') === 'next') {
  const nativeFetch = window.fetch.bind(window);
  const { isolateNextLab } = await import('./next-lab-isolation');
  isolateNextLab(window);
  if (new URLSearchParams(location.search).get('modules') === '1') {
    const { installSyntheticSpeech } = await import('./next-lab-speech');
    const { createModuleLab } = await import('./next-lab-module-transport');
    const controls = createModuleLab(nativeFetch, location.href, installSyntheticSpeech(window));
    Object.defineProperty(window, 'fetch', { configurable: true, value: controls.fetch });
    const { startModuleLab } = await import('./next-lab');
    startModuleLab(controls);
  } else await import('./next-lab');
} else {
  await import('./chat-lab');
}

export {};
