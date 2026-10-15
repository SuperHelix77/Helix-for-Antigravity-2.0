import {defineConfig} from 'vite';

export default defineConfig(({mode}) => ({base: './', server: {host: '127.0.0.1'}, build: {outDir: mode === 'monitor' ? 'dist-monitor' : 'dist'}}));
