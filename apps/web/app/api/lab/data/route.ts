import { NextResponse } from "next/server";
import { getLabData } from "@/lib/lab";

/** Compact hero + item dataset for the Build Lab (cached 24 h). */
export async function GET() {
  return NextResponse.json(await getLabData(), { headers: { "cache-control": "public, max-age=3600" } });
}
