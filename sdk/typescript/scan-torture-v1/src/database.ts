// HIGH: database mutation
export async function createDatabaseOrder() {
  return db.exec(
    "INSERT INTO orders (id) VALUES (123)"
  );
}
