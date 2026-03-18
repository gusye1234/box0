import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export function ensureDataDir(): void {
  const baseDir = process.env.BOX0_DIR ?? path.join(os.homedir(), '.box0');
  const dirs = [baseDir, path.join(baseDir, 'data'), path.join(baseDir, 'logs')];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
