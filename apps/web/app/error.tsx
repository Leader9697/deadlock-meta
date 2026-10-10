"use client";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="rounded-xl border border-loss/40 bg-loss/10 p-6">
      <h2 className="font-display text-xl font-bold text-loss">Gagal ambil data</h2>
      <p className="mt-2 text-sm text-muted">
        deadlock-api tidak merespons atau kena rate limit (200 req/menit untuk analytics). Coba lagi sebentar.
      </p>
      <pre className="mt-3 overflow-x-auto text-xs text-muted">{error.message}</pre>
      <button onClick={reset} className="mt-4 rounded-md bg-brass px-4 py-2 text-sm font-semibold text-ink">
        Coba lagi
      </button>
    </div>
  );
}
