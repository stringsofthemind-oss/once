export async function readUsers(prisma: any) {
  return prisma.user.findMany();
}
