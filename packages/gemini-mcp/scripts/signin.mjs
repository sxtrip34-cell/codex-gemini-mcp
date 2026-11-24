// One-time sign-in: opens the gemini-mcp Chrome profile in a visible window on gemini.google.com.
// Sign in with your Google account there; afterwards the server runs the same profile headless.
import readline from 'node:readline';
import { closeChrome, launchChrome, PROFILE_DIR } from '../browser.mjs';

await launchChrome({ headless: false });
console.log(`A Chrome window opened on gemini.google.com (profile: ${PROFILE_DIR}).`);
console.log('Sign in with the Google account you want gemini-mcp to use, then come back here.');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await new Promise((resolve) => rl.question('Press Enter when you are signed in… ', resolve));
rl.close();
await closeChrome();
console.log('Done. gemini-mcp will use this sign-in from now on (headless, no window).');
process.exit(0);
