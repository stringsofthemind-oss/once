// HIGH: message side effect
export async function deliverReceipt() {
  return sendEmail({
    to: "customer@example.com"
  });
}
