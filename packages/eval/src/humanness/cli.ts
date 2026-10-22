import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AGENT_VERSION, configureModelProvider } from '@matchbot/agent';
import { createRepositories, disconnectPrisma, getPrisma } from '@matchbot/db';
import { envSchema } from '@matchbot/shared';
import { exportRound } from './export.js';
import { freezeCase } from './freeze.js';
import { createJudgeClient, judgeRound } from './judge.js';
import { renderComparison, roundMetrics, targetsMet } from './metrics.js';
import { replayCase } from './replay.js';
import { caseFixtureSchema, judgeReportSchema, roundSchema, type Round } from './schema.js';

/**
 * `pnpm humanness <export|metrics|judge|freeze|replay|compare> ...` — see docs/testing/humanness.md.
 * Rounds and cases live under packages/eval/fixtures/humanness/ (git-ignored: they hold group text).
 */
const out = (line: string) => process.stdout.write(line + '\n');
const ROOT = fileURLToPath(new URL('../../fixtures/humanness/', import.meta.url));
const roundPath = (name: string) => ROOT + 'rounds/' + name + '.json';
const judgePath = (name: string) => ROOT + 'rounds/' + name + '.judge.json';
const caseDir = (round: string) => ROOT + 'cases/' + round + '/';

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
function readRound(name: string): Round {
  const path = roundPath(name);
  if (!existsSync(path)) throw new Error('round_missing: ' + path);
  return roundSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}
function writeJson(path: string, value: unknown): void {
  mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}
function env() {
  return envSchema.parse({
    ...process.env,
    DATABASE_URL:
      process.env.DATABASE_URL ?? 'postgresql://matchbot:matchbot@localhost:5432/matchbot',
    REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
    JEV_API_KEY: process.env.JEV_API_KEY ?? '',
    JEV_POLICY: 'off',
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? 'unused',
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN ?? 'unused',
    TELEGRAM_OPS_CHAT_ID: process.env.TELEGRAM_OPS_CHAT_ID ?? 'unused',
  });
}
function printMetrics(rounds: Round[]): void {
  const rows = rounds.map((r) => {
    const m = roundMetrics(r);
    return { label: r.name, bot: m.bot, humans: m.humans };
  });
  out(renderComparison(rows));
  for (const r of rounds) {
    const checks = targetsMet(roundMetrics(r).bot);
    const failed = checks.filter((c) => !c.ok);
    out(
      `\n${r.name}: ${checks.length - failed.length}/${checks.length} targets met` +
        (failed.length
          ? '; missed ' +
            failed.map((c) => `${c.metric} ${c.value} (target ${c.target})`).join(', ')
          : ''),
    );
  }
}

