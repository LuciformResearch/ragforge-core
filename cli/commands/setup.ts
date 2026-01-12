/**
 * Implements the `ragforge setup` command.
 *
 * Responsibilities:
 * - Check/install Docker
 * - Setup Neo4j container
 * - Configure environment
 */

import { writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { DockerManager } from '@luciformresearch/ragforge';

export interface SetupOptions {
  force: boolean;
  password?: string;
  skipNeo4j: boolean;
}

export function printSetupHelp(): void {
  console.log(`Usage:
  ragforge setup [options]

Description:
  Setup RagForge environment: check Docker, create Neo4j container, configure .env

Options:
  --force               Force recreate Neo4j container (removes existing)
  --password <pwd>      Neo4j password (default: ragforge)
  --skip-neo4j          Only check Docker, don't setup Neo4j
  -h, --help            Show this help

Examples:
  # Full setup (check Docker + Neo4j)
  ragforge setup

  # Custom Neo4j password
  ragforge setup --password mySecurePassword

  # Force recreate container
  ragforge setup --force

  # Only verify Docker is installed
  ragforge setup --skip-neo4j
`);
}

export function parseSetupOptions(args: string[]): SetupOptions {
  const options: SetupOptions = {
    force: false,
    skipNeo4j: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    switch (arg) {
      case '--force':
        options.force = true;
        break;
      case '--password':
        options.password = args[++i];
        break;
      case '--skip-neo4j':
        options.skipNeo4j = true;
        break;
      case '-h':
      case '--help':
        printSetupHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option for setup command: ${arg}`);
    }
  }

  return options;
}

export async function runSetup(options: SetupOptions): Promise<void> {
  const docker = new DockerManager();

  console.log('🔧  RagForge Setup\n');

  // Step 1: Check Docker
  console.log('📦  Checking Docker...');
  const dockerStatus = await docker.checkDocker();

  if (!dockerStatus.installed) {
    console.log('❌  Docker is not installed.\n');
    console.log(docker.getDockerInstallInstructions());
    console.log('\nAfter installing Docker, run `ragforge setup` again.');
    process.exit(1);
  }

  if (!dockerStatus.running) {
    console.log('⚠️  Docker is installed but not running.');
    console.log('   Please start Docker Desktop (or the Docker daemon) and run `ragforge setup` again.');
    process.exit(1);
  }

  console.log(`✅  Docker ${dockerStatus.version}`);

  if (options.skipNeo4j) {
    console.log('\n✨  Docker is ready. Skipping Neo4j setup (--skip-neo4j).');
    return;
  }

  // Step 2: Check/Setup Neo4j
  console.log('\n📊  Checking Neo4j...');
  const neo4jStatus = await docker.checkNeo4j();

  if (neo4jStatus.containerExists && options.force) {
    console.log('🗑️  Removing existing Neo4j container (--force)...');
    await docker.removeNeo4jContainer();
  }

  if (!neo4jStatus.containerExists || options.force) {
    console.log('📥  Pulling Neo4j image...');
    await docker.pullNeo4jImage((msg) => {
      // Show pull progress
      if (msg.includes('Pulling') || msg.includes('Download') || msg.includes('Extract')) {
        process.stdout.write(`   ${msg}\r`);
      }
    });
    console.log('');

    const password = options.password || 'ragforge';
    console.log('🚀  Creating Neo4j container...');
    await docker.createNeo4jContainer(password);

    console.log('⏳  Waiting for Neo4j to start...');
    const ready = await docker.waitForNeo4jReady(60, 2000);

    if (!ready) {
      console.log('❌  Neo4j failed to start within timeout.');
      console.log('   Check logs with: docker logs ragforge-neo4j');
      process.exit(1);
    }

    console.log('✅  Neo4j is ready!');

    // Step 3: Create/update .env file
    const envPath = join(process.cwd(), '.env');
    const connectionInfo = docker.getNeo4jConnectionInfo();

    const envContent = `# RagForge Neo4j Configuration
NEO4J_URI=${connectionInfo.boltUrl}
NEO4J_USERNAME=${connectionInfo.username}
NEO4J_PASSWORD=${options.password || connectionInfo.password}

# Add your Gemini API key for embeddings
# GEMINI_API_KEY=your_key_here
`;

    if (existsSync(envPath)) {
      const existing = readFileSync(envPath, 'utf-8');
      if (!existing.includes('NEO4J_URI')) {
        // Append Neo4j config
        writeFileSync(envPath, existing + '\n' + envContent);
        console.log(`\n📝  Added Neo4j config to ${envPath}`);
      } else {
        console.log(`\n⚠️  .env already has NEO4J_URI. Update manually if needed.`);
      }
    } else {
      writeFileSync(envPath, envContent);
      console.log(`\n📝  Created ${envPath}`);
    }
  } else if (neo4jStatus.running) {
    console.log('✅  Neo4j is already running');
    console.log(`   Bolt URL: ${neo4jStatus.boltUrl}`);
  } else {
    console.log('🔄  Starting existing Neo4j container...');
    await docker.startNeo4j();

    console.log('⏳  Waiting for Neo4j to start...');
    const ready = await docker.waitForNeo4jReady(30, 2000);

    if (!ready) {
      console.log('❌  Neo4j failed to start.');
      process.exit(1);
    }

    console.log('✅  Neo4j started!');
  }

  // Final summary
  const info = docker.getNeo4jConnectionInfo();
  console.log(`
✨  Setup complete!

Neo4j Connection:
  URI:      ${info.boltUrl}
  Username: ${info.username}
  Password: ${info.password}

Browser UI: http://localhost:7474

Next steps:
  1. Add GEMINI_API_KEY to .env (for embeddings)
  2. Run: ragforge daemon
  3. Or use: ragforge init --auto-detect-fields

Useful commands:
  ragforge setup --force    Recreate Neo4j container
  docker logs ragforge-neo4j    View Neo4j logs
  docker stop ragforge-neo4j    Stop Neo4j
  docker start ragforge-neo4j   Start Neo4j
`);
}
