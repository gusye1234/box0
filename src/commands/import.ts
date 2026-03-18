import { Command } from 'commander';
import * as path from 'path';
import ora from 'ora';
import chalk from 'chalk';
import { AgentSource } from '../types';
import { defaultBasePath as claudeDefaultBasePath, importAll as claudeImportAll, importFile as claudeImportFile } from '../importers/claude-code';
import { defaultBasePath as openclawDefaultBasePath, importAll as openclawImportAll, runImportFromPlugin } from '../importers/openclaw';
import { defaultFilePath as chatgptDefaultFilePath, importFile as chatgptImportFile } from '../importers/chatgpt';
import { defaultBasePath as codexDefaultBasePath, importAll as codexImportAll } from '../importers/codex';

export function runImportFile(
  agent: AgentSource,
  filePath: string,
  opts?: { force?: boolean }
): { stdout: string; stderr: string; exitCode: number } {
  const absPath = path.resolve(filePath);
  try {
    let result: { inserted: boolean; messageCount: number; newMessages: number; unchanged?: boolean };
    if (agent === 'claude-code') {
      result = claudeImportFile(absPath, opts);
    } else {
      return { stdout: '', stderr: `Unsupported agent for --file import: ${agent}`, exitCode: 1 };
    }
    if (result.unchanged) {
      return { stdout: `File unchanged (cached).\n`, stderr: '', exitCode: 0 };
    }
    if (result.inserted) {
      return { stdout: `Imported 1 session, ${result.messageCount} messages.\n`, stderr: '', exitCode: 0 };
    }
    if (result.messageCount === 0) {
      return { stdout: `Imported 0 sessions, 0 messages.\n`, stderr: '', exitCode: 0 };
    }
    if (result.newMessages > 0) {
      return { stdout: `Updated session, ${result.newMessages} new messages.\n`, stderr: '', exitCode: 0 };
    }
    return { stdout: `Session up to date (${result.messageCount} messages).\n`, stderr: '', exitCode: 0 };
  } catch (err) {
    return { stdout: '', stderr: (err as Error).message, exitCode: 1 };
  }
}

function getStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

