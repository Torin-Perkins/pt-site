import type Stripe from "stripe";

/*
 * Billing plans point at a Stripe product (prod_…). Checkout charges the
 * product's current default price, so changing the price in Stripe takes
 * effect in the portal without editing the plan. Plans saved before this
 * may still hold a price id (price_…) instead; those keep working.
 */

export interface PlanRef {
  stripeProductId?: string | null;
  stripePriceId?: string | null;
}

/** The slice of the Stripe client this module uses (lets tests pass a fake). */
export interface StripeCatalog {
  products: { retrieve(id: string, params?: Stripe.ProductRetrieveParams): Promise<Stripe.Product> };
  prices: { retrieve(id: string): Promise<Stripe.Price> };
}

export type PlanMode = "payment" | "subscription";

export class PlanPriceError extends Error {}

/** Which Stripe price a plan charges right now, and whether it's recurring. */
export async function resolvePlanPrice(stripe: StripeCatalog, plan: PlanRef): Promise<{ priceId: string; mode: PlanMode; productId: string | null }> {
  let price: Stripe.Price;
  if (plan.stripeProductId) {
    const product = await stripe.products.retrieve(plan.stripeProductId, { expand: ["default_price"] });
    if (!product.active) throw new PlanPriceError("This item is archived in Stripe.");
    const dp = product.default_price;
    if (!dp) throw new PlanPriceError("This product has no default price in Stripe. Set one on the product page.");
    price = typeof dp === "string" ? await stripe.prices.retrieve(dp) : dp;
  } else if (plan.stripePriceId) {
    price = await stripe.prices.retrieve(plan.stripePriceId);
  } else {
    throw new PlanPriceError("This item isn't linked to a Stripe product yet.");
  }
  if (!price.active) throw new PlanPriceError("This item's price is inactive in Stripe.");
  const productId = typeof price.product === "string" ? price.product : price.product?.id ?? plan.stripeProductId ?? null;
  return { priceId: price.id, mode: price.recurring ? "subscription" : "payment", productId };
}

/** "$480 / month", "$1,200 every 3 months", "$325". */
export function formatPrice(price: Pick<Stripe.Price, "unit_amount" | "currency" | "recurring">): string {
  if (price.unit_amount == null) return "";
  const amount = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: price.currency.toUpperCase(),
    minimumFractionDigits: price.unit_amount % 100 === 0 ? 0 : 2,
  }).format(price.unit_amount / 100);
  const r = price.recurring;
  if (!r) return amount;
  return r.interval_count === 1 ? `${amount} / ${r.interval}` : `${amount} every ${r.interval_count} ${r.interval}s`;
}

/** What the admin form fills in from a Stripe product. */
export async function describeProduct(stripe: StripeCatalog, productId: string) {
  const product = await stripe.products.retrieve(productId, { expand: ["default_price"] });
  const dp = product.default_price;
  const price = !dp ? null : typeof dp === "string" ? await stripe.prices.retrieve(dp) : dp;
  return {
    productId: product.id,
    name: product.name,
    description: product.description ?? "",
    active: product.active,
    hasDefaultPrice: Boolean(price),
    priceDisplay: price ? formatPrice(price) : "",
    mode: (price?.recurring ? "subscription" : "payment") as PlanMode,
  };
}
