function jsonFile(path, content) {
  return { path, kind: "json", content };
}
function textFile(path, content) {
  return { path, kind: "text", content };
}
function binaryFile(path, base64, mime, checksum) {
  return { path, kind: "binary", base64, mime, checksum };
}
function createPragmaInputBundle(files, createdAt = (/* @__PURE__ */ new Date()).toISOString(), summary = {}) {
  return {
    schemaVersion: "2.0",
    kind: "pragma-figma-capture-bundle",
    createdAt,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    summary
  };
}
function bundleFilePaths(bundle) {
  return bundle.files.map((file) => file.path).sort();
}
export {
  binaryFile,
  bundleFilePaths,
  createPragmaInputBundle,
  jsonFile,
  textFile
};
