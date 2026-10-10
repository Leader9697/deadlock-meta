import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Deadlock Meta",
  description: "Hero & item win rates, counter builds dan scouting pemain Deadlock",
};

const NAV = [
  { href: "/", label: "Hero Terkuat", hint: "Tier list: hero dengan win rate terbaik di periode & rank yang dipilih" },
  { href: "/draft", label: "Draft", hint: "Saat pilih hero: hero apa yang cocok dengan tim kamu dan melawan tim lawan, plus saran ban" },
  { href: "/counter", label: "Build vs Lawan", hint: "Build hero kamu per fase yang sudah disesuaikan dengan hero lawan" },
  { href: "/lab", label: "Kalkulator Build", hint: "Hitung DPS/HP/spirit dari item, bandingkan dua build" },
  { href: "/meta", label: "Tren Meta", hint: "Hero yang sedang naik/turun dan apa yang diubah patch" },
  { href: "/patches", label: "Patch Notes", hint: "Patch notes resmi, ditandai buff/nerf per hero dan item" },
  { href: "/me", label: "Profil Saya", hint: "Hero terbaik untuk kamu, review tiap match, dan kalibrasi overlay" },
  { href: "/players", label: "Cari Pemain", hint: "Statistik pemain dari Steam ID / nama" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <body>
        <header className="sticky top-0 z-20 border-b border-line bg-ink/85 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
            <Link href="/" className="font-display text-xl font-bold text-brass">
              Deadlock<span className="text-fg">Meta</span>
            </Link>
            <nav className="flex gap-1 overflow-x-auto text-sm">
              {NAV.map((n) => (
                <Link key={n.href} href={n.href} title={n.hint} className="whitespace-nowrap rounded-md px-3 py-1.5 text-muted hover:bg-panel-2 hover:text-fg">
                  {n.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
        <footer className="mx-auto max-w-6xl px-4 pb-8 text-xs text-muted">
          Data: deadlock-api.com (komunitas, bukan Valve). Statistik di-cache 10 menit.
        </footer>
      </body>
    </html>
  );
}