export const importCommand = new Command('import')
  .description('Import agent context from a source')
  .argument('<source>', 'Source to import from (claude-code | openclaw | codex | chatgpt)')
  .option('--path <dir>', 'Override the default source directory')
  .option('--file <path>', 'Import a single file (claude-code only)')
  .option('--stdin', 'Read JSON from stdin (openclaw plugin sync only)')
  .option('--force', 'Bypass file cache and re-import all files')
  .action(async (source: string, options: { path?: string; file?: string; stdin?: boolean; force?: boolean }) => {
    const forceOpts = { force: !!options.force };

    if (options.stdin) {
      if (source !== 'openclaw') {
        process.stderr.write("--stdin is only supported for 'openclaw' source\n");
        process.exit(1);
        return;
      }
      const raw = await getStdin();
      let parsed: { sessionKey?: string; messages?: unknown; workspaceDir?: string };
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        process.stderr.write(`Invalid JSON from stdin: ${(err as Error).message}\n`);
        process.exit(1);
        return;
      }
      if (!parsed.sessionKey || !Array.isArray(parsed.messages)) {
        process.stderr.write('Invalid stdin payload: sessionKey and messages array are required\n');
        process.exit(1);
        return;
      }
      const result = runImportFromPlugin({
        sessionKey: parsed.sessionKey,
        messages: parsed.messages,
        workspaceDir: parsed.workspaceDir,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr + '\n');
      if (result.exitCode !== 0) process.exit(result.exitCode);
      return;
    }
    if (options.file) {
      const result = runImportFile(source as AgentSource, options.file, forceOpts);
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr + '\n');
      if (result.exitCode !== 0) process.exit(result.exitCode);
      return;
    }
    const spinner = ora({ text: 'Scanning…' }).start();
    const startTime = Date.now();

    switch (source) {
      case 'claude-code': {
        const basePath = options.path ?? claudeDefaultBasePath();
        console.log(`Importing Claude Code sessions from ${basePath} …`);

        let result: ReturnType<typeof claudeImportAll>;
        try {
          result = claudeImportAll(basePath, ({ projName, files, inserted, skipped, unchanged }) => {
            spinner.clear();
            const parts = [chalk.green(inserted + ' inserted'), chalk.yellow(skipped + ' skipped')];
            if (unchanged > 0) parts.push(chalk.dim(unchanged + ' unchanged'));
            process.stdout.write(
              `  ${chalk.green('✔')} ${projName}  (${files} files)  →  ${parts.join(', ')}\n`
            );
            spinner.render();
          }, forceOpts);
        } catch (err) {
          spinner.fail(`Failed to import: ${(err as Error).message}`);
          process.exit(1);
          return;
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        spinner.succeed(`Done. ${result.inserted} sessions, ${result.messages} messages indexed in ${elapsed} s`);
        break;
      }

      case 'openclaw': {
        const basePath = options.path ?? openclawDefaultBasePath();
        console.log(`Importing OpenClaw sessions from ${basePath} …`);

        let result: ReturnType<typeof openclawImportAll>;
        try {
          result = openclawImportAll(basePath, (filePath, { inserted, messageCount, unchanged }) => {
            spinner.clear();
            const fileName = filePath.split('/').pop() ?? filePath;
            if (unchanged) {
              process.stdout.write(
                `  ${chalk.dim('–')} ${fileName}  →  ${chalk.dim('unchanged (cached)')}\n`
              );
            } else if (inserted) {
              process.stdout.write(
                `  ${chalk.green('✔')} ${fileName}  →  ${chalk.green(messageCount + ' messages')} (inserted)\n`
              );
            } else {
              process.stdout.write(
                `  ${chalk.yellow('–')} ${fileName}  →  ${chalk.yellow('skipped, already imported')}\n`
              );
            }
            spinner.render();
          }, forceOpts);
        } catch (err) {
          spinner.fail(`Failed to import: ${(err as Error).message}`);
          process.exit(1);
          return;
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        spinner.succeed(
          `Done. Sessions imported: ${result.inserted} new, ${result.skipped} skipped  |  Total messages: ${result.messages}  |  Time: ${elapsed}s`
        );
        break;
      }

      case 'chatgpt': {
        const filePath = options.path ?? chatgptDefaultFilePath();
        if (!filePath) {
          spinner.stop();
          console.error(chalk.red('Error: --path is required for chatgpt import. Provide the path to your conversations.json export file.'));
          process.exit(1);
          return;
        }
        console.log(`Importing ChatGPT conversations from ${filePath} …`);

        let result: ReturnType<typeof chatgptImportFile>;
        try {
          result = chatgptImportFile(filePath, (conv, { inserted, messageCount }) => {
            spinner.clear();
            const title = (conv.title ?? conv.id).slice(0, 60);
            if (inserted) {
              process.stdout.write(
                `  ${chalk.green('✔')} ${title}  →  ${chalk.green(messageCount + ' messages')} (inserted)\n`
              );
            } else {
              process.stdout.write(
                `  ${chalk.yellow('–')} ${title}  →  ${chalk.yellow('skipped, already imported')}\n`
              );
            }
            spinner.render();
          }, forceOpts);
        } catch (err) {
          spinner.fail(`Failed to import: ${(err as Error).message}`);
          process.exit(1);
          return;
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        if (result.unchanged) {
          spinner.succeed(`File unchanged (cached). Time: ${elapsed}s`);
        } else {
          spinner.succeed(
            `Done. ${result.inserted} sessions inserted, ${result.skipped} skipped  |  Total messages: ${result.messages}  |  Time: ${elapsed}s`
          );
        }
        break;
      }

      case 'codex': {
        const basePath = options.path ?? codexDefaultBasePath();
        console.log(`Importing Codex sessions from ${basePath} …`);

        let result: ReturnType<typeof codexImportAll>;
        try {
          result = codexImportAll(basePath, (filePath, { inserted, messageCount, unchanged }) => {
            spinner.clear();
            const fileName = filePath.split('/').pop() ?? filePath;
            if (unchanged) {
              process.stdout.write(
                `  ${chalk.dim('–')} ${fileName}  →  ${chalk.dim('unchanged (cached)')}\n`
              );
            } else if (inserted) {
              process.stdout.write(
                `  ${chalk.green('✔')} ${fileName}  →  ${chalk.green(messageCount + ' messages')} (inserted)\n`
              );
            } else {
              process.stdout.write(
                `  ${chalk.yellow('–')} ${fileName}  →  ${chalk.yellow('skipped, already imported')}\n`
              );
            }
            spinner.render();
          }, forceOpts);
        } catch (err) {
          spinner.fail(`Failed to import: ${(err as Error).message}`);
          process.exit(1);
          return;
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        spinner.succeed(
          `Done. Sessions imported: ${result.inserted} new, ${result.skipped} skipped  |  Total messages: ${result.messages}  |  Time: ${elapsed}s`
        );
        break;
      }

      default:
        spinner.stop();
        console.error(chalk.red(`Unknown source: ${source}. Supported: claude-code | openclaw | codex | chatgpt`));
        process.exit(1);
    }
  });
