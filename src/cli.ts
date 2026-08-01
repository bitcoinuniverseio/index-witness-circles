import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AdminCommandService } from './api/admin-command.service';
import { AppModule } from './app.module';

function integer(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new Error(`${label} must be a nonnegative integer`);
  return parsed;
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

async function main(): Promise<void> {
  process.env.WITNESS_CLI = 'true';
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const commands = app.get(AdminCommandService);
    const [command = 'verify', first, second] = process.argv.slice(2);
    let result: unknown;
    switch (command) {
      case 'verify':
        result = await commands.verify();
        break;
      case 'verify-core':
        result = await commands.verifyCore(
          integer(first, 'fromHeight'),
          integer(second, 'toHeight'),
        );
        break;
      case 'repair':
        result = await commands.repair();
        break;
      case 'sync':
        result = await commands.sync();
        break;
      case 'reindex':
        result = await commands.reindex(integer(first, 'fromHeight'));
        break;
      case 'reindex-range': {
        const from = integer(first, 'fromHeight');
        const to = integer(second, 'toHeight');
        if (from === undefined || to === undefined)
          throw new Error('reindex-range requires two heights');
        result = await commands.reindexRange(from, to);
        break;
      }
      default:
        throw new Error(
          'Command must be verify, verify-core, repair, sync, reindex, or reindex-range',
        );
    }
    process.stdout.write(`${JSON.stringify(result, jsonReplacer, 2)}\n`);
  } finally {
    await app.close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
