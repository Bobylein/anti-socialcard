import { readFile } from "node:fs/promises";

export async function loadEnvFile(path, env = process.env) {
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }

  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) throw new Error(`Invalid .env entry on line ${index + 1}`);
    if (env[match[1]] !== undefined) continue;
    env[match[1]] = unquote(match[2].trim());
  }
  return true;
}

function unquote(value) {
  if (value.length >= 2 && value[0] === value.at(-1) && ["\"", "'"].includes(value[0])) {
    return value.slice(1, -1);
  }
  return value;
}
