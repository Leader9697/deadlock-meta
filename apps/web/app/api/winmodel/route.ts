import { NextResponse } from "next/server";
import { getWinModel, lastError, lastShape } from "@/lib/winmodel";

/** Debug/inspection: fitted win-probability model and data shape. */
export async function GET() {
  const model = await getWinModel();
  return NextResponse.json({ ok: !!model, error: lastError, shape: lastShape ? JSON.parse(lastShape) : null, model });
}
