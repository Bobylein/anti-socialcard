import { readFile } from "node:fs/promises";
import { Script } from "node:vm";

const indexPath = new URL("../index.html", import.meta.url);
const html = await readFile(indexPath, "utf8");
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .filter((match) => !/type=["']application\/json["']/i.test(match[0]))
  .map((match) => match[1]);

if (!scripts.length) throw new Error("No executable inline script found in index.html");

new Script(scripts.join("\n"), { filename: "index.html:inline-script" });
console.log("Generated browser script syntax is valid.");
