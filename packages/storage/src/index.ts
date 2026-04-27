import { createSqliteRepository, DEFAULT_DATABASE_PATH } from "./sqlite.js";
import { createJsonFileRepository, DEFAULT_JSON_DATABASE_PATH } from "./memory.js";
import type { ZyquorRepository } from "./types.js";

export * from "./types.js";
export * from "./sqlite.js";
export * from "./memory.js";
export * from "./mappers.js";
export * from "./utils.js";

export async function createLocalRepository(filePath = DEFAULT_DATABASE_PATH): Promise<ZyquorRepository> {
  try {
    return await createSqliteRepository(filePath);
  } catch (error) {
    console.warn("Failed to create SQLite repository, falling back to JSON file:", error);
    return createJsonFileRepository(DEFAULT_JSON_DATABASE_PATH);
  }
}
