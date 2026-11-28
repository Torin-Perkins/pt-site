import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { describeProduct, formatPrice, PlanPriceError, resolvePlanPrice, type StripeCatalog } from "../../src/lib/planPrice.js";

const price = (id: string, extra: Partial<Stripe.Price> = {}) =>
  ({ id, object: "price", active: true, product: "prod_x", currency: "usd", unit_amount: 48000, recurring: null, ...extra }) as Stripe.Price;
const monthly = price("price_month_v2", { recurring: { interval: "month", interval_count: 1 } as Stripe.Price.Recurring });

function catalog(products: Record<string, Partial<Stripe.Product>>, prices: Record<string, Stripe.Price> = {}): StripeCatalog & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    products: {
      retrieve: async (id) => {
        calls.push(`product ${id}`);
        if (!products[id]) throw new Error("missing");
        return { id, object: "product", active: true, name: "Item", description: null, ...products[id] } as Stripe.Product;
      },
    },
    prices: {
      retrieve: async (id) => {
        calls.push(`price ${id}`);
        return prices[id];
      },
    },
  };
}

describe("resolvePlanPrice", () => {
  it("charges the product's current default price", async () => {
    const s = catalog({ prod_x: { default_price: monthly } });
    expect(await resolvePlanPrice(s, { stripeProductId: "prod_x" })).toEqual({ priceId: "price_month_v2", mode: "subscription", productId: "prod_x" });
  });

  it("detects one-time packages", async () => {
    const s = catalog({ prod_pack: { default_price: price("price_pack", { product: "prod_pack" }) } });
    expect((await resolvePlanPrice(s, { stripeProductId: "prod_pack" })).mode).toBe("payment");
  });

  it("uses the product over an old saved price", async () => {
    const s = catalog({ prod_x: { default_price: monthly } });
    expect((await resolvePlanPrice(s, { stripeProductId: "prod_x", stripePriceId: "price_old" })).priceId).toBe("price_month_v2");
  });

  it("still supports plans saved with a price id", async () => {
    const s = catalog({}, { price_old: price("price_old") });
    expect(await resolvePlanPrice(s, { stripePriceId: "price_old" })).toMatchObject({ priceId: "price_old", mode: "payment" });
  });

  it("refuses products it can't sell", async () => {
    await expect(resolvePlanPrice(catalog({ prod_x: { default_price: null } }), { stripeProductId: "prod_x" })).rejects.toThrow(/no default price/);
    await expect(resolvePlanPrice(catalog({ prod_x: { active: false, default_price: monthly } }), { stripeProductId: "prod_x" })).rejects.toThrow(/archived/);
    await expect(resolvePlanPrice(catalog({ prod_x: { default_price: price("p", { active: false }) } }), { stripeProductId: "prod_x" })).rejects.toBeInstanceOf(PlanPriceError);
    await expect(resolvePlanPrice(catalog({}), {})).rejects.toThrow(/isn't linked/);
  });
});

describe("product details for the admin form", () => {
  it("formats prices", () => {
    expect(formatPrice(price("p"))).toBe("$480");
    expect(formatPrice(monthly)).toBe("$480 / month");
    expect(formatPrice(price("p", { unit_amount: 32550 }))).toBe("$325.50");
    expect(formatPrice(price("p", { unit_amount: 120000, recurring: { interval: "month", interval_count: 3 } as Stripe.Price.Recurring }))).toBe("$1,200 every 3 months");
  });

  it("describes a product", async () => {
    const s = catalog({ prod_x: { name: "Monthly Strength", description: "8 sessions", default_price: monthly } });
    expect(await describeProduct(s, "prod_x")).toEqual({
      productId: "prod_x",
      name: "Monthly Strength",
      description: "8 sessions",
      active: true,
      hasDefaultPrice: true,
      priceDisplay: "$480 / month",
      mode: "subscription",
    });
  });
});
