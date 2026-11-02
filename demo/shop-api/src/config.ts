export const config = {
  shippingFlatCents: Number(process.env.SHIPPING_FLAT ?? 500),
  freeShippingThresholdCents: 5000,
  reportsToken: "reports-token",
} as const;
