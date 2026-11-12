// The demo shops' names, shared by the server (x402 endpoints) and the Shops page.
export type ShopId = "coffee" | "rides" | "eats" | "store";

export const SHOPS: Record<ShopId, { name: string; sells: string }> = {
  coffee: { name: "Reins Coffee", sells: "Coffee and pastries" },
  rides: { name: "Reins Rides", sells: "Rides around town" },
  eats: { name: "Reins Eats", sells: "Food delivery" },
  store: { name: "Reins Store", sells: "Groceries, bills and everything else" },
};
