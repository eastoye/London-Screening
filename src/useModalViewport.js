import { useLayoutEffect, useState } from "react";

// Mobile keyboards can resize the visual viewport without changing dvh.
export function useModalViewport(isOpen) {
  const [style, setStyle] = useState(undefined);
  useLayoutEffect(() => {
    if (!isOpen || !window.visualViewport) return;
    const viewport = window.visualViewport;
    const update = () => {
      // Preserve normal browser pinch zoom rather than moving the sheet with it.
      if (viewport.scale !== 1) return;
      setStyle({
        "--modal-viewport-height": `${viewport.height}px`,
        "--modal-viewport-top": `${viewport.offsetTop}px`,
      });
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, [isOpen]);
  return style;
}
