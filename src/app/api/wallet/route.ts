import { readWallet } from "@/lib/wallet";

// Read-only: looks up a wallet's balance by address on Kite testnet.
export async function GET(req: Request) {
  const address = new URL(req.url).searchParams.get("address") ?? "";
  try {
    return Response.json(await readWallet(address));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Couldn't read the wallet" }, { status: 400 });
  }
}
