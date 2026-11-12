import { createPublicClient, defineChain, erc20Abi, formatUnits, http, isAddress, type Address } from "viem";

// Read-only wallet connection: we only ever READ the balance by address.
// Reins never holds the user's keys and cannot move money from this wallet.

export const kiteTestnet = defineChain({
  id: 2368,
  name: "KiteAI Testnet",
  nativeCurrency: { name: "KITE", symbol: "KITE", decimals: 18 },
  rpcUrls: { default: { http: [process.env.KITE_RPC_URL || "https://rpc-testnet.gokite.ai/"] } },
  blockExplorers: { default: { name: "KiteScan", url: "https://testnet.kitescan.ai" } },
  testnet: true,
});

// Faucet "Test USD" by default. Swap to pieUSD (0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A) if Kite confirms it.
export const WALLET_TOKEN = (process.env.WALLET_TOKEN_ADDRESS || "0x0fF5393387ad2f9f691FD6Fd28e07E3969e27e63") as Address;

const client = createPublicClient({ chain: kiteTestnet, transport: http() });

export async function readWallet(address: string) {
  if (!isAddress(address)) throw new Error("That doesn't look like a wallet address.");
  const [native, raw, decimals, symbol] = await Promise.all([
    client.getBalance({ address }),
    client.readContract({ address: WALLET_TOKEN, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
    client.readContract({ address: WALLET_TOKEN, abi: erc20Abi, functionName: "decimals" }),
    client.readContract({ address: WALLET_TOKEN, abi: erc20Abi, functionName: "symbol" }),
  ]);
  return {
    address,
    token: { address: WALLET_TOKEN, symbol, balance: Number(formatUnits(raw, decimals)) },
    native: { symbol: "KITE", balance: Number(formatUnits(native, 18)) },
    explorer: `https://testnet.kitescan.ai/address/${address}`,
  };
}
