import { concat, keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Every visitor gets their own Reins wallet on Kite testnet. The browser keeps a random wallet id;
// the server turns it into a private key by hashing it with the owner's key, so keys never leave
// the server and nothing extra has to be stored. The owner (the project's creator) keeps the
// original agent wallet: their browser sends the owner key once it has opened the owner link.

export const WALLET_HEADER = "x-reins-wallet";
export const OWNER_HEADER = "x-reins-owner";
const validId = (id: string | null): id is string => !!id && /^[a-f0-9]{32}$/.test(id);

export type AgentWallet = { key: Hex; address: `0x${string}`; owner: boolean };

export function ownerKey(): Hex | null {
  const k = process.env.KITE_AGENT_PRIVATE_KEY as Hex | undefined;
  return k && /^0x[0-9a-fA-F]{64}$/.test(k) ? k : null;
}
export function ownerWallet(): AgentWallet | null {
  const key = ownerKey();
  return key ? { key, address: privateKeyToAccount(key).address, owner: true } : null;
}
export function isOwner(req: Request) {
  const secret = process.env.KITE_TEST_KEY;
  return !!secret && req.headers.get(OWNER_HEADER) === secret;
}

// The wallet a request should pay from: the owner's, or the visitor's own
export function walletFor(req: Request): AgentWallet | null {
  const base = ownerKey();
  if (!base) return null;
  if (isOwner(req)) return ownerWallet();
  const id = req.headers.get(WALLET_HEADER);
  if (!validId(id)) return null;
  const key = keccak256(concat([base, toHex(`reins-user-wallet:${id}`)]));
  return { key, address: privateKeyToAccount(key).address, owner: false };
}
