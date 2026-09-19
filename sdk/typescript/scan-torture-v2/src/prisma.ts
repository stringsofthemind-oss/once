export async function updateCustomer(prisma: any) {
  return prisma.customer.update({
    where: { id: "123" },
    data: { active: false }
  });
}