const command = process.argv[2] ?? '';
try {
  switch (command) {
    case 'export': {
      const since = new Date(arg('--since') ?? Date.now() - 86_400_000);
      const until = new Date(arg('--until') ?? Date.now());
      const name = arg('--name') ?? since.toISOString().slice(0, 16).replace(/[-:T]/g, '');
      const prisma = getPrisma(env().DATABASE_URL);
      try {
        const round = await exportRound({
          prisma,
          name,
          since,
          until,
          agentVersion: AGENT_VERSION,
        });
        writeJson(roundPath(name), round);
        out(
          `exported ${round.cases.length} replies and ${round.humans.length} member lines (${round.humans.filter((h) => h.replyLike).length} reply-like) → ${roundPath(name)}`,
        );
        printMetrics([round]);
      } finally {
        await disconnectPrisma();
      }
      break;
    }
    case 'metrics': {
      const names = process.argv.slice(3).filter((a) => !a.startsWith('--'));
      if (!names.length) throw new Error('usage: humanness metrics <round> [round...]');
      const rounds = names.map(readRound);
      printMetrics(rounds);
      if (process.argv.includes('--per-case'))
        for (const r of rounds) for (const row of roundMetrics(r).perCase) out(JSON.stringify(row));
      break;
    }
    case 'compare': {
      const [a, b] = process.argv.slice(3);
      if (!a || !b) throw new Error('usage: humanness compare <roundA> <roundB>');
      printMetrics([readRound(a), readRound(b)]);
      break;
    }
    case 'judge': {
      const name = process.argv[3];
      if (!name) throw new Error('usage: humanness judge <round> [--seed n] [--model id]');
      const baseUrl = process.env.OPENAIROUTER_BASE_URL;
      const apiKey = process.env.OPENAIROUTER_API_KEY;
      if (!baseUrl || !apiKey)
        throw new Error(
          'judge needs OPENAIROUTER_BASE_URL and OPENAIROUTER_API_KEY in the environment',
        );
      const model = arg('--model') ?? process.env.JUDGE_MODEL ?? 'gpt-6.1-sol';
      const round = readRound(name);
      const report = await judgeRound({
        round,
        client: createJudgeClient({ baseUrl, apiKey, model }),
        ...(arg('--seed') ? { seed: Number(arg('--seed')) } : {}),
      });
      writeJson(judgePath(name), judgeReportSchema.parse(report));
      out(
        `judge ${model}: blind accuracy ${report.blind.accuracy} (n=${report.blind.n}, AUC ${report.blind.auc}, bot mean ${report.blind.botMeanProbability}, human mean ${report.blind.humanMeanProbability}); mean score ${report.meanScore}/5 → ${judgePath(name)}`,
      );
      for (const r of report.ratings) out(`  ${r.id} ${r.score}/5 ${r.mainIssue} — ${r.reason}`);
      break;
    }
    case 'freeze': {
      const name = process.argv[3];
      if (!name) throw new Error('usage: humanness freeze <round>');
      const snapshotKey = process.env.SNAPSHOT_KEY;
      if (!snapshotKey) throw new Error("freeze needs SNAPSHOT_KEY (the worker's checkpoint key)");
      const round = readRound(name);
      const prisma = getPrisma(env().DATABASE_URL);
      try {
        const repos = createRepositories(prisma);
        let frozen = 0;
        for (const c of round.cases) {
          const result = await freezeCase({ repos, prisma, snapshotKey, round, caseId: c.id });
          if ('skipped' in result) {
            out(`skip ${c.id}: ${result.skipped}`);
            continue;
          }
          writeJson(caseDir(name) + c.id + '.json', caseFixtureSchema.parse(result));
          frozen++;
        }
        out(`froze ${frozen}/${round.cases.length} cases → ${caseDir(name)}`);
      } finally {
        await disconnectPrisma();
      }
      break;
    }
    case 'replay': {
      const name = process.argv[3];
      if (!name)
        throw new Error('usage: humanness replay <round> [--as newRound] [--n 1] [--only caseId]');
      const n = Number(arg('--n', '1'));
      const only = arg('--only');
      const as = arg('--as') ?? name + '-replay';
      const dir = caseDir(name);
      if (!existsSync(dir))
        throw new Error('no frozen cases: run `humanness freeze ' + name + '` first');
      const source = readRound(name);
      const e = env();
      configureModelProvider(e, []);
      const prisma = getPrisma(e.DATABASE_URL);
      try {
        const repos = createRepositories(prisma);
        const cases = [];
        let tokens = 0;
        for (const file of readdirSync(dir)
          .filter((f) => f.endsWith('.json'))
          .sort()) {
          const fixture = caseFixtureSchema.parse(JSON.parse(readFileSync(dir + file, 'utf8')));
          if (only && fixture.id !== only) continue;
          for (let k = 0; k < n; k++) {
            const row = await replayCase({ env: e, repos, fixture });
            cases.push({ ...row, id: n > 1 ? `${row.id}#${k + 1}` : row.id });
            tokens += row.modelTokens;
            out(
              `${row.id}${n > 1 ? '#' + (k + 1) : ''} ${row.outcome} ${row.elapsedMs}ms rejected=${row.rejectedDrafts} tokens=${row.modelTokens}\n  ${row.line}${row.card ? '\n  [card ' + row.card.length + ' chars, ' + row.links.length + ' links]' : ''}`,
            );
          }
        }
        const round: Round = {
          version: 1,
          name: as,
          generatedAt: new Date().toISOString(),
          source: 'replay',
          agentVersion: AGENT_VERSION,
          window: source.window,
          cases,
          humans: source.humans,
        };
        writeJson(roundPath(as), round);
        out(`\nwrote ${roundPath(as)} (${tokens} model tokens)`);
        printMetrics([source, round]);
      } finally {
        await disconnectPrisma();
      }
      break;
    }
    default:
      throw new Error('usage: humanness <export|metrics|compare|judge|freeze|replay>');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
