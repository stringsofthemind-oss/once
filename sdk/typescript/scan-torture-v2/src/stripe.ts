export async function chargeStripe(stripe: any) {
  return stripe.paymentIntents.create({
    amount: 2500,
    currency: "gbp"
  });
}
