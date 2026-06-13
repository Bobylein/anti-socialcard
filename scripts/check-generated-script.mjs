import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Script } from "node:vm";

const indexPath = new URL("../index.html", import.meta.url);
const html = await readFile(indexPath, "utf8");
const sourcePath = new URL("../src/browser/site.js", import.meta.url);
const generatedPath = new URL("../assets/site.js", import.meta.url);
const styleSourcePath = new URL("../src/browser/site.css", import.meta.url);
const generatedStylePath = new URL("../assets/site.css", import.meta.url);
const source = await readFile(sourcePath, "utf8");
const generated = await readFile(generatedPath, "utf8");
const styleSource = await readFile(styleSourcePath, "utf8");
const generatedStyle = await readFile(generatedStylePath, "utf8");

assert.match(html, /<link rel="stylesheet" href="assets\/site\.css">/);
assert.match(html, /<script src="assets\/site\.js"><\/script>/);
assert.doesNotMatch(html, /<style>/);
assert.doesNotMatch(html, /<script>\s*const initiatives/);
assert.equal(generated, source, "Generated browser script differs from src/browser/site.js");
assert.equal(generatedStyle, styleSource, "Generated browser styles differ from src/browser/site.css");

new Script(source, { filename: "src/browser/site.js" });
console.log("Generated browser script syntax is valid.");
