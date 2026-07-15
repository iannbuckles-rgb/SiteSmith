import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    exclude: ['node_modules/**', 'dist/**', '.test-dist/**', 'e2e/**'],
    coverage: {
      provider: 'v8',
      enabled: true,
      reporter: ['text', 'html'],
      include: [
        'src/lib/archiveLimits.ts',
        'src/lib/assetReplacer.ts',
        'src/lib/exportService.ts',
        'src/lib/fileTypes.ts',
        'src/lib/filenameSanitizer.ts',
        'src/lib/fitStyles.ts',
        'src/lib/imageDetector.ts',
        'src/lib/lineDiff.ts',
        'src/lib/manualReplace.ts',
        'src/lib/pathRelative.ts',
        'src/lib/persistenceState.ts',
        'src/lib/persistedPatch.ts',
        'src/lib/undoStack.ts',
        'src/lib/urlResolver.ts',
        'src/lib/urlRewriter.ts',
        'src/lib/vitePortDetector.ts',
      ],
      thresholds: {
        lines: 80,
      },
    },
  },
});
