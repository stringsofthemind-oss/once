export async function uploadBackup(s3: any, command: any) {
  return s3.send(
    new PutObjectCommand(command)
  );
}
