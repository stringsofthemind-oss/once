// LOW: local filesystem mutation
export async function saveReport() {
  return writeFile(
    "./report.json",
    "{}"
  );
}
