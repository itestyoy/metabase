import { useCallback, useState } from "react";

const STORAGE_KEY = "bi-agent-open";

function readOpen(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeOpen(v: boolean) {
  try {
    if (v) {
      localStorage.setItem(STORAGE_KEY, "1");
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // storage unavailable
  }
}

export function useAgentModal() {
  const [isOpen, setIsOpen] = useState(readOpen);
  const open = useCallback(() => {
    setIsOpen(true);
    writeOpen(true);
  }, []);
  const close = useCallback(() => {
    setIsOpen(false);
    writeOpen(false);
  }, []);
  return { isOpen, open, close };
}
