export async function createAuditRow(supabase: any) {
  return supabase
    .from("audit")
    .insert({
      event: "charged"
    });
}
