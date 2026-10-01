// Hard Node version requirement for the workspace runtime.
// Imported by hook utilities and every script entry point so a workspace
// running on too-old Node fails fast with a clear message instead of
// later, deeper, with cryptic syntax/feature errors.

const REQUIRED_MAJOR = 20;
const REQUIRED_MINOR = 9;

const [major, minor] = process.versions.node.split('.').map(Number);

if (major < REQUIRED_MAJOR || (major === REQUIRED_MAJOR && minor < REQUIRED_MINOR)) {
  console.error(`This workspace requires Node.js ${REQUIRED_MAJOR}.${REQUIRED_MINOR} or later.`);
  console.error(`  You have:  ${process.versions.node}`);
  console.error(`  Required:  >=${REQUIRED_MAJOR}.${REQUIRED_MINOR}.0`);
  console.error(`  Install a newer Node via nvm, fnm, or https://nodejs.org`);
  process.exit(1);
}
