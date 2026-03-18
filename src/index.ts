#!/usr/bin/env node
import { Command } from 'commander';
import { importCommand } from './commands/import';
import { searchCommand } from './commands/search';
import { listCommand } from './commands/list';
import { versionCommand } from './commands/version';
import { pluginCommand } from './commands/plugin';
import { statsCommand } from './commands/stats';
import { suggestSkillsCommand } from './commands/suggest-skills';
import { insightCommand } from './commands/insight';
import { ensureDataDir } from './lib/dataDir';
import { closeDb } from './lib/db';

async function main() {
  ensureDataDir();
  const program = new Command();
  program
    .name('box0')
    .description('Agent Native Dropbox — local-first context + file sync across AI agents');
  program.addCommand(importCommand);
  program.addCommand(searchCommand);
  program.addCommand(listCommand);
  program.addCommand(versionCommand);
  program.addCommand(pluginCommand);
  program.addCommand(statsCommand);
  program.addCommand(suggestSkillsCommand);
  program.addCommand(insightCommand);
  await program.parseAsync(process.argv);
  closeDb();
}

main().catch((err) => { console.error(err); process.exit(1); });
