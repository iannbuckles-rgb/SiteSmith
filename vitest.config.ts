import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    exclude: ['node_modules/**', 'dist/**', '.test-dist/**'],
    coverage: {
      provider: 'v8',
      enabled: true,
      reporter: ['text', 'html'],
      include: [
        'src/lib/assetReplacer.ts',
        'src/lib/exportService.ts',
        'src/lib/filenameSanitizer.ts',
        'src/lib/fitStyles.ts',
        'src/lib/imageDetector.ts',
        'src/lib/lineDiff.ts',
        'src/lib/manualReplace.ts',
        'src/lib/pathRelative.ts',
        'src/lib/undoStack.ts',
        'src/lib/urlResolver.ts',
        'src/lib/urlRewriter.ts',
      ],
      thresholds: {
        lines: 80,
      },
    },
  },
});
