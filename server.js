import path from 'node:path';
import { isAnalysisConfigured } from './src/analyse.js';
import { createApp } from './src/app.js';

const port = Number(process.env.PORT) || 3000;
const dataDir = path.resolve(process.env.DATA_DIR || 'data');

const { app, queue } = createApp({ dataDir });
queue.resume();

app.listen(port, () => {
  console.log(`ED & LGR database running at http://localhost:${port}`);
  console.log(`Data is stored in ${dataDir}`);
  if (!isAnalysisConfigured()) {
    console.warn('ANTHROPIC_API_KEY is not set: new entries will be saved without automatic analysis.');
  }
});
