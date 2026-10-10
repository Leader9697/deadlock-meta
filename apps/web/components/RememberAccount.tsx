"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Remembers the account id in this browser; /me without ?account= reuses it. */
export function RememberAccount({ account, path }: { account: number | null; path: string }) {
  const router = useRouter();
  useEffect(() => {
    try {
      if (account) localStorage.setItem("dlm_account", String(account));
      else {
        const saved = Number(localStorage.getItem("dlm_account"));
        if (saved > 0) router.replace(`${path}?account=${saved}`);
      }
    } catch {
      // storage blocked: the form still works
    }
  }, [account, path, router]);
  return null;
}
