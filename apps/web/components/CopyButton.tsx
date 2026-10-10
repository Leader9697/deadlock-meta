"use client";

import { useState } from "react";

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const ta = document.createElement("textarea");
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
        }
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
      className={`rounded-md px-2.5 py-1 text-xs font-semibold transition ${
        done ? "bg-win/20 text-win" : "bg-brass/15 text-brass hover:bg-brass/25"
      }`}
    >
      {done ? "Tersalin ✓" : label}
    </button>
  );
}
