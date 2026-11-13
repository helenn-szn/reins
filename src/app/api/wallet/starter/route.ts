import { createPublicClient, createWalletClient, erc20Abi, http, parseEther, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { kiteTestnet, WALLET_TOKEN } from "@/lib/wallet";
import { tokenDecimals } from "@/lib/shops";
import { ownerWallet, walletFor } from "@/lib/wallets";

export const maxDuration = 60;

// "Get free test money": the owner's wallet sends a new visitor a small starter amount of test USDT
// plus a little KITE for network fees, once per wallet, so judges can try Reins without a faucet.
const STARTER_USDT = process.env.STARTER_USDT || "0.3"; // = $30 at the demo's 1/100 scale
const STARTER_KITE = process.env.STARTER_KITE || "0.005"; // enough for about 10 payments
const given = new Set<string>();
const perIp = new Map<string, number[]>();

export async function POST(req: Request) {
  const w = walletFor(req), owner = ownerWallet();
  if (!w || !owner) return Response.json({ error: "Missing your Reins wallet id. Reload the page and try again." }, { status: 400 });
  if (w.owner) return Response.json({ error: "This is the owner's wallet. Top it up from the Kite faucet." }, { status: 400 });

  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  const now = Date.now(), recent = (perIp.get(ip) || []).filter((t) => now - t < 3600_000);
  if (recent.length >= 3) return Response.json({ error: "Free test money is limited to a few wallets an hour. Try again later, or use the Kite faucet." }, { status: 429 });

  const pub = createPublicClient({ chain: kiteTestnet, transport: http() });
  const [usdt, kite] = await Promise.all([
    pub.readContract({ address: WALLET_TOKEN, abi: erc20Abi, functionName: "balanceOf", args: [w.address] }),
    pub.getBalance({ address: w.address }),
  ]);
  if (given.has(w.address) || usdt > BigInt(0) || kite > BigInt(0)) return Response.json({ error: "Your wallet already has test money. Starter money is once per wallet." }, { status: 400 });
  given.add(w.address); perIp.set(ip, [...recent, now]);

  try {
    const decimals = await tokenDecimals();
    const from = createWalletClient({ account: privateKeyToAccount(owner.key), chain: kiteTestnet, transport: http() });
    const t1 = await from.writeContract({ address: WALLET_TOKEN, abi: erc20Abi, functionName: "transfer", args: [w.address, parseUnits(STARTER_USDT, decimals)] });
    await pub.waitForTransactionReceipt({ hash: t1, timeout: 45_000 });
    const t2 = await from.sendTransaction({ to: w.address, value: parseEther(STARTER_KITE) });
    await pub.waitForTransactionReceipt({ hash: t2, timeout: 45_000 });
    return Response.json({ usdt: Number(STARTER_USDT), kite: Number(STARTER_KITE), tx: t1 });
  } catch (e) {
    given.delete(w.address);
    console.error("starter money failed", e);
    return Response.json({ error: "Couldn't send starter money right now. The owner's wallet may be low; try the Kite faucet instead." }, { status: 502 });
  }
}
