import { Command } from 'commander';
import * as path from 'path';

export const versionCommand = new Command('version')
  .description('Print the box0 version')
  .action(() => {
    // __dirname is dist/commands/ at runtime; package.json is at project root
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require(path.join(__dirname, '..', '..', 'package.json')) as { version: string };
    console.log(`box0 v${pkg.version}`);
  });
