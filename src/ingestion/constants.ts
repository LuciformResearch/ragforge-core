/**
 * Default glob patterns for file ingestion
 * Single source of truth used by brain-manager and code-source-adapter
 */

export const DEFAULT_INCLUDE_PATTERNS = [
  '**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx',
  '**/*.py',
  '**/*.vue', '**/*.svelte',
  '**/*.html', '**/*.css', '**/*.scss',
  '**/*.md', '**/*.json', '**/*.yaml', '**/*.yml',
  '**/*.pdf', '**/*.docx', '**/*.xlsx',
  '**/*.png', '**/*.jpg', '**/*.jpeg', '**/*.gif',
  '**/*.glb', '**/*.gltf',
];

export const DEFAULT_EXCLUDE_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/bundle/**',
  '**/__pycache__/**',
  '**/target/**',
  '**/.ragforge/**',
  '**/coverage/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/*.test.ts',
  '**/*.spec.ts',
];
