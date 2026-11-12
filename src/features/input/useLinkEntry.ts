import { useEffect, useRef, useState } from "react";

/** A paste on the empty screen waits for the user's Fetch or Scrape choice. */
export function useLinkEntry(analyzing: boolean) {
  const [value, setValue] = useState("");
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (analyzing) return;
    const paste = (event: ClipboardEvent) => {
      if (event.target instanceof Element && event.target.closest("input, textarea, [contenteditable]")) return;
      const url = event.clipboardData?.getData("text").trim() ?? "";
      if (!/^https?:\/\//i.test(url)) return;
      event.preventDefault();
      setValue(url);
      field.current?.focus();
    };
    window.addEventListener("paste", paste);
    return () => window.removeEventListener("paste", paste);
  }, [analyzing]);

  return { value, setValue, field, valid: /^https?:\/\//i.test(value.trim()) };
}
