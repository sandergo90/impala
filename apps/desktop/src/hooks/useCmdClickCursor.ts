import { useState, useEffect } from "react";

export function useCmdHeld(): boolean {
  const [held, setHeld] = useState(false);

  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.key === "Meta") setHeld(true);
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key === "Meta") setHeld(false);
    };
    const onBlur = () => setHeld(false);

    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  return held;
}
