import { RefObject, useEffect } from "react";

function useClickOutside<T extends HTMLElement>(
  ref: RefObject<T | null>,
  handler: (event: MouseEvent | TouchEvent) => void,
  ignoreRef?: RefObject<HTMLElement | null>, // 👈 optional second ref
): void {
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node;

      // If no element yet, or click is inside content, or click is inside trigger → ignore
      if (
        !ref.current ||
        ref.current.contains(target) ||
        (ignoreRef?.current && ignoreRef.current.contains(target))
      ) {
        return;
      }

      handler(event);
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("touchstart", handleClickOutside);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("touchstart", handleClickOutside);
    };
  }, [ref, handler, ignoreRef]);
}

export default useClickOutside;
