// HIGH: payment side effect
export async function takePayment() {
  return stripe.paymentIntents.create({
    amount: 1000
  });
}
