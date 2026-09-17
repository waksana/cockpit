import { useCallback, useState } from 'react';

export function useClippedText(text: string, lines?: number) {
  const [clipped, setClipped] = useState(false);
  const ref = useCallback((element: HTMLSpanElement | null) => {
    if (!element) return;
    // Compare to the collapsed line budget even while expanded, so resizing
    // never removes the collapse action just because the full text is visible.
    const measure = () => setClipped(lines
      ? element.scrollHeight > parseFloat(getComputedStyle(element).lineHeight) * lines + 1
      : element.scrollWidth > element.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
    // Text replacements must remeasure even if their DOM node is retained.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, lines]);
  return { ref, clipped };
}
