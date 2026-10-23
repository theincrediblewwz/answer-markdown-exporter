/** One budget for captured image assets across Markdown, preview and PDF. */
export const IMAGE_LIMITS = {
  count: 30,
  bytes: 8 * 1024 * 1024,
  totalBytes: 24 * 1024 * 1024,
  uriCharacters: 12_000_000,
  totalUriCharacters: 32_000_000,
} as const;
