import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default {
  preprocess: vitePreprocess(),
  onwarn(warning, handler) {
    if (warning.code.startsWith('a11y_')) return;
    handler(warning);
  },
};
