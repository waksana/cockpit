function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Spinner regression: ${message}`);
}

export async function runSpinnerChecks() {
  check(import.meta.env.DEV && import.meta.env.COCKPIT_CHAT_LAB === true, 'isolated Chat Lab required');
  const icons = Array.from(document.querySelectorAll<HTMLElement>(
    '.ck-icon.spinner, .tool-state-icon[data-status="in_progress"]',
  ));
  check(icons.length, 'at least one loading indicator required');
  const duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 1600 : 700;
  const near = (actual: number, expected: number) => Math.abs(actual - expected) < 0.05;
  const center = (element: Element) => {
    const r = element.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  };
  let samples = 0;
  for (const icon of icons) {
    const svg = icon.querySelector('svg');
    const path = svg?.querySelector('path');
    check(svg && path, 'original Lucide arc required');
    check(icon.getAnimations().length === 0 && svg.getAnimations().length === 0, 'viewport must not rotate');
    const animation = path.getAnimations()[0];
    check(animation, 'arc must animate');
    check(animation.effect?.getTiming().duration === duration, 'original motion preference retained');
    check(getComputedStyle(path).transformBox === 'view-box', 'rotate around viewBox, not arc bounds');
    const oldStyle = icon.getAttribute('style');
    const oldTime = animation.currentTime;
    const oldState = animation.playState;
    animation.pause();
    try {
      for (const size of [10, 16, 20, 24]) {
        for (const [font, lineHeight] of [['sans-serif', 'normal'], ['serif', '48px'], ['monospace', '10px']]) {
          Object.assign(icon.style, {
            width: `${size}px`, height: `${size}px`, fontFamily: font, lineHeight,
            position: 'relative', left: '0.25px', top: '0.5px',
          });
          const expected = center(icon);
          const containers: Element[] = [];
          for (let parent = icon.parentElement; parent; parent = parent.parentElement) containers.push(parent);
          const scroll = containers.map(el => [el.scrollWidth, el.scrollHeight]);
          for (let phase = 0; phase < 360; phase += 30) {
            animation.currentTime = duration * phase / 360;
            const box = icon.getBoundingClientRect();
            const viewport = svg.getBoundingClientRect();
            check(near(box.width, size) && near(box.height, size)
              && near(viewport.width, size) && near(viewport.height, size), 'stationary square viewport');
            check(near(center(icon).x, expected.x) && near(center(icon).y, expected.y), 'stationary layout center');
            // The root stays untransformed; legacy WebKit CTM under a rotating HTML parent is unreliable.
            const matrix = path.getScreenCTM();
            check(matrix, 'painted arc matrix available');
            const point = new DOMPoint(12, 12).matrixTransform(matrix);
            check(near(point.x, expected.x) && near(point.y, expected.y), 'arc keeps the viewBox center');
            containers.forEach((el, i) => check(el.scrollWidth === scroll[i][0]
              && el.scrollHeight === scroll[i][1], 'rotation must not change ancestor scroll extents'));
            samples++;
          }
        }
      }
    } finally {
      if (oldStyle === null) icon.removeAttribute('style');
      else icon.setAttribute('style', oldStyle);
      animation.currentTime = oldTime;
      if (oldState === 'running') animation.play();
    }
  }
  const before = icons.map(center);
  const transforms = new Set<string>();
  const start = performance.now();
  let frames = 0;
  while (performance.now() - start < duration + 50) {
    await new Promise(requestAnimationFrame);
    icons.forEach((icon, i) => {
      const point = center(icon);
      check(near(point.x, before[i].x) && near(point.y, before[i].y), 'live animation keeps layout stable');
      transforms.add(getComputedStyle(icon.querySelector('path')!).transform);
    });
    frames++;
  }
  check(frames > 1 && transforms.size > 1, 'sample running animation, not only paused phases');
  for (const icon of Array.from(document.querySelectorAll('.tool-state-icon:not([data-status="in_progress"])'))) {
    check(icon.getAnimations({ subtree: true }).length === 0, 'non-running tool states must not spin');
  }
  return { icons: icons.length, duration, samples, frames, viewport: [innerWidth, innerHeight] };
}
