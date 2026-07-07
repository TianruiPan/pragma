export function hasLikelyMojibake(text) {
  return /\uFFFD|Ã.|Â.|â[\u0080-\u00BF]|ð[\u0080-\u00BF]/.test(String(text || ""));
}

export function utf8Diagnostics(buffer) {
  const text = buffer.toString("utf8");
  return {
    hasBom: buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf,
    hasReplacementCharacter: text.includes("\uFFFD"),
    hasMojibake: hasLikelyMojibake(text),
    text
  };
}
